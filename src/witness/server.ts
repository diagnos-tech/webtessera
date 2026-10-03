// Copyright 2026 MedDeck LTDA. All Rights Reserved.
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

// This file has no upstream counterpart. It is the server side of the C2SP tlog-witness
// protocol (https://c2sp.org/tlog-witness, v1.0.0), whose client side Tessera's appender
// speaks (src/internal/witness/witness.ts). Its checks follow the spec text, quoted where it
// decides behaviour, in the order the spec states them. See
// docs/decisions/0171-witness-server.md.

import type { CorsOptions } from "../http/cors.ts";
import type { Handler } from "../http/handler.ts";
import { bytesEqual, fromUTF8, indexByte } from "../internal/gostd/bytes.ts";
import { throwIfAborted } from "../internal/gostd/errors.ts";
import { verifyConsistency } from "../vendor/merkle/proof/verify.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import {
	InvalidSignatureError,
	type Note,
	newVerifier,
	open,
	type Signer,
	UnverifiedNoteError,
	type Verifier,
	verifierList,
} from "../vendor/note/note.ts";
import { parseCheckpointBody } from "./checkpoint.ts";
import { checkTimestampsAdvance, cosign } from "./cosign.ts";
import {
	ErrInvalidProof,
	ErrMalformedRequest,
	ErrNoValidSignature,
	ErrRootMismatch,
	ErrUnknownLog,
	echo,
	OldSizeMismatchError,
} from "./errors.ts";
import { DefaultMaxBodyBytes, newWitnessHandler } from "./http.ts";
import { KeySeparation } from "./keycheck.ts";
import { type AddCheckpointRequest, MaxConsistencyProofLines } from "./request.ts";
import { checkpointKey, readLatest, type WitnessStore } from "./state.ts";

/**
 * LogKeys are the public keys a witness trusts to sign a log's checkpoints. Several keys
 * let a log rotate its key: a checkpoint is accepted when any of them signed it.
 */
export interface LogKeys {
	/** verifierKeys are signed-note verifier keys (`<name>+<hash>+<key>`), Ed25519 ones. */
	readonly verifierKeys?: readonly string[];
	/** verifiers are already-constructed verifiers, for any other signature algorithm. */
	readonly verifiers?: readonly Verifier[];
}

/** WitnessedLog is a log the witness is configured with up front. */
export interface WitnessedLog extends LogKeys {
	/** origin is the log's checkpoint origin line, which identifies it. */
	readonly origin: string;
}

/**
 * LogLookup finds the keys of a log the static configuration does not list, or resolves
 * to undefined if the witness should not witness it.
 *
 * It is how one witness serves an open-ended population of logs: a server witnessing the
 * logs its users' browsers keep, one per session, registers each log's verifier key as the
 * session starts (in a database, say) and looks it up here, by origin, when the log's
 * first checkpoint arrives. The witness asks on every request, so a lookup is free to
 * consult a cache, revoke a log, or rotate its keys.
 */
export type LogLookup = (origin: string, signal?: AbortSignal) => Promise<LogKeys | undefined> | LogKeys | undefined;

/**
 * InconsistencyEvidence describes a validly signed checkpoint that the witness refused
 * because it is inconsistent with what it cosigned before: what the spec calls "proof of
 * log misbehavior", which a witness "MAY log".
 */
export interface InconsistencyEvidence {
	readonly origin: string;
	/**
	 * reason is `root-mismatch` for a checkpoint of the latest cosigned size with a
	 * different root (a split view), and `invalid-proof` for a consistency proof that does
	 * not verify.
	 */
	readonly reason: "root-mismatch" | "invalid-proof";
	/** submitted is the checkpoint as it was submitted. */
	readonly submitted: Uint8Array;
	/** latest is the latest checkpoint the witness cosigned for the log. */
	readonly latest: Uint8Array;
	readonly oldSize: bigint;
	readonly proof: readonly Uint8Array[];
}

/** WitnessServerOptions configures newWitnessServer. */
export interface WitnessServerOptions {
	/**
	 * signer makes the witness's cosignatures. Build it with `newSignerForCosignatureV1`
	 * from an Ed25519 signer key; the witness's name is the key's name.
	 */
	readonly signer: Signer;
	/** additionalSigners cosign alongside signer, during a key rotation for example. */
	readonly additionalSigners?: readonly Signer[];

	/** store holds the latest cosigned checkpoint of every log. */
	readonly store: WitnessStore;
	/**
	 * keyPrefix namespaces the witness's objects in store. Defaults to "", which keeps
	 * every object at its monitoring path.
	 */
	readonly keyPrefix?: string;

	/** logs are the logs the witness knows up front. */
	readonly logs?: readonly WitnessedLog[];
	/** lookupLog is asked about origins that logs does not list. */
	readonly lookupLog?: LogLookup;

	/**
	 * prefix is the spec's *submission prefix*, the path `add-checkpoint` is mounted under.
	 * Defaults to `/`.
	 */
	readonly prefix?: string;
	/**
	 * monitoringPrefix is the spec's *monitoring prefix*, under which
	 * `<origin hash>/checkpoint` serves the latest cosigned checkpoint of each log ("A
	 * witness SHOULD serve a recent checkpoint for each log it cosigned"). Defaults to
	 * prefix; `false` turns the endpoint off.
	 */
	readonly monitoringPrefix?: string | false;
	/**
	 * cors lets scripts on other origins call the witness and read its answers, which a log
	 * kept in a browser tab needs: its appender posts checkpoints to the witness
	 * cross-origin. Off by default; `true` allows every origin.
	 */
	readonly cors?: boolean | CorsOptions;
	/**
	 * maxBodyBytes caps add-checkpoint request bodies, and so the checkpoints in them, for
	 * HTTP and programmatic callers alike. Defaults to 16 KiB, as in the Go witness.
	 */
	readonly maxBodyBytes?: number;

	/**
	 * onInconsistency is told about every validly signed checkpoint the witness refused as
	 * inconsistent with its history, before the refusal is sent. Keeping these is how a
	 * witness turns a log's misbehaviour into evidence.
	 */
	readonly onInconsistency?: (evidence: InconsistencyEvidence) => void | Promise<void>;
	/** onError is told about every failure that turns into a 500 response. */
	readonly onError?: (err: unknown, request: Request) => void;
}

/**
 * newWitnessServer returns a witness: a server that cosigns the checkpoints of the logs it
 * trusts, after checking that each is consistent with the last one it cosigned for the same
 * log, as https://c2sp.org/tlog-witness specifies.
 *
 * ```ts
 * const { skey } = generateKey(undefined, "witness.example/w1");
 * const witness = newWitnessServer({
 *   signer: newSignerForCosignatureV1(skey),
 *   store: new MemoryObjectStore(),
 *   logs: [{ origin: "example.com/log", verifierKeys: [logVkey] }],
 * });
 * Deno.serve(combineHandlers(witness.handle));
 * ```
 */
export function newWitnessServer(options: WitnessServerOptions): WitnessServer {
	return new WitnessServer(options);
}

/** WitnessServer is a tlog-witness witness. Construct it with {@link newWitnessServer}. */
export class WitnessServer {
	/**
	 * handle serves `POST <prefix>/add-checkpoint` and, unless disabled,
	 * `GET <monitoring prefix>/<origin hash>/checkpoint`, and resolves to undefined for
	 * every other request. It is a bound function: pass `witness.handle` around freely.
	 */
	readonly handle: Handler;

	readonly #signers: readonly Signer[];
	readonly #store: WitnessStore;
	readonly #keyPrefix: string;
	readonly #logs: ReadonlyMap<string, readonly Verifier[]>;
	readonly #lookupLog: LogLookup | undefined;
	readonly #onInconsistency: WitnessServerOptions["onInconsistency"];
	readonly #maxCheckpointBytes: number;
	readonly #keySeparation: KeySeparation;

	/** @internal Construct via {@link newWitnessServer}. */
	constructor(options: WitnessServerOptions) {
		this.#signers = [options.signer, ...(options.additionalSigners ?? [])];
		this.#store = options.store;
		this.#keyPrefix = options.keyPrefix ?? "";
		this.#lookupLog = options.lookupLog;
		this.#onInconsistency = options.onInconsistency;
		this.#maxCheckpointBytes = options.maxBodyBytes ?? DefaultMaxBodyBytes;
		this.#keySeparation = new KeySeparation(this.#signers);
		const logs = new Map<string, readonly Verifier[]>();
		for (const l of options.logs ?? []) {
			if (logs.has(l.origin)) {
				throw new Error(`log ${echo(l.origin)} is configured twice`);
			}
			const vs = verifiersOf(l.origin, l);
			if (this.#keySeparation.sharesKey(vs)) {
				throw new Error(`log ${echo(l.origin)} is signed with one of the witness's own keys`);
			}
			logs.set(l.origin, vs);
		}
		this.#logs = logs;
		this.handle = newWitnessHandler(this, options);
	}

	/**
	 * addCheckpoint is the add-checkpoint call without HTTP: it verifies the request and,
	 * if every check passes, records the checkpoint as the log's latest and resolves to the
	 * witness's signature lines, the body of the spec's "200 Success".
	 *
	 * Every refusal is an error whose cause is one of this package's sentinels, which map
	 * one-to-one onto the spec's status codes: ErrMalformedRequest (400),
	 * ErrNoValidSignature (403), ErrUnknownLog (404), ErrOldSizeMismatch (409, carried by an
	 * OldSizeMismatchError with the size to retry from), ErrRootMismatch (409) and
	 * ErrInvalidProof (422). Anything else is a failure of the witness itself.
	 */
	async addCheckpoint(req: AddCheckpointRequest, signal?: AbortSignal): Promise<Uint8Array> {
		throwIfAborted(signal);
		const { oldSize, proof, checkpoint: submitted } = req;
		// The HTTP parser enforces these too; programmatic callers get the same limits.
		if (proof.length > MaxConsistencyProofLines) {
			throw malformed(`more than ${MaxConsistencyProofLines} consistency proof lines`);
		}
		if (proof.some((p) => p.length !== hashSize)) {
			throw malformed("every consistency proof hash must be 32 bytes");
		}
		if (submitted.length > this.#maxCheckpointBytes) {
			throw malformed(`checkpoint exceeds ${this.#maxCheckpointBytes} bytes`);
		}

		// The origin line names the keys to verify the note with, so it is read before the
		// note is: it is the text up to the first newline.
		const nl = indexByte(submitted, 0x0a);
		if (nl < 0) {
			throw malformed("checkpoint has no origin line");
		}
		const origin = fromUTF8(submitted.subarray(0, nl));

		// "If the checkpoint origin is unknown, the witness MUST respond with a "404 Not
		// Found" HTTP status code."
		const verifiers = await this.#verifiersFor(origin, signal);
		if (verifiers === undefined) {
			throw new Error(`${ErrUnknownLog.message} ${echo(origin)}`, { cause: ErrUnknownLog });
		}

		// "The witness MUST verify the checkpoint signature against the public key(s) it
		// trusts for the checkpoint origin, and it MUST ignore signatures from unknown keys."
		// open() records signatures from unknown keys as unverified and ignores them; it
		// throws UnverifiedNoteError when no trusted key signed, and InvalidSignatureError
		// when a signature names a trusted key but does not verify -- the two cases the spec
		// answers with "403 Forbidden". Any other failure is a malformed note.
		let n: Note;
		try {
			n = open(submitted, verifierList(...verifiers));
		} catch (err) {
			if (err instanceof UnverifiedNoteError || err instanceof InvalidSignatureError) {
				throw new Error(`${ErrNoValidSignature.message} for ${echo(origin)}`, { cause: ErrNoValidSignature });
			}
			throw malformed("checkpoint is not a valid signed note");
		}
		// The keys were chosen by the origin line, and the signature covers it; parsing the
		// verified text and comparing again keeps the two bound together by construction.
		const cp = parseCheckpointBody(n.text);
		if (cp.origin !== origin) {
			throw malformed("checkpoint origin does not match its origin line");
		}

		// "The old size MUST be equal to or lower than the checkpoint size. Otherwise, the
		// witness MUST respond with a "400 Bad Request" HTTP status code."
		if (oldSize > cp.size) {
			throw malformed(`old size ${oldSize} is larger than the checkpoint size ${cp.size}`);
		}

		// "Note that checking the old size against the latest checkpoint and persisting the
		// new checkpoint must be performed atomically", or two requests racing could roll
		// the log back. The store's lock is that atomicity, per log.
		const key = checkpointKey(this.#keyPrefix, origin);
		return this.#store.lock(
			`witness:${key}`,
			async () => {
				const latest = await readLatest(this.#store, key);

				// "The witness MUST check that the old size matches the size of the latest
				// checkpoint it cosigned for the checkpoint's origin (or zero if it never
				// cosigned a checkpoint for that origin). If it doesn't match, the witness MUST
				// respond with a "409 Conflict" HTTP status code."
				if (oldSize !== latest.size) {
					throw new OldSizeMismatchError(oldSize, latest.size);
				}

				// Required by the spec's editor's draft, and implied by RFC 6962 in any version:
				// "A checkpoint of size zero MUST have the root hash of the empty tree".
				if (cp.size === 0n && !bytesEqual(cp.hash, DefaultHasher.emptyRoot())) {
					throw invalidProof("a checkpoint of size zero must have the root hash of the empty tree");
				}

				if (latest.checkpoint !== undefined && latest.hash !== undefined && cp.size === latest.size) {
					// "If the old size matches the checkpoint size, the witness MUST check that the
					// root hashes are also identical. If they don't match, the witness MUST respond
					// with a "409 Conflict" HTTP status code."
					if (!bytesEqual(cp.hash, latest.hash)) {
						await this.#evidence("root-mismatch", origin, req, latest.checkpoint);
						throw new Error(`${ErrRootMismatch.message} (size ${cp.size})`, { cause: ErrRootMismatch });
					}
					// A tree is consistent with itself by an empty proof, and only by one.
					if (proof.length > 0) {
						throw invalidProof("the proof between two trees of the same size must be empty");
					}
				} else if (oldSize === 0n) {
					// "The proof MUST be empty if the old size is zero."
					if (proof.length > 0) {
						throw invalidProof("the proof must be empty when the old size is zero");
					}
				} else {
					// "The consistency proof lines MUST encode a Merkle Consistency Proof from the
					// old size to the checkpoint size according to [RFC 6962], Section 2.1.2. ...
					// If the Merkle Consistency Proof doesn't verify, the witness MUST respond with
					// a "422 Unprocessable Entity" HTTP status code."
					try {
						verifyConsistency(DefaultHasher, latest.size, cp.size, proof, latest.hash ?? new Uint8Array(0), cp.hash);
					} catch (err) {
						await this.#evidence("invalid-proof", origin, req, latest.checkpoint ?? new Uint8Array(0));
						throw invalidProof(err instanceof Error ? err.message : String(err));
					}
				}

				// "If all the checks above pass, the witness MUST update its record of the
				// latest cosigned checkpoint and respond with a "200 Success" HTTP status code."
				// "The witness MUST persist the new checkpoint before responding."
				const cosigned = cosign(n.text, n.sigs ?? [], this.#signers);
				checkTimestampsAdvance(origin, latest.checkpoint, cosigned.signatures);
				await this.#store.put(key, cosigned.checkpoint);
				return cosigned.signatureLines;
			},
			signal,
		);
	}

	/**
	 * latestCheckpoint returns the latest checkpoint the witness cosigned for the log with
	 * the given origin, with the log's signatures and the witness's own, or undefined if it
	 * never cosigned one.
	 */
	async latestCheckpoint(origin: string): Promise<Uint8Array | undefined> {
		return (await readLatest(this.#store, checkpointKey(this.#keyPrefix, origin))).checkpoint;
	}

	/**
	 * _latestByHash reads the latest checkpoint stored under an origin hash, for the
	 * monitoring endpoint, which names logs by hash rather than by origin.
	 *
	 * @internal
	 */
	async _latestByHash(hash: string): Promise<Uint8Array | undefined> {
		return this.#store.get(`${this.#keyPrefix}${hash}/checkpoint`);
	}

	async #verifiersFor(origin: string, signal?: AbortSignal): Promise<readonly Verifier[] | undefined> {
		const configured = this.#logs.get(origin);
		if (configured !== undefined) {
			return configured;
		}
		if (this.#lookupLog === undefined) {
			return undefined;
		}
		const keys = await this.#lookupLog(origin, signal);
		if (keys === undefined) {
			return undefined;
		}
		const vs = verifiersOf(origin, keys);
		// Logs come and go through lookupLog, possibly registered by the public; one that
		// claims a witness key is not one this witness witnesses.
		if (this.#keySeparation.sharesKey(vs)) {
			throw new Error(`${ErrUnknownLog.message} ${echo(origin)}: it is signed with one of the witness's own keys`, {
				cause: ErrUnknownLog,
			});
		}
		return vs;
	}

	async #evidence(
		reason: InconsistencyEvidence["reason"],
		origin: string,
		req: AddCheckpointRequest,
		latest: Uint8Array,
	): Promise<void> {
		await this.#onInconsistency?.({
			origin,
			reason,
			submitted: req.checkpoint,
			latest,
			oldSize: req.oldSize,
			proof: req.proof,
		});
	}
}

/** verifiersOf builds the verifiers for a log's keys, which must name at least one. */
function verifiersOf(origin: string, keys: LogKeys): readonly Verifier[] {
	const vs = [...(keys.verifiers ?? []), ...(keys.verifierKeys ?? []).map((k) => newVerifier(k))];
	if (vs.length === 0) {
		throw new Error(`log ${echo(origin)} has no verifier keys`);
	}
	return vs;
}

// hashSize is the size of a Merkle tree hash: tlog-witness logs use SHA-256 (RFC 6962).
const hashSize = 32;

function malformed(message: string): Error {
	return new Error(`${ErrMalformedRequest.message}: ${message}`, { cause: ErrMalformedRequest });
}

function invalidProof(message: string): Error {
	return new Error(`${ErrInvalidProof.message}: ${message}`, { cause: ErrInvalidProof });
}
