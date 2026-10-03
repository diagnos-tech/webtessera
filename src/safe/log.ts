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

// This file has no upstream counterpart. It is the part of openServerLog and
// openBrowserLog that does not depend on where the log runs: it wires a storage driver, a
// LogKey, the ported appender and publication awaiter, and the ported client's proof
// builder into one object whose methods hand back verified receipts. Every step is a call
// into the port; what this adds is the order they must happen in and the checks between
// them. See docs/decisions/0226-the-high-level-log.md.

import { CheckpointPath } from "../api/layout/paths.ts";
import {
	type Appender,
	type AppendOptions,
	newAppender,
	newAppendOptions,
	WitnessOptions,
} from "../append_lifecycle.ts";
import { newPublicationAwaiter, type PublicationAwaiter } from "../await.ts";
import { fetchLeafHashes, newProofBuilder, type TileFetcherFunc } from "../client/client.ts";
import { newEntry } from "../entry.ts";
import { MaxEntryBytes } from "../http/add.ts";
import { errorIs, wrapError } from "../internal/gostd/errors.ts";
import type { LogReader } from "../lifecycle.ts";
import { type Driver, ErrPushback } from "../log.ts";
import type { ObjectStore } from "../storage/objectstore/objectstore.ts";
import { type ParsedCheckpoint, parseCheckpoint } from "../vendor/formats/log/index.ts";
import { TLogProof } from "../vendor/formats/proof/tlog_proof.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import type { Verifier } from "../vendor/note/note.ts";
import type { WitnessGroup } from "../witness.ts";
import type { LogKey } from "./keys.ts";
import {
	type LogCheckpoint,
	logCheckpointOf,
	newReceipt,
	policyVerifiers,
	type Receipt,
	ReceiptError,
	type VerifiedReceipt,
	verifyReceipt,
} from "./receipt.ts";

/**
 * DefaultCheckpointIntervalMs is how often a high-level log publishes a checkpoint while it grows.
 *
 * ```ts
 * openServerLog({ key, storage, checkpointIntervalMs: 5 * DefaultCheckpointIntervalMs });
 * ```
 */
export const DefaultCheckpointIntervalMs = 1_000;

/** MinCheckpointIntervalMs is the shortest checkpoint interval the storage drivers accept, in milliseconds. */
export const MinCheckpointIntervalMs = 100;

// awaiterPollMs is how often a log's publication awaiter reads the checkpoint while an
// append is waiting for one: often enough to add little to append's latency, and only ever
// while somebody waits.
const awaiterPollMs = 100;

/**
 * DefaultPublishTimeoutMs is how long append waits for a checkpoint that covers its entry.
 *
 * ```ts
 * await log.append(entry, { timeoutMs: 2 * DefaultPublishTimeoutMs });
 * ```
 */
export const DefaultPublishTimeoutMs = 30_000;

/**
 * AppendCallOptions bounds one append.
 *
 * ```ts
 * await log.append(entry, { signal: request.signal, timeoutMs: 5_000 });
 * ```
 */
export interface AppendCallOptions {
	/** signal abandons the wait for the receipt; the entry may still be added. */
	readonly signal?: AbortSignal;
	/** timeoutMs overrides the log's publishTimeoutMs for this call. */
	readonly timeoutMs?: number;
}

/**
 * LogOptions are the options openServerLog and openBrowserLog have in common.
 *
 * ```ts
 * { key, checkpointIntervalMs: 2_000, appendOptions: (o) => o.withAntispam(DefaultAntispamInMemorySize, null) }
 * ```
 */
export interface LogOptions {
	/** key signs the log's checkpoints. A log keeps one key for its whole life. */
	readonly key: LogKey;
	/**
	 * witnesses, if given, must cosign each checkpoint before it is published (fail
	 * closed), and every receipt the log hands back carries their cosignatures. Build it
	 * with newWitness and newWitnessGroup, or newWitnessGroupFromPolicy, from `webtessera`.
	 */
	readonly witnesses?: WitnessGroup;
	/** witnessTimeoutMs bounds each attempt to collect the cosignatures. Defaults to 5 seconds. */
	readonly witnessTimeoutMs?: number;
	/**
	 * checkpointIntervalMs is how often a checkpoint is published while the log grows, and
	 * so roughly how long append takes. Defaults to {@link DefaultCheckpointIntervalMs}.
	 */
	readonly checkpointIntervalMs?: number;
	/**
	 * publishTimeoutMs is how long append waits for a checkpoint that covers its entry
	 * before it gives up (the entry stays in the log). Defaults to
	 * {@link DefaultPublishTimeoutMs}; zero waits for ever.
	 */
	readonly publishTimeoutMs?: number;
	/**
	 * appendOptions tunes the ported AppendOptions (batching, pushback, antispam, garbage
	 * collection) before the log installs its key and witnesses, which always win.
	 */
	readonly appendOptions?: (opts: AppendOptions) => AppendOptions;
}

/**
 * TransparencyLog is a tamper-evident, append-only log whose every append hands back a
 * receipt that proves offline that the entry is in it. openServerLog and openBrowserLog
 * return one.
 *
 * ```ts
 * const receipt = await log.append(new TextEncoder().encode("hello"));
 * verifyReceipt(receipt.text, { vkey: log.vkey, data: new TextEncoder().encode("hello") });
 * await log.close();
 * ```
 */
export interface TransparencyLog {
	/** origin is the log's checkpoint origin. */
	readonly origin: string;
	/** vkey is the log's note verifier key: give it to whoever verifies the log's receipts. */
	readonly vkey: string;
	/** verifier is a note Verifier for vkey. */
	readonly verifier: Verifier;
	/**
	 * reader reads the log's public resources: checkpoint, tiles and entry bundles. It is a
	 * ported LogReader, and the way down to the rest of the API (webtessera/client,
	 * webtessera/fsck, webtessera/mirror, webtessera/http).
	 */
	readonly reader: LogReader;
	/** appender is the ported Appender the log adds entries with, for code that needs its futures. */
	readonly appender: Appender;

	/**
	 * append adds data to the log as one entry and resolves, once a published checkpoint
	 * commits to it, to a receipt that has already been verified against the log's key
	 * and the entry.
	 */
	append(data: Uint8Array, options?: AppendCallOptions): Promise<Receipt>;

	/** latestCheckpoint returns the latest published checkpoint, verified. */
	latestCheckpoint(signal?: AbortSignal): Promise<LogCheckpoint>;

	/** prove returns a receipt for the entry at index, relative to the latest checkpoint. */
	prove(index: bigint | number, signal?: AbortSignal): Promise<Receipt>;

	/** verify checks a receipt for data against this log's key and witness policy. */
	verify(receipt: Receipt | string | Uint8Array, data: Uint8Array): VerifiedReceipt;

	/**
	 * close waits until every entry appended so far is covered by a published checkpoint,
	 * then stops the log's background work and closes the storage the log opened itself (an
	 * IndexedDB connection); a database passed in stays open, for its owner to close. It is
	 * safe to call more than once, and signal bounds the wait.
	 */
	close(signal?: AbortSignal): Promise<void>;
}

/**
 * LogParts is what openLog builds: everything a TransparencyLog needs to run.
 *
 * @internal
 */
export interface LogParts {
	readonly where: string;
	readonly key: LogKey;
	readonly witnesses: WitnessGroup | undefined;
	readonly appender: Appender;
	readonly reader: LogReader;
	readonly shutdown: (signal?: AbortSignal) => Promise<void>;
	readonly awaiter: PublicationAwaiter;
	readonly lifetime: AbortController;
	readonly publishTimeoutMs: number;
	readonly onClose: (() => void | Promise<void>) | undefined;
}

/**
 * openLog checks that the storage holds this key's log (or no log yet), and starts the
 * ported appender and publication awaiter on it.
 *
 * @internal Called by openServerLog and openBrowserLog once they have chosen the storage.
 */
export async function openLog(
	where: string,
	options: LogOptions,
	storage: { readonly driver: Driver; readonly store: ObjectStore; readonly onClose?: () => void | Promise<void> },
): Promise<LogParts> {
	const { key } = options;
	const checkpointIntervalMs = positive(
		options.checkpointIntervalMs,
		DefaultCheckpointIntervalMs,
		"checkpointIntervalMs",
		where,
	);
	if (checkpointIntervalMs < MinCheckpointIntervalMs) {
		throw new RangeError(
			`${where}: checkpointIntervalMs must be at least ${MinCheckpointIntervalMs}, the storage driver's minimum, got ${checkpointIntervalMs}`,
		);
	}
	const publishTimeoutMs = nonNegative(options.publishTimeoutMs, DefaultPublishTimeoutMs, "publishTimeoutMs", where);
	const witnessTimeoutMs = nonNegative(options.witnessTimeoutMs, 0, "witnessTimeoutMs", where);

	// A log keeps one key for its whole life: a checkpoint signed by another key is one no
	// client of the log would accept. This catches a key that was lost and regenerated, and
	// two logs sharing one storage.
	const existing = await storage.store.get(CheckpointPath);
	if (existing !== undefined) {
		try {
			parseCheckpoint(existing, key.origin, key.verifier());
		} catch (err) {
			throw new Error(
				`${where}: this storage holds a log that was not created with this key: its published checkpoint does not ` +
					`verify with ${key.vkey} (${messageOf(err)}). A log keeps one key for its whole life; open it with the ` +
					"key that created it, or give a new log storage of its own.",
				{ cause: err },
			);
		}
	}

	let opts = newAppendOptions().withBatching(256, 100).withCheckpointInterval(checkpointIntervalMs);
	if (options.appendOptions !== undefined) {
		opts = options.appendOptions(opts);
	}
	opts.withCheckpointAsyncSigner(key);
	if (options.witnesses !== undefined) {
		opts.withWitnesses(options.witnesses, new WitnessOptions({ timeout: witnessTimeoutMs, failOpen: false }));
	}

	const lifetime = new AbortController();
	let started: Awaited<ReturnType<typeof newAppender>>;
	try {
		started = await newAppender(storage.driver, opts, lifetime.signal);
	} catch (err) {
		lifetime.abort();
		throw new Error(
			`${where}: could not start the log: ${messageOf(err)}${
				options.witnesses === undefined
					? ""
					: " (a new log publishes its first checkpoint as it opens, so its witnesses must be reachable then)"
			}`,
			{ cause: err },
		);
	}
	const { appender, shutdown, reader } = started;
	const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), awaiterPollMs, lifetime.signal);
	return {
		where,
		key,
		witnesses: options.witnesses,
		appender,
		reader,
		shutdown,
		awaiter,
		lifetime,
		publishTimeoutMs,
		onClose: storage.onClose,
	};
}

/**
 * LogBase implements TransparencyLog over the parts openLog built.
 *
 * @internal Extended by the server and browser logs.
 */
export class LogBase implements TransparencyLog {
	readonly origin: string;
	readonly vkey: string;
	readonly verifier: Verifier;
	readonly reader: LogReader;
	readonly appender: Appender;
	readonly #parts: LogParts;
	readonly #witnessVerifiers: Verifier[];
	readonly #tiles: TileFetcherFunc;
	#closing: Promise<void> | undefined;

	constructor(parts: LogParts) {
		this.#parts = parts;
		this.origin = parts.key.origin;
		this.vkey = parts.key.vkey;
		this.verifier = parts.key.verifier();
		this.reader = parts.reader;
		this.appender = parts.appender;
		this.#witnessVerifiers = parts.witnesses === undefined ? [] : policyVerifiers(parts.witnesses);
		this.#tiles = (l, i, p, s) => parts.reader.readTile(l, i, p, s);
	}

	async append(data: Uint8Array, options: AppendCallOptions = {}): Promise<Receipt> {
		this.#checkOpen("append");
		if (!(data instanceof Uint8Array)) {
			throw new TypeError("append takes the entry as a Uint8Array; encode text with new TextEncoder().encode(text)");
		}
		if (data.length > MaxEntryBytes) {
			throw new RangeError(
				`append: an entry holds at most ${MaxEntryBytes} bytes, and this one is ${data.length}; log a SHA-256 ` +
					"digest of large data instead, and keep the data elsewhere",
			);
		}
		const timeoutMs = nonNegative(options.timeoutMs, this.#parts.publishTimeoutMs, "timeoutMs", "append");
		const future = this.appender.add(newEntry(data));
		let sequenced: bigint | undefined;
		// The future is memoized, so the awaiter's call to it shares this one's result.
		future().then(
			(i) => {
				sequenced = i.index;
			},
			() => {},
		);

		// The caller's signal is raced here rather than passed to PublicationAwaiter.await,
		// which (as Go's Await does with its context) records one caller's cancellation as the
		// error every waiter of the shared awaiter sees until its next poll.
		let index: bigint;
		let checkpoint: Uint8Array;
		try {
			const [i, cp] = await within(this.#parts.awaiter.await(future), options.signal, timeoutMs, () =>
				sequenced === undefined
					? new Error(
							`append: the entry was not sequenced within ${timeoutMs} ms; the log may be overloaded, and the entry ` +
								"may still be added",
						)
					: new Error(
							`append: the entry was durably sequenced at index ${sequenced}, but no checkpoint covering it was ` +
								`published within ${timeoutMs} ms. If the log has witnesses, check that they are reachable; call ` +
								`prove(${sequenced}n) later for its receipt.`,
						),
			);
			index = i.index;
			checkpoint = cp;
		} catch (err) {
			if (errorIs(err, ErrPushback)) {
				throw wrapError("append: the log is overloaded and refused the entry; retry later", err);
			}
			throw err;
		}
		return this.#receipt(index, checkpoint, DefaultHasher.hashLeaf(data), options.signal);
	}

	async latestCheckpoint(signal?: AbortSignal): Promise<LogCheckpoint> {
		this.#checkOpen("latestCheckpoint");
		const raw = await this.reader.readCheckpoint(signal);
		return logCheckpointOf(this.#parse(raw).checkpoint, raw);
	}

	async prove(index: bigint | number, signal?: AbortSignal): Promise<Receipt> {
		this.#checkOpen("prove");
		const i = toIndex(index);
		const raw = await this.reader.readCheckpoint(signal);
		const { size } = this.#parse(raw).checkpoint;
		if (i >= size) {
			throw new RangeError(
				`prove: the latest checkpoint covers entries 0 to ${size - 1n}, not ${i}: the entry does not exist yet, or ` +
					"was appended moments ago (append resolves once its entry is covered)",
			);
		}
		const [leafHash] = await fetchLeafHashes(this.#tiles, i, 1n, size, signal);
		if (leafHash === undefined) {
			throw new Error(`prove: no leaf hash for entry ${i}`);
		}
		return this.#receipt(i, raw, leafHash, signal);
	}

	verify(receipt: Receipt | string | Uint8Array, data: Uint8Array): VerifiedReceipt {
		return verifyReceipt(
			receipt,
			this.#parts.witnesses === undefined
				? { vkey: this.verifier, data }
				: { vkey: this.verifier, data, witnesses: this.#parts.witnesses },
		);
	}

	close(signal?: AbortSignal): Promise<void> {
		this.#closing ??= (async (): Promise<void> => {
			try {
				await this.#parts.shutdown(signal);
			} finally {
				this.#parts.lifetime.abort(new Error(`${this.#parts.where}: the log was closed`));
				await this.#parts.onClose?.();
			}
		})();
		return this.#closing;
	}

	/** #receipt builds the receipt for the entry at index, and verifies it before handing it back. */
	async #receipt(index: bigint, cp: Uint8Array, leafHash: Uint8Array, signal?: AbortSignal): Promise<Receipt> {
		const parsed = this.#parse(cp);
		const proofs = await newProofBuilder(parsed.checkpoint.size, this.#tiles);
		const proof = new TLogProof({ index, hashes: await proofs.inclusionProof(index, signal), checkpoint: cp });
		try {
			verifyReceipt(
				proof,
				this.#parts.witnesses === undefined
					? { vkey: this.verifier, leafHash }
					: { vkey: this.verifier, leafHash, witnesses: this.#parts.witnesses },
			);
		} catch (err) {
			if (!(err instanceof ReceiptError)) {
				throw err;
			}
			throw new Error(
				`${this.#parts.where}: the receipt for entry ${index} does not verify (${err.message}); the log's storage ` +
					"may be damaged: check it with fsck from webtessera/fsck",
				{ cause: err },
			);
		}
		return newReceipt(proof, logCheckpointOf(parsed.checkpoint, cp));
	}

	#parse(cp: Uint8Array): ParsedCheckpoint {
		return parseCheckpoint(cp, this.origin, this.verifier, ...this.#witnessVerifiers);
	}

	#checkOpen(method: string): void {
		if (this.#closing !== undefined) {
			throw new Error(`${method}: this log is closed`);
		}
	}
}

/**
 * within settles like p, unless signal aborts first (rejecting with its reason) or
 * timeoutMs passes (rejecting with onTimeout()). p keeps running either way.
 */
function within<T>(
	p: Promise<T>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	onTimeout: () => Error,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal?.aborted) {
			p.catch(() => {});
			reject(signal.reason);
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			done();
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				done();
				reject(onTimeout());
			}, timeoutMs);
		}
		p.then(
			(v) => {
				done();
				resolve(v);
			},
			(err: unknown) => {
				done();
				reject(err);
			},
		);
	});
}

function toIndex(index: bigint | number): bigint {
	if (typeof index === "bigint" && index >= 0n) {
		return index;
	}
	if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) {
		return BigInt(index);
	}
	throw new TypeError(`prove: the index must be a non-negative integer, got ${String(index)}`);
}

function positive(v: number | undefined, def: number, name: string, where: string): number {
	if (v === undefined) {
		return def;
	}
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
		throw new RangeError(`${where}: ${name} must be a positive number of milliseconds, got ${String(v)}`);
	}
	return v;
}

function nonNegative(v: number | undefined, def: number, name: string, where: string): number {
	if (v === undefined) {
		return def;
	}
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
		throw new RangeError(`${where}: ${name} must be zero or a positive number of milliseconds, got ${String(v)}`);
	}
	return v;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
