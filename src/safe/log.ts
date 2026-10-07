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
// builder and entry streaming into one object whose methods hand back verified receipts and
// checked entries. Every step is a call into the port; what this adds is the order they must
// happen in and the checks between them. See docs/decisions/0226-the-high-level-log.md.

import { CheckpointPath } from "../api/layout/paths.ts";
import { EntryBundleWidth } from "../api/layout/tile.ts";
import { EntryBundle } from "../api/state.ts";
import {
	type Appender,
	type AppendOptions,
	newAppender,
	newAppendOptions,
	WitnessOptions,
} from "../append_lifecycle.ts";
import { newPublicationAwaiter, type PublicationAwaiter } from "../await.ts";
import { fetchLeafHashes, newProofBuilder, type TileFetcherFunc } from "../client/client.ts";
import { entryBundles, entries as streamEntries } from "../client/stream.ts";
import { newEntry } from "../entry.ts";
import { newFsck } from "../fsck/fsck.ts";
import { MaxEntryBytes } from "../http/add.ts";
import { MaxScanTokenSize } from "../internal/gostd/bufio.ts";
import { bytesEqual } from "../internal/gostd/bytes.ts";
import { errorIs } from "../internal/gostd/errors.ts";
import { defaultMerkleLeafHasher, type LogReader } from "../lifecycle.ts";
import { type Driver, ErrPushback } from "../log.ts";
import type { ObjectStore } from "../storage/objectstore/objectstore.ts";
import { type ParsedCheckpoint, parseCheckpoint } from "../vendor/formats/log/index.ts";
import { TLogProof } from "../vendor/formats/proof/tlog_proof.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import type { Verifier } from "../vendor/note/note.ts";
import type { WitnessGroup } from "../witness.ts";
import { quoteInput, WebtesseraError } from "./errors.ts";
import type { LogKey } from "./keys.ts";
import {
	type LogCheckpoint,
	logCheckpointOf,
	newReceipt,
	policyVerifiers,
	type Receipt,
	ReceiptError,
	type ReceiptJSON,
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
 * DefaultFsckWorkers is how many log resources fsck compares at once, unless told otherwise.
 *
 * ```ts
 * await log.fsck({ workers: 2 * DefaultFsckWorkers });
 * ```
 */
export const DefaultFsckWorkers = 4;

/**
 * AppendCallOptions bounds one append, and says what its receipt carries besides the proof.
 *
 * ```ts
 * await log.append(entry, { signal: shutdown.signal, timeoutMs: 5_000, extraData: entry });
 * ```
 */
export interface AppendCallOptions {
	/** signal abandons the wait for the receipt; the entry may still be added. */
	readonly signal?: AbortSignal;
	/** timeoutMs overrides the log's publishTimeoutMs for this call. */
	readonly timeoutMs?: number;
	/**
	 * extraData is put in the receipt's `extra` line, which C2SP tlog-proof reserves for
	 * application data: out-of-band context, or what a verifier needs to rebuild the entry.
	 * The format does not authenticate it. Pass the entry itself (`extraData: data`) for a
	 * receipt that carries everything a verifier needs, and verify it with
	 * `verifyReceipt(receipt, { vkey, dataInExtra: true })`, which proves the extra data is
	 * the entry before handing it back. At most {@link MaxExtraDataBytes} bytes.
	 */
	readonly extraData?: Uint8Array;
}

/**
 * AppendManyOptions bounds one appendMany.
 *
 * ```ts
 * await log.appendMany(entries, { signal: request.signal, timeoutMs: 10_000 });
 * ```
 */
export interface AppendManyOptions {
	/** signal abandons the wait for the receipts; the entries may still be added. */
	readonly signal?: AbortSignal;
	/** timeoutMs overrides the log's publishTimeoutMs for this call. */
	readonly timeoutMs?: number;
}

/**
 * ProveOptions bounds one prove, and says what its receipt carries besides the proof.
 *
 * ```ts
 * await log.prove(index, { extraData: entry });
 * ```
 */
export interface ProveOptions {
	/** signal abandons building the receipt. */
	readonly signal?: AbortSignal;
	/** extraData is put in the receipt's `extra` line, as {@link AppendCallOptions.extraData} is. */
	readonly extraData?: Uint8Array;
}

/**
 * FsckOptions bounds one fsck.
 *
 * ```ts
 * await log.fsck({ signal: AbortSignal.timeout(60_000) });
 * ```
 */
export interface FsckOptions {
	/** signal abandons the check. */
	readonly signal?: AbortSignal;
	/** workers is how many resources are compared at once. Defaults to {@link DefaultFsckWorkers}. */
	readonly workers?: number;
}

/**
 * FsckResult is what fsck reports once the whole log has verified.
 *
 * ```ts
 * const { checkpoint, resourcesFetched } = await log.fsck();
 * console.log(`all ${checkpoint.size} entries verified, from ${resourcesFetched} resources`);
 * ```
 */
export interface FsckResult {
	/** checkpoint is the verified checkpoint the log was checked against. */
	readonly checkpoint: LogCheckpoint;
	/** resourcesFetched is how many tiles, entry bundles and checkpoints the check read. */
	readonly resourcesFetched: bigint;
	/** bytesFetched is how many bytes the check read. */
	readonly bytesFetched: bigint;
}

/**
 * MaxExtraDataBytes is the most extra data a receipt can carry: the longest that, base64
 * encoded on the `extra` line, the tlog-proof decoders of this library and of
 * transparency-dev/formats can read back. Both scan a proof line by line with Go's
 * bufio.Scanner limit, under which a line must be shorter than 64 KiB.
 */
export const MaxExtraDataBytes = Math.floor((MaxScanTokenSize - 1 - "extra ".length) / 4) * 3;

/**
 * LogEntry is one entry of a log, read back from its storage.
 *
 * ```ts
 * for await (const { index, data } of log.entries()) { … }
 * ```
 */
export interface LogEntry {
	/** index is the entry's index in the log. */
	readonly index: bigint;
	/** data is the entry, as it was appended. */
	readonly data: Uint8Array;
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
 * AsyncDisposeKey is the type of `Symbol.asyncDispose` where the TypeScript lib in use
 * declares it (TypeScript 5.2 and later, with `esnext.disposable` or `esnext` in `lib`), and
 * never where it does not, so that these declarations type-check under any lib.
 */
type AsyncDisposeKey = SymbolConstructor extends { readonly asyncDispose: infer K extends symbol } ? K : never;

/**
 * AsyncDisposableLog is what lets `await using log = await openServerLog(…)` close the log
 * when the scope ends: TypeScript's `AsyncDisposable` where the lib in use declares it, and
 * nothing where it does not.
 *
 * ```ts
 * await using log = await openServerLog({ key, storage });
 * ```
 */
export type AsyncDisposableLog = { readonly [K in AsyncDisposeKey]: () => Promise<void> };

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
 *
 * Where the runtime has `Symbol.asyncDispose`, the log is also async-disposable, and
 * `await using log = …` closes it as close() does when the scope ends.
 */
export interface TransparencyLog extends AsyncDisposableLog {
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
	 *
	 * It takes about as long as the log's checkpoint interval (1 s by default), because it
	 * waits for the next checkpoint; entries appended at the same time share that
	 * checkpoint. So appends awaited one after another cost an interval each: start them
	 * together (`Promise.all`), or use appendMany, for a batch at the cost of one. Code
	 * that wants an index sooner and its receipt later can use `log.appender` and prove.
	 */
	append(data: Uint8Array, options?: AppendCallOptions): Promise<Receipt>;

	/**
	 * appendMany adds every entry of datas, in order, as consecutive entries, and resolves
	 * to their receipts in the same order, each verified as append verifies it. Every entry
	 * is checked before any is added, so one that the log cannot hold refuses the whole
	 * batch.
	 *
	 * The entries share one checkpoint, so the call takes about one checkpoint interval
	 * however many entries it carries, where a loop of awaited appends takes one per entry.
	 * The price is all or nothing: the receipts arrive together, and if appendMany rejects
	 * (a timeout, pushback, the log closing), some entries may already be in the log; prove
	 * fetches their receipts. Very large batches meet the log's pushback limit
	 * (`DefaultPushbackMaxOutstanding`); split them.
	 *
	 * ```ts
	 * const receipts = await log.appendMany(records.map((r) => new TextEncoder().encode(r)));
	 * ```
	 */
	appendMany(datas: Iterable<Uint8Array>, options?: AppendManyOptions): Promise<Receipt[]>;

	/** latestCheckpoint returns the latest published checkpoint, verified. */
	latestCheckpoint(signal?: AbortSignal): Promise<LogCheckpoint>;

	/**
	 * prove returns a receipt for the entry at index, relative to the latest checkpoint.
	 * The second argument is an AbortSignal, or ProveOptions to give the receipt extra data
	 * as append does.
	 */
	prove(index: bigint | number, options?: AbortSignal | ProveOptions): Promise<Receipt>;

	/**
	 * entries reads the log's entries back, in order, from index `from` (default 0) up to
	 * but not including `to`, or to the size of the latest checkpoint when `to` is omitted
	 * or larger. The checkpoint is read, and verified, once as iteration starts; entries
	 * appended after that are not included.
	 *
	 * Each entry is checked against the leaf hash the log's tiles hold for it, the leaf hash
	 * its receipt would be proved from, so damaged storage fails here rather than yield an
	 * entry no receipt could prove. For a receipt that proves one to others, call prove.
	 * Entry bundles are read a few at a time, so memory stays bounded however many entries
	 * are read, and breaking out of the loop stops the reading.
	 *
	 * ```ts
	 * for await (const { index, data } of log.entries(size - 20n)) { … }
	 * ```
	 */
	entries(from?: bigint | number, to?: bigint | number, signal?: AbortSignal): AsyncGenerator<LogEntry>;

	/**
	 * entry reads the entry at index back, checked as entries checks it. An index the
	 * latest checkpoint does not cover is refused, as prove refuses it.
	 */
	entry(index: bigint | number, signal?: AbortSignal): Promise<LogEntry>;

	/** verify checks a receipt for data against this log's key and witness policy. */
	verify(receipt: Receipt | ReceiptJSON | string | Uint8Array, data: Uint8Array): VerifiedReceipt;

	/**
	 * fsck verifies the whole log as Tessera's fsck does: it reads every entry bundle,
	 * recomputes every tile and the root hash from the entries, and checks them against
	 * the log's storage and its latest checkpoint (verified with the log's key and
	 * witnesses first). It resolves once all of it verifies, and otherwise throws a
	 * WebtesseraError with the code `STORAGE_DAMAGED`, the fsck error as its cause.
	 *
	 * It reads the whole log, so it costs a pass over the log's storage: run it after an
	 * incident, a restore or a migration, or from a scheduled job, not per request.
	 *
	 * ```ts
	 * const { checkpoint } = await log.fsck();
	 * ```
	 */
	fsck(options?: FsckOptions): Promise<FsckResult>;

	/**
	 * close waits until every entry appended so far is covered by a published checkpoint,
	 * then stops the log's background work and closes the storage the log opened itself (an
	 * IndexedDB connection); a database passed in stays open, for its owner to close. It is
	 * safe to call more than once, and signal bounds the wait.
	 */
	close(signal?: AbortSignal): Promise<void>;
}

/**
 * Explain turns an error from the storage driver into one that says, in the safe API's
 * terms, what it means; it returns undefined for errors it has nothing to add to. method
 * names the TransparencyLog method (or the factory) that met the error.
 *
 * @internal Supplied by openServerLog, whose SQLite storage has failures of its own.
 */
export type Explain = (err: unknown, method: string) => Error | undefined;

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
	readonly explain: Explain | undefined;
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
	storage: {
		readonly driver: Driver;
		readonly store: ObjectStore;
		readonly onClose?: () => void | Promise<void>;
		readonly explain?: Explain;
	},
): Promise<LogParts> {
	const { key } = options;
	const checkpointIntervalMs = positive(
		options.checkpointIntervalMs,
		DefaultCheckpointIntervalMs,
		"checkpointIntervalMs",
		where,
	);
	if (checkpointIntervalMs < MinCheckpointIntervalMs) {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
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
			throw new WebtesseraError(
				"KEY_MISMATCH",
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
		const explained = storage.explain?.(err, where);
		if (explained !== undefined) {
			throw explained;
		}
		if (options.witnesses === undefined) {
			throw new WebtesseraError("OPEN_FAILED", `${where}: could not start the log: ${messageOf(err)}`, { cause: err });
		}
		const conflict = witnessConflict(messageOf(err));
		if (conflict !== undefined) {
			throw new WebtesseraError(
				"WITNESS_CONFLICT",
				`${where}: this storage holds an older or different log than its witnesses cosigned: ${conflict}. A ` +
					"witness never cosigns a tree that does not extend the one it cosigned last, so the log cannot publish " +
					"from this storage. Open the storage that holds the log the witnesses saw, or start a new log under " +
					`an origin of its own. (${messageOf(err)})`,
				{ cause: err },
			);
		}
		throw new WebtesseraError(
			"OPEN_FAILED",
			`${where}: could not start the log: ${messageOf(err)} (a new log publishes its first checkpoint as it ` +
				"opens, so its witnesses must be reachable then)",
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
		explain: storage.explain,
	};
}

/**
 * witnessConflict recognises, in the message of the error that stopped a log from opening,
 * a witness's answer that it has cosigned a larger tree than the log's storage holds, and
 * says what that answer means. A log publishes as it opens only when its storage is empty
 * (the size-0 checkpoint of a new tree), so that is the one conflict opening can meet; a
 * same-size root mismatch cannot happen at size 0. The text is that of Tessera's witness
 * client (src/internal/witness/witness.ts), Go's own; the error that carries it is
 * flattened into a message on its way out of the storage driver, so the message is what
 * there is to read.
 */
function witnessConflict(message: string): string | undefined {
	// The witness answered 409 with the size of its latest cosigned checkpoint, and that is
	// larger than the checkpoint the log is publishing: storage lost entries the witness saw.
	const larger = /witness at ("(?:[^"\\]|\\.)*") replied with x\.tlog\.size (\d+), larger than log size (\d+)/.exec(
		message,
	);
	if (larger !== null) {
		const [, url, witnessed, held] = larger;
		return (
			`the witness at ${url} has cosigned this log at size ${witnessed}, and the storage holds ` +
			(held === "0" ? "no entries (it is empty, or was wiped)" : `only ${held}`)
		);
	}
	return undefined;
}

// asyncDispose is Symbol.asyncDispose where the runtime has it (Node.js, Deno, Bun, workerd
// and current browsers), for `await using`. Where it is missing, `await using` is too.
const asyncDispose = (Symbol as { readonly asyncDispose?: symbol }).asyncDispose;

/**
 * LogBase implements TransparencyLog over the parts openLog built. Its async-dispose
 * method is installed on the prototype under the runtime's Symbol.asyncDispose, so that no
 * declaration names a symbol the consumer's TypeScript lib may lack; {@link disposable}
 * types it.
 *
 * @internal Extended by the server and browser logs.
 */
export class LogBase implements Omit<TransparencyLog, keyof AsyncDisposableLog> {
	readonly origin: string;
	readonly vkey: string;
	readonly verifier: Verifier;
	readonly reader: LogReader;
	readonly appender: Appender;
	readonly #parts: LogParts;
	readonly #witnessVerifiers: Verifier[];
	readonly #tiles: TileFetcherFunc;
	#closing: Promise<void> | undefined;

	static {
		if (asyncDispose !== undefined) {
			Object.defineProperty(LogBase.prototype, asyncDispose, {
				value(this: LogBase): Promise<void> {
					return this.close();
				},
				writable: true,
				configurable: true,
			});
		}
	}

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
		checkEntry(data, "append");
		const timeoutMs = nonNegative(options.timeoutMs, this.#parts.publishTimeoutMs, "timeoutMs", "append");
		const extraData = checkExtraData(options.extraData, "append");
		return this.#append("append", data, timeoutMs, extraData, options.signal);
	}

	async appendMany(datas: Iterable<Uint8Array>, options: AppendManyOptions = {}): Promise<Receipt[]> {
		this.#checkOpen("appendMany");
		if (typeof datas !== "object" || datas === null || typeof datas[Symbol.iterator] !== "function") {
			throw new WebtesseraError(
				"INVALID_ARGUMENT",
				"appendMany takes the entries as an array (or another iterable) of Uint8Arrays",
			);
		}
		const list = Array.from(datas);
		for (const [i, data] of list.entries()) {
			checkEntry(data, `appendMany: entry ${i}`);
		}
		const timeoutMs = nonNegative(options.timeoutMs, this.#parts.publishTimeoutMs, "timeoutMs", "appendMany");
		// Nothing above awaits, and each #append adds its entry before its first await, so the
		// entries reach the appender in order, in one batch, and share one checkpoint.
		return await Promise.all(
			list.map((data) => this.#append("appendMany", data, timeoutMs, undefined, options.signal)),
		);
	}

	async latestCheckpoint(signal?: AbortSignal): Promise<LogCheckpoint> {
		this.#checkOpen("latestCheckpoint");
		const raw = await this.reader.readCheckpoint(signal);
		return logCheckpointOf(this.#parse(raw).checkpoint, raw);
	}

	async prove(index: bigint | number, options?: AbortSignal | ProveOptions): Promise<Receipt> {
		this.#checkOpen("prove");
		const i = toIndex(index, "prove");
		const { signal, extraData: extra } = isAbortSignal(options)
			? { signal: options, extraData: undefined }
			: (options ?? {});
		const extraData = checkExtraData(extra, "prove");
		const raw = await this.reader.readCheckpoint(signal);
		const { size } = this.#parse(raw).checkpoint;
		if (i >= size) {
			throw notCovered("prove", i, size);
		}
		const [leafHash] = await fetchLeafHashes(this.#tiles, i, 1n, size, signal);
		if (leafHash === undefined) {
			throw new WebtesseraError("STORAGE_DAMAGED", `prove: no leaf hash for entry ${i}`, { index: i });
		}
		return this.#receipt("prove", i, raw, leafHash, extraData, signal);
	}

	entries(from?: bigint | number, to?: bigint | number, signal?: AbortSignal): AsyncGenerator<LogEntry> {
		this.#checkOpen("entries");
		const start = from === undefined ? 0n : toIndex(from, "entries", "from");
		const end = to === undefined ? undefined : toIndex(to, "entries", "to");
		if (end !== undefined && start > end) {
			throw new WebtesseraError(
				"INVALID_ARGUMENT",
				`entries: from must not be greater than to, got from ${start} and to ${end}`,
			);
		}
		return this.#entries("entries", start, end, signal);
	}

	async entry(index: bigint | number, signal?: AbortSignal): Promise<LogEntry> {
		this.#checkOpen("entry");
		const i = toIndex(index, "entry");
		for await (const e of this.#entries("entry", i, i + 1n, signal, true)) {
			return e;
		}
		// Unreachable: #entries refuses an index the checkpoint does not cover, and yields
		// every one it does.
		throw new WebtesseraError("STORAGE_DAMAGED", `entry: no entry ${i}`, { index: i });
	}

	verify(receipt: Receipt | ReceiptJSON | string | Uint8Array, data: Uint8Array): VerifiedReceipt {
		return verifyReceipt(
			receipt,
			this.#parts.witnesses === undefined
				? { vkey: this.verifier, data }
				: { vkey: this.verifier, data, witnesses: this.#parts.witnesses },
		);
	}

	async fsck(options: FsckOptions = {}): Promise<FsckResult> {
		this.#checkOpen("fsck");
		const { signal } = options;
		const workers = options.workers ?? DefaultFsckWorkers;
		if (!Number.isSafeInteger(workers) || workers < 1) {
			throw new WebtesseraError(
				"INVALID_ARGUMENT",
				`fsck: workers must be a positive integer, got ${quoteOption(workers)}`,
			);
		}
		// The checkpoint is read and verified, witnesses included, once; fsck then checks the
		// log against exactly that checkpoint, however much the log grows meanwhile.
		const raw = await this.reader.readCheckpoint(signal);
		const checkpoint = logCheckpointOf(this.#parse(raw).checkpoint, raw);
		const reader = this.reader;
		const f = newFsck(
			this.origin,
			this.verifier,
			{
				readCheckpoint: () => Promise.resolve(raw),
				readTile: (l, i, p, s) => reader.readTile(l, i, p, s),
				readEntryBundle: (i, p, s) => reader.readEntryBundle(i, p, s),
			},
			defaultMerkleLeafHasher,
			{ n: workers },
		);
		try {
			await f.check(signal);
		} catch (err) {
			if (signal?.aborted === true) {
				throw err;
			}
			throw new WebtesseraError(
				"STORAGE_DAMAGED",
				`fsck: the log's storage does not verify against its checkpoint at size ${checkpoint.size}: ` +
					`${messageOf(err)}. Restore the storage from a backup or a mirror; until then, receipts for the ` +
					"damaged entries cannot be built.",
				{ cause: err },
			);
		}
		const { resourcesFetched, bytesFetched } = f.status();
		return { checkpoint, resourcesFetched, bytesFetched };
	}

	close(signal?: AbortSignal): Promise<void> {
		this.#closing ??= (async (): Promise<void> => {
			try {
				await this.#parts.shutdown(signal);
			} finally {
				this.#parts.lifetime.abort(new WebtesseraError("LOG_CLOSED", `${this.#parts.where}: the log was closed`));
				await this.#parts.onClose?.();
			}
		})();
		return this.#closing;
	}

	/**
	 * #append adds data, which its caller has checked, waits for a checkpoint that commits to
	 * it, and returns its verified receipt. It adds the entry before its first await.
	 */
	async #append(
		method: string,
		data: Uint8Array,
		timeoutMs: number,
		extraData: Uint8Array | undefined,
		signal: AbortSignal | undefined,
	): Promise<Receipt> {
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
			const [i, cp] = await within(this.#parts.awaiter.await(future), signal, timeoutMs, () =>
				sequenced === undefined
					? new WebtesseraError(
							"SEQUENCE_TIMEOUT",
							`${method}: the entry was not sequenced within ${timeoutMs} ms; the log may be overloaded, and the ` +
								"entry may still be added",
						)
					: new WebtesseraError(
							"PUBLISH_TIMEOUT",
							`${method}: the entry was durably sequenced at index ${sequenced}, but no checkpoint covering it was ` +
								`published within ${timeoutMs} ms. If the log has witnesses, check that they are reachable, and ` +
								"that none has cosigned a larger or different tree than this storage holds; call " +
								`prove(${sequenced}n) later for its receipt.`,
							{ index: sequenced },
						),
			);
			index = i.index;
			checkpoint = cp;
		} catch (err) {
			if (err instanceof WebtesseraError || err === signal?.reason) {
				throw err;
			}
			if (errorIs(err, ErrPushback)) {
				throw new WebtesseraError("OVERLOADED", `${method}: the log is overloaded and refused the entry; retry later`, {
					cause: err,
				});
			}
			throw this.#parts.explain?.(err, method) ?? err;
		}
		return this.#receipt(method, index, checkpoint, DefaultHasher.hashLeaf(data), extraData, signal);
	}

	/**
	 * #entries streams the entries [start, min(end, size)) of the log at the size of its latest
	 * checkpoint with the ported client's entryBundles and entries, checking each against its
	 * leaf hash in the log's tiles. It refuses a start beyond the checkpoint, or, when exact (one
	 * entry was asked for by index), a start the checkpoint does not cover.
	 */
	async *#entries(
		method: string,
		start: bigint,
		end: bigint | undefined,
		signal: AbortSignal | undefined,
		exact = false,
	): AsyncGenerator<LogEntry> {
		const raw = await this.reader.readCheckpoint(signal);
		const { size } = this.#parse(raw).checkpoint;
		if (exact ? start >= size : start > size) {
			throw notCovered(method, start, size);
		}
		const stop = end === undefined || end > size ? size : end;
		if (start >= stop) {
			return;
		}

		// Every upstream caller of entryBundles streams to the tree size, and its read-ahead
		// would fetch bundles past stop when it is smaller; the bundles past stop are never
		// consumed, since iteration ends at stop - 1, so they are answered empty rather than
		// read. Reads fail once the log is closed, rather than reach a closed database.
		const lastBundle = (stop - 1n) / entryBundleWidth64;
		const bundles = entryBundles(
			entriesReadAhead,
			async () => size,
			(i, p, s) => {
				if (this.#closing !== undefined) {
					return Promise.reject(closed(method));
				}
				return i > lastBundle ? Promise.resolve(new Uint8Array(0)) : this.reader.readEntryBundle(i, p, s);
			},
			start,
			size - start,
			signal,
		);

		// The leaf hashes of the bundle being read, from the level-0 tile that covers the same
		// entries: one tile read per bundle.
		let leafHashes: Uint8Array[] = [];
		let first = 0n;
		for await (const e of streamEntries(bundles, unbundle)) {
			if (e.index - first >= BigInt(leafHashes.length)) {
				first = e.index;
				const bundleEnd = (e.index / entryBundleWidth64 + 1n) * entryBundleWidth64;
				leafHashes = await fetchLeafHashes(
					this.#tiles,
					first,
					(bundleEnd < stop ? bundleEnd : stop) - first,
					size,
					signal,
				);
			}
			const want = leafHashes[Number(e.index - first)];
			if (want === undefined || !bytesEqual(DefaultHasher.hashLeaf(e.entry), want)) {
				throw new WebtesseraError(
					"STORAGE_DAMAGED",
					`${method}: entry ${e.index} in the log's storage is not the entry its tiles commit to; the log's ` +
						"storage may be damaged: check it with log.fsck()",
					{ index: e.index },
				);
			}
			// A copy, so that keeping one entry does not keep its whole bundle in memory.
			yield { index: e.index, data: e.entry.slice() };
			if (e.index + 1n >= stop) {
				return;
			}
		}
	}

	/**
	 * #receipt builds the receipt for the entry at index, and verifies it before handing it
	 * back. A receipt that does not verify means that what the log's storage holds is not
	 * the log this process has been writing: method's error says so, without the ported
	 * check's byte dumps, which stay in its cause.
	 */
	async #receipt(
		method: string,
		index: bigint,
		cp: Uint8Array,
		leafHash: Uint8Array,
		extraData: Uint8Array | undefined,
		signal?: AbortSignal,
	): Promise<Receipt> {
		const parsed = this.#parse(cp);
		const proofs = await newProofBuilder(parsed.checkpoint.size, this.#tiles);
		const proof = new TLogProof({
			index,
			hashes: await proofs.inclusionProof(index, signal),
			checkpoint: cp,
			...(extraData === undefined ? {} : { extraData }),
		});
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
			throw diverged(method, index, parsed.checkpoint.size, err);
		}
		return newReceipt(proof, logCheckpointOf(parsed.checkpoint, cp));
	}

	#parse(cp: Uint8Array): ParsedCheckpoint {
		return parseCheckpoint(cp, this.origin, this.verifier, ...this.#witnessVerifiers);
	}

	#checkOpen(method: string): void {
		if (this.#closing !== undefined) {
			throw closed(method);
		}
	}
}

/**
 * disposable types a log as the async-disposable object it is: LogBase installs the method
 * on its prototype under the runtime's Symbol.asyncDispose, which its declaration cannot
 * name without requiring that every consumer's TypeScript lib declare the symbol.
 *
 * @internal For the log factories.
 */
export function disposable<T extends LogBase>(log: T): T & AsyncDisposableLog {
	return log as T & AsyncDisposableLog;
}

/**
 * diverged is the error for a receipt the log built for the entry at index, against its
 * checkpoint of the given size, that failed verification.
 */
function diverged(method: string, index: bigint, size: bigint, err: ReceiptError): WebtesseraError {
	const what =
		err.reason === "inclusion"
			? `its checkpoint at size ${size} does not commit to the entry at index ${index}`
			: err.reason === "witnesses"
				? `its checkpoint at size ${size} does not satisfy the log's witness policy`
				: `its checkpoint at size ${size} does not verify (${err.reason})`;
	const why =
		method === "append"
			? "The log's storage changed under this process while it appended: most likely another process is " +
				"appending to the same storage without shared locks (two processes opening one SQLite database with " +
				'locking: "single-writer", or a store whose lock does not reach the other process), and the log may ' +
				"have forked. Stop every writer but one, give every process that can reach the storage the default " +
				'locking ("lease" for a SQLite file), and check the log with log.fsck().'
			: "The log's storage is damaged, or another process wrote it without shared locks; check it with log.fsck().";
	return new WebtesseraError(
		"STORAGE_DIVERGED",
		`${method}: the receipt for entry ${index} does not verify against the log's own storage: ${what}. ${why}`,
		{ cause: err, index },
	);
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

/**
 * entriesReadAhead is how many entry bundles entries has in flight at once, the ported
 * entryBundles' numWorkers: enough to hide a read's latency, few enough that memory stays at
 * a few bundles (each at most 256 entries) however many entries are read.
 */
const entriesReadAhead = 4;

const entryBundleWidth64 = BigInt(EntryBundleWidth);

/** unbundle splits an entry bundle into its entries, for the ported client's entries. */
function unbundle(data: Uint8Array): Uint8Array[] {
	const b = new EntryBundle();
	b.unmarshalText(data);
	return b.entries;
}

/** checkEntry throws unless data is an entry a log can hold. */
function checkEntry(data: unknown, method: string): asserts data is Uint8Array {
	if (!(data instanceof Uint8Array)) {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`${method} takes the entry as a Uint8Array; encode text with new TextEncoder().encode(text)`,
		);
	}
	if (data.length > MaxEntryBytes) {
		throw new WebtesseraError(
			"ENTRY_TOO_LARGE",
			`${method}: an entry holds at most ${MaxEntryBytes} bytes, and this one is ${data.length}; log a SHA-256 ` +
				"digest of large data instead, and keep the data elsewhere",
		);
	}
}

function toIndex(index: bigint | number, method: string, name = "index"): bigint {
	if (typeof index === "bigint" && index >= 0n) {
		return index;
	}
	if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) {
		return BigInt(index);
	}
	throw new WebtesseraError(
		"INVALID_ARGUMENT",
		`${method}: the ${name} must be a non-negative integer, got ${quoteOption(index)}`,
	);
}

/** notCovered is the error for an index the latest checkpoint, of size, does not cover. */
function notCovered(method: string, index: bigint, size: bigint): WebtesseraError {
	return new WebtesseraError(
		"NOT_COVERED",
		`${method}: the latest checkpoint covers ${size === 0n ? "no entries" : `entries 0 to ${size - 1n}`}, not ${index}: ` +
			"the entry does not exist yet, or was appended moments ago (append resolves once its entry is covered)",
		{ index },
	);
}

/** closed is the error for a method called on a closed log. */
function closed(method: string): WebtesseraError {
	return new WebtesseraError("LOG_CLOSED", `${method}: this log is closed`);
}

/** checkExtraData returns extraData if a receipt can carry it, and throws otherwise. */
function checkExtraData(extraData: unknown, method: string): Uint8Array | undefined {
	if (extraData === undefined) {
		return undefined;
	}
	if (!(extraData instanceof Uint8Array)) {
		throw new WebtesseraError("INVALID_ARGUMENT", `${method}: extraData must be a Uint8Array`);
	}
	if (extraData.length > MaxExtraDataBytes) {
		throw new WebtesseraError(
			"EXTRA_DATA_TOO_LARGE",
			`${method}: a receipt carries at most ${MaxExtraDataBytes} bytes of extra data, and this is ${extraData.length}; ` +
				"longer, its extra line could not be read back",
		);
	}
	return extraData;
}

/**
 * isAbortSignal tells prove's AbortSignal argument from its ProveOptions. It looks at the
 * shape rather than using instanceof, which a signal from another realm (an iframe's, say)
 * would fail, and be taken for options without a signal.
 */
function isAbortSignal(v: unknown): v is AbortSignal {
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as AbortSignal).aborted === "boolean" &&
		typeof (v as AbortSignal).addEventListener === "function"
	);
}

function positive(v: number | undefined, def: number, name: string, where: string): number {
	if (v === undefined) {
		return def;
	}
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`${where}: ${name} must be a positive number of milliseconds, got ${quoteOption(v)}`,
		);
	}
	return v;
}

function nonNegative(v: number | undefined, def: number, name: string, where: string): number {
	if (v === undefined) {
		return def;
	}
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`${where}: ${name} must be zero or a positive number of milliseconds, got ${quoteOption(v)}`,
		);
	}
	return v;
}

/** quoteOption renders an option's value for an error message: numbers as they are, strings quoted (and never a signer key). */
function quoteOption(v: unknown): string {
	return typeof v === "string" ? quoteInput(v) : String(v);
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
