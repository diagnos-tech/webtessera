// Copyright 2025 The Tessera authors. All Rights Reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from tessera/internal/witness/witness.go @ 4a6d9f9
//
// Port note: `otel.go`'s metrics (witnessReqsTotal/witnessReqHistogram/witnessRespsTotal)
// and every `metric.WithAttributes`/`.Add`/`.Record` call site they feed, plus klog request
// logging, are dropped -- see docs/decisions/0070-witness-and-migrate-drop-otel-and-klog.md, which
// extends the precedent docs/decisions/0051-storage-internal-drops-otel-and-klog.md set
// for storage/internal to this package. `net/http`'s `*http.Client` becomes `FetchFn` (the
// same stand-in `client/fetcher.ts` already uses for `*http.Client`).

// Package witness contains the implementation for sending out a checkpoint to witnesses
// and retrieving sufficient signatures to satisfy a policy.

import { type FetchFn, type omitCredentials, readAllLimited } from "../../client/fetcher.ts";
import { newProofBuilder, type ProofBuilder, type TileFetcherFunc } from "../../client/index.ts";
import { type Note, open, type Verifier, verifierList } from "../../vendor/note/note.ts";
import { concatBytes, fromUTF8, toBase64, toUTF8 } from "../gostd/bytes.ts";
import { JoinError, joinErrors, SentinelError } from "../gostd/errors.ts";
import { parseUint, quote } from "../gostd/strconv.ts";
import { trimSpace } from "../gostd/strings.ts";
import { checkpointUnsafe } from "../parse/parse.ts";

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export const ErrPolicyNotSatisfied = new SentinelError("witness policy was not satisfied");

/**
 * WitnessGroup defines a group of witnesses, and a threshold of
 * signatures that must be met for this group to be satisfied.
 * Witnesses within a group should be fungible, e.g. all of the Armored
 * Witness devices form a logical group, and N should be picked to
 * represent a threshold of the quorum. For some users this will be a
 * simple majority, but other strategies are available.
 * N must be <= len(WitnessKeys).
 *
 * Port note: this is an interface (Go: `interface`), structurally satisfied by
 * `src/witness.ts`'s `WitnessGroup` class -- exactly how Go's implicit interface
 * satisfaction lets `tessera.WitnessGroup` (a struct) be passed wherever this interface
 * is expected, without either file importing the other's concrete type for that purpose.
 */
export interface WitnessGroup {
	/**
	 * satisfied returns true if the checkpoint provided is signed by this witness.
	 * This will return false if there is no signature, and also if the
	 * checkpoint cannot be read as a valid note. It is up to the caller to ensure
	 * that the input value represents a valid note.
	 */
	satisfied(cp: Uint8Array): boolean;

	/**
	 * endpoints returns the details required for updating a witness and checking the
	 * response. The returned result is a map from the URL that should be used to update
	 * the witness with a new checkpoint, to the value which is the verifier to check
	 * the response is well formed.
	 */
	endpoints(): Map<string, Verifier>;
}

/**
 * newWitnessGateway returns a WitnessGateway that will send out new checkpoints to witnesses
 * in the group, and will ensure that the policy is satisfied before returning. All outbound
 * requests will be done using the given client. The tile fetcher is used for constructing
 * consistency proofs for the witnesses.
 */
export function newWitnessGateway(
	group: WitnessGroup,
	c: FetchFn,
	oldSize: bigint,
	fetchTiles: TileFetcherFunc,
): WitnessGateway {
	const endpoints = group.endpoints();
	const witnesses: witness[] = [];
	for (const [u, v] of endpoints) {
		witnesses.push(new witness(c, u, v, oldSize));
	}
	return new WitnessGateway(group, witnesses, fetchTiles);
}

/**
 * sigOrErr is what each in-flight witness update settles to.
 *
 * Port note: stands in for Go's local `sigOrErr` struct sent down the `results` channel
 * inside `WitnessGateway.Witness`.
 */
interface sigOrErr {
	readonly sig?: Uint8Array;
	readonly err?: unknown;
}

/** WitnessGateway allows a log implementation to send out a checkpoint to witnesses. */
export class WitnessGateway {
	readonly #group: WitnessGroup;
	readonly #witnesses: witness[];
	readonly #fetchTile: TileFetcherFunc;

	/** @internal Stands in for Go's `WitnessGateway{...}` composite literal; construct via newWitnessGateway. */
	constructor(group: WitnessGroup, witnesses: witness[], fetchTile: TileFetcherFunc) {
		this.#group = group;
		this.#witnesses = witnesses;
		this.#fetchTile = fetchTile;
	}

	/**
	 * witness sends out a new checkpoint (which must be signed by the log), to all witnesses
	 * and returns the checkpoint as soon as the policy the WitnessGateway was constructed with
	 * is Satisfied.
	 */
	async witness(cp: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
		if (this.#witnesses.length === 0) {
			return cp;
		}

		// Port note: `ctx, cancel := context.WithCancel(ctx); defer cancel()`. The
		// AbortController is aborted in `finally` below no matter how this method
		// returns, cancelling any witness update still in flight, exactly as Go's
		// deferred cancel does.
		const controller = new AbortController();
		const innerSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
		try {
			let size: bigint;
			try {
				size = checkpointUnsafe(cp).size;
			} catch (err) {
				throw new Error(`failed to parse checkpoint from log: ${errText(err)}`);
			}
			let pb: ProofBuilder;
			try {
				pb = await newProofBuilder(size, this.#fetchTile);
			} catch (err) {
				throw new Error(`failed to build proof builder: ${errText(err)}`);
			}
			const pf = new sharedConsistencyProofFetcher(pb, size);

			// Kick off a goroutine for each witness and send result to results chan
			//
			// Port note: each update settles to a {sig, err} pair rather than rejecting,
			// mirroring Go's `sigOrErr` values sent down the `results` channel. Go fans
			// the per-witness goroutines into an unbuffered
			// `results` channel and ranges over it, consuming responses in arrival
			// order and returning as soon as the policy is satisfied. Any goroutine
			// still running at that point blocks forever trying to send into a
			// channel nobody drains again -- a benign leak Go's runtime never
			// reclaims, since the goroutine is still reachable (it is running).
			// Promises have no equivalent blocking-send hazard: an abandoned
			// `.then`-chain simply keeps running and its result is dropped when
			// nothing awaits it, so racing them below reproduces "stop consuming the
			// moment the policy is satisfied" without leaking anything. See
			// docs/decisions/0072-witness-gateway-promise-racing.md.
			let pending: Promise<sigOrErr>[] = this.#witnesses.map((w) =>
				w
					.update(cp, size, (from, to, sig) => pf.consistencyProof(from, to, sig), innerSignal)
					.then(
						(sig): sigOrErr => ({ sig }),
						(err: unknown): sigOrErr => ({ err }),
					),
			);

			// Consume the results coming back from each witness
			const witnessErrors: unknown[] = [];
			let sigBlock = cp;
			while (pending.length > 0) {
				const { value: r, index } = await raceWithIndex(pending);
				pending = pending.filter((_, i) => i !== index);

				if (r.err !== undefined) {
					witnessErrors.push(r.err);
					continue;
				}
				const sig = r.sig as Uint8Array;
				// Some basic validation, which can be extended if needed.
				if (!(sig.length > 0 && sig[sig.length - 1] === 0x0a)) {
					witnessErrors.push(new Error(`invalid signature from witness: ${quote(fromUTF8(sig))}`));
					continue;
				}
				// Add new signature to the new note we're building
				sigBlock = concatBytes(sigBlock, sig);

				// See whether the group is satisfied now
				if (this.#group.satisfied(sigBlock)) {
					return sigBlock;
				}
			}

			// We can only get here if all witnesses have returned and we're still not satisfied.
			throw new PolicyNotSatisfiedError(sigBlock, witnessErrors);
		} finally {
			controller.abort();
		}
	}
}

/**
 * PolicyNotSatisfiedError is thrown when not enough witnesses cosigned to satisfy the
 * group's policy.
 *
 * Port note: Go returns `(sigBlock.Bytes(), errors.Join(ErrPolicyNotSatisfied, err))` --
 * both a partial result and an error (docs/decisions/0004-errors-context-and-concurrency.md's
 * "Consequences" section flags this loss generally). The error half is the same join here:
 * this class is a JoinError of ErrPolicyNotSatisfied and the joined witness errors, so
 * `errorIs(e, ErrPolicyNotSatisfied)`, or `errorIs` for any one witness's error, finds it
 * as `errors.Is` does, and its message is the one `errors.Join` builds. `checkpoint`
 * carries the value half: the under-signed checkpoint accumulated so far; `witnessErrors`
 * lists the witness errors on their own. See
 * docs/decisions/0075-policy-not-satisfied-error-carries-checkpoint.md.
 */
export class PolicyNotSatisfiedError extends JoinError {
	readonly checkpoint: Uint8Array;
	readonly witnessErrors: readonly unknown[];

	constructor(checkpoint: Uint8Array, witnessErrors: readonly unknown[]) {
		const err = joinErrors(witnessErrors);
		super(err === undefined ? [ErrPolicyNotSatisfied] : [ErrPolicyNotSatisfied, err]);
		this.name = "PolicyNotSatisfiedError";
		this.checkpoint = checkpoint;
		this.witnessErrors = witnessErrors;
	}
}

/**
 * raceWithIndex resolves as soon as any of the given promises does, returning both its
 * value and its position in the array -- the bookkeeping `WitnessGateway.witness` needs to
 * remove exactly that settled entry from its own still-pending list.
 *
 * This has no Go counterpart; it is the mechanism the port note on `witness.witness`
 * above uses in place of the `results` channel.
 */
function raceWithIndex<T>(promises: readonly Promise<T>[]): Promise<{ value: T; index: number }> {
	return Promise.race(promises.map((p, index) => p.then((value) => ({ value, index }))));
}

/**
 * consistencyFuture is a function which returns a memoized consistency proof result.
 *
 * Port note: Go's `sync.OnceValues(func() ([][]byte, error) { ... })` returns exactly this
 * shape -- a niladic function that, however many times it is called, runs its underlying
 * function at most once and always returns that one call's result. A `Promise` already has
 * that "run once, every observer sees the same outcome" property built in, so
 * `sharedConsistencyProofFetcher` below stores the `Promise` itself rather than a
 * `consistencyFuture` wrapper around it.
 */
// biome-ignore lint/correctness/noUnusedVariables: kept to document the upstream type; see the port note above.
type consistencyFuture = () => Promise<Uint8Array[]>;

/**
 * sharedConsistencyProofFetcher is a thread-safe caching wrapper around a proof builder.
 * This is an optimization for the common case where multiple witnesses are used, and all
 * of the witnesses are of the same size, and thus require the same proof.
 */
class sharedConsistencyProofFetcher {
	readonly #pb: ProofBuilder;
	readonly #toSize: bigint;
	readonly #results = new Map<bigint, Promise<Uint8Array[]>>();

	constructor(pb: ProofBuilder, toSize: bigint) {
		this.#pb = pb;
		this.#toSize = toSize;
	}

	/**
	 * consistencyProof constructs a consistency proof, reusing any results from parallel requests.
	 *
	 * Port note: Go guards the check-and-populate of `results` with a `sync.Mutex` because
	 * it runs from multiple goroutines. Here the same check-and-populate is a single
	 * synchronous block containing no `await`, so no lock is needed -- ADR-0004's rule for
	 * dropping a Go mutex whose critical section stays synchronous in TypeScript. What
	 * makes this safe is starting the fetch (and caching its Promise) *before* any `await`
	 * runs, so two calls for the same `smaller` arriving "concurrently" (interleaved via
	 * `Promise.all`/`Promise.race`, never truly in parallel -- JavaScript is
	 * single-threaded) can never both observe a cache miss.
	 */
	consistencyProof(smaller: bigint, larger: bigint, signal?: AbortSignal): Promise<Uint8Array[]> {
		if (larger !== this.#toSize) {
			return Promise.reject(new Error(`required larger size to be ${this.#toSize} but was given ${larger}`));
		}
		let f = this.#results.get(smaller);
		if (f === undefined) {
			f = this.#pb.consistencyProof(smaller, larger, signal);
			this.#results.set(smaller, f);
		}
		return f;
	}
}

/**
 * maxWitnessResponseBytes caps a witness's response body.
 *
 * Port note: hardening with no Go counterpart, where io.ReadAll reads whatever the
 * witness sends. A reply is a few signature lines, or a decimal tree size. See
 * docs/decisions/0195-response-size-caps.md.
 */
const maxWitnessResponseBytes = 16 << 10;

/**
 * maxStaleSizeRetries caps how many times one update retries after a witness replies
 * that the size it was sent is stale.
 *
 * Port note: hardening with no Go counterpart, where the retries go on until the
 * context is done — the cap upstream's own comment on the retry contemplates. See
 * docs/decisions/0198-witness-stale-size-retry-cap.md.
 */
const maxStaleSizeRetries = 3;

/**
 * witness is the log's model of a witness's view of this log.
 * It has a URL which is the address to which updates to this log's state can be posted to the witness,
 * using the https://github.com/C2SP/C2SP/blob/main/tlog-witness.md spec.
 * It also has the size of the checkpoint that the log thinks that the witness last signed.
 * This is important for sending update proofs.
 * This is defaulted to zero on startup and calibrated after the first request, which is expected by the spec:
 * `If a client doesn't have information on the latest cosigned checkpoint, it MAY initially make a request with a old size of zero to obtain it`
 *
 * Port note: this class and `WitnessGateway`'s own `witness` method (Go: `Witness`) are
 * named identically apart from case, exactly as they are in witness.go -- Go's exported
 * `Witness` method and unexported `witness` struct are distinct identifiers only by
 * case, which ADR-0002's camelCase-for-exported-functions mapping reproduces verbatim
 * here. They occupy different scopes (an instance method vs. a module-level class) so
 * TypeScript accepts it without collision, if a little confusingly to a first-time reader.
 */
class witness {
	readonly #c: FetchFn;
	readonly #url: string;
	readonly #verifier: Verifier;
	#size: bigint;

	constructor(c: FetchFn, url: string, verifier: Verifier, size: bigint) {
		this.#c = c;
		this.#url = url;
		this.#verifier = verifier;
		this.#size = size;
	}

	/**
	 * Port note: `staleRetries` has no Go counterpart; it counts the retries this update
	 * has already made after a stale-size reply (see maxStaleSizeRetries).
	 */
	async update(
		cp: Uint8Array,
		size: bigint,
		fetchProof: (from: bigint, to: bigint, signal?: AbortSignal) => Promise<Uint8Array[]>,
		signal?: AbortSignal,
		staleRetries = 0,
	): Promise<Uint8Array> {
		let proof: Uint8Array[] = [];
		if (this.#size > 0n) {
			try {
				proof = await fetchProof(this.#size, size, signal);
			} catch (err) {
				throw new Error(`fetchProof: ${errText(err)}`);
			}
		}

		// The request body MUST be a sequence of
		// - a previous size line,
		// - zero or more consistency proof lines,
		// - and an empty line,
		// - followed by a [checkpoint][].
		let bodyText = `old ${this.#size}\n`;
		for (const p of proof) {
			bodyText += `${toBase64(p)}\n`;
		}
		bodyText += "\n";
		const body = concatBytes(toUTF8(bodyText), cp);

		// Port note: Go's http.NewRequestWithContext fails only when the URL does not
		// parse; `fetch` would report that as a failure to post, so the URL is parsed
		// first to report it the way Go does.
		try {
			new URL(this.#url);
		} catch (err) {
			throw new Error(`failed to construct request to ${quote(this.#url)}: ${errText(err)}`);
		}
		let httpResp: Response;
		try {
			// Port note: TypeScript's DOM lib types `BodyInit` such that a plain
			// `Uint8Array` is not directly assignable (a known lib-typing friction,
			// not a runtime concern -- `fetch` accepts any `ArrayBufferView` at
			// runtime, and `Uint8Array` is one).
			//
			// Port note: hardening with no Go counterpart: credentials are omitted, so a
			// browser never attaches its cookies for the witness's origin, and a redirect
			// is never followed (Go's client follows it); see below and
			// docs/decisions/0197-fetch-credentials-and-redirects.md. "manual", not "error",
			// because workerd rejects the latter.
			const init: omitCredentials = { method: "POST", body: body as BodyInit, credentials: "omit", redirect: "manual" };
			if (signal !== undefined) {
				init.signal = signal;
			}
			// Port note: called through a local so that `fetch` has no receiver; browsers and
			// workerd reject the global `fetch` invoked as a method of another object with
			// "Illegal invocation". See docs/decisions/0131-httpfetcher-fetch-runtime-fidelity.md.
			const c = this.#c;
			httpResp = await c(this.#url, init);
		} catch (err) {
			throw new Error(`failed to post to witness at ${quote(this.#url)}: ${errText(err)}`);
		}
		// A browser reports a redirect it did not follow as an "opaqueredirect" response
		// with status 0; Node and workerd return the 3xx response itself. (workerd's
		// Response type has no "opaqueredirect" member, hence the widening to string.)
		const respType: string = httpResp.type;
		if (respType === "opaqueredirect" || (httpResp.status >= 300 && httpResp.status < 400)) {
			httpResp.body?.cancel().catch(() => undefined);
			throw new Error(
				`witness at ${quote(this.#url)} replied with a redirect, which is not followed: ${httpResp.status}`,
			);
		}

		let rb: Uint8Array;
		try {
			rb = await readAllLimited(httpResp, maxWitnessResponseBytes);
		} catch (err) {
			throw new Error(`failed to read body from witness at ${quote(this.#url)}: ${errText(err)}`);
		}

		switch (httpResp.status) {
			case 200: {
				// Concatenate the signature to the checkpoint passed in and verify it is valid.
				// append is tempting here but is dangerous because it can modify `cp` and race with other
				// witnesses, causing signatures to be swapped. cp must not be modified.
				//
				// Port note: concatBytes always returns a fresh Uint8Array, never a view of `cp`.
				const signed = concatBytes(cp, rb);
				let n: Note;
				try {
					n = open(signed, verifierList(this.#verifier));
				} catch (err) {
					throw new Error(
						`witness ${quote(this.#verifier.name())} at ${quote(this.#url)} replied with invalid signature: ` +
							`${quote(fromUTF8(rb))}\nconstructed note: ${quote(fromUTF8(signed))}\nerror: ${errText(err)}`,
					);
				}
				const sig = (n.sigs ?? [])[0];
				if (sig === undefined) {
					// Port note: unreachable, as open() returns at least one verified
					// signature or throws; Go indexes `n.Sigs[0]` unguarded.
					throw new Error(
						`witness ${quote(this.#verifier.name())} at ${quote(this.#url)} replied with no verified signature`,
					);
				}
				this.#size = size;
				return toUTF8(`— ${sig.name} ${sig.base64}\n`);
			}
			case 409: {
				// Two cases here: the first is a situation we can recover from, the second isn't.

				// The witness MUST check that the old size matches the size of the latest checkpoint it cosigned
				// for the checkpoint's origin (or zero if it never cosigned a checkpoint for that origin).
				// If it doesn't match, the witness MUST respond with a "409 Conflict" HTTP status code.
				// The response body MUST consist of the tree size of the latest cosigned checkpoint in decimal,
				// followed by a newline (U+000A). The response MUST have a Content-Type of text/x.tlog.size
				const ct = httpResp.headers.get("Content-Type");
				if (ct === "text/x.tlog.size") {
					const bodyStr = trimSpace(fromUTF8(rb));
					let newWitSize: bigint;
					try {
						newWitSize = parseUint(bodyStr, 10, 64);
					} catch {
						throw new Error(
							`witness at ${quote(this.#url)} replied with x.tlog.size but body ${quote(bodyStr)} could not be parsed as decimal`,
						);
					}
					// This should _never_ happen - the witness has a larger tree size than the log knows about!
					if (newWitSize > size) {
						throw new Error(
							`witness at ${quote(this.#url)} replied with x.tlog.size ${newWitSize}, larger than log size ${size}`,
						);
					}

					this.#size = newWitSize;
					// Witnesses could cause this recursion to go on for longer than expected if the value they kept returning
					// this case with slightly larger values. Consider putting a max recursion cap if context timeout isn't enough.
					//
					// Port note: capped at maxStaleSizeRetries; see its doc comment.
					if (staleRetries >= maxStaleSizeRetries) {
						throw new Error(
							`witness at ${quote(this.#url)} replied with a stale x.tlog.size after ${maxStaleSizeRetries} retries, the last ${newWitSize}`,
						);
					}
					return this.update(cp, size, fetchProof, signal, staleRetries + 1);
				}

				// If the old size matches the checkpoint size, the witness MUST check that the root hashes are also identical.
				// If they don't match, the witness MUST respond with a "409 Conflict" HTTP status code.
				throw new Error(
					`witness at ${quote(this.#url)} says old root hash did not match previous for size ${this.#size}: ${httpResp.status}`,
				);
			}
			case 404:
				// If the checkpoint origin is unknown, the witness MUST respond with a "404 Not Found" HTTP status code.
				throw new Error(`witness at ${quote(this.#url)} says checkpoint origin is unknown: ${httpResp.status}`);
			case 403:
				// If none of the signatures verify against a trusted public key, the witness MUST respond with a "403 Forbidden" HTTP status code.
				throw new Error(
					`witness at ${quote(this.#url)} says no signatures verify against trusted public key: ${httpResp.status}`,
				);
			case 400:
				// The old size MUST be equal to or lower than the checkpoint size.
				// Otherwise, the witness MUST respond with a "400 Bad Request" HTTP status code.
				throw new Error(
					`witness at ${quote(this.#url)} says old checkpoint size of ${this.#size} is too large: ${httpResp.status}`,
				);
			case 422:
				//  If the Merkle Consistency Proof doesn't verify, the witness MUST respond with a "422 Unprocessable Entity" HTTP status code.
				throw new Error(`witness at ${quote(this.#url)} says that the consistency proof is bad: ${httpResp.status}`);
			default:
				throw new Error(`got bad status code: ${httpResp.status}`);
		}
	}
}
