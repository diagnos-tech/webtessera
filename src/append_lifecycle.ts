// Copyright 2024 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/append_lifecycle.go @ 4a6d9f9
//
// Port note: the OpenTelemetry metric setup (append_lifecycle.go:39-210 — the metric vars,
// histogramBuckets, and the init() that wires them) and every `.Record`/`.Add` metric emission,
// plus otel.go's tracer/meter and every klog.* call, are dropped from this port. See
// docs/decisions/0080-append-lifecycle-otel-and-klog.md, which extends the precedent set by
// docs/decisions/0051-storage-internal-drops-otel-and-klog.md and 0061-otel-tracing-dropped.md.
// The sampling/latency data structures (idxAt, integrationStats, followerStats) are ported as
// logic; only their metric emission is removed — that ADR records exactly which parts were kept.

import { newInMemoryDedup } from "./antispam.ts";
import * as layout from "./api/layout/index.ts";
import type { FetchFn } from "./client/fetcher.ts";
import type { Entry } from "./entry.ts";
import { fromUTF8 } from "./internal/gostd/bytes.ts";
import { ErrNotExist, errorIs, throwIfAborted, wrapError } from "./internal/gostd/errors.ts";
import { quote } from "./internal/gostd/strconv.ts";
import { sleep, ticker } from "./internal/gostd/sync.ts";
import { checkpointUnsafe } from "./internal/parse/parse.ts";
import { newWitnessGateway, PolicyNotSatisfiedError } from "./internal/witness/witness.ts";
import { type Antispam, defaultIDHasher, type Follower, type LogReader } from "./lifecycle.ts";
import type { Driver } from "./log.ts";
import { Checkpoint } from "./vendor/formats/log/index.ts";
import { DefaultHasher } from "./vendor/merkle/rfc6962/rfc6962.ts";
import { type Note, type Signer, sign } from "./vendor/note/note.ts";
import { WitnessGroup } from "./witness.ts";

/** DefaultBatchMaxSize is used by storage implementations if no WithBatching option is provided when instantiating it. */
export const DefaultBatchMaxSize = 256;
/** DefaultBatchMaxAge is used by storage implementations if no WithBatching option is provided when instantiating it. */
export const DefaultBatchMaxAge = 250; // ms (Go: 250 * time.Millisecond)
/** DefaultCheckpointInterval is used by storage implementations if no WithCheckpointInterval option is provided when instantiating it. */
export const DefaultCheckpointInterval = 10_000; // ms (Go: 10 * time.Second)
/** DefaultCheckpointRepublishInterval is used by storage implementations if no WithCheckpointRepublishInterval option is provided when instantiating it. */
export const DefaultCheckpointRepublishInterval = 600_000; // ms (Go: 10 * time.Minute)
/** DefaultPushbackMaxOutstanding is used by storage implementations if no WithPushback option is provided when instantiating it. */
export const DefaultPushbackMaxOutstanding = 4096;
/** DefaultGarbageCollectionInterval is the default value used if no WithGarbageCollectionInterval option is provided. */
export const DefaultGarbageCollectionInterval = 60_000; // ms (Go: time.Minute)
/**
 * DefaultAntispamInMemorySize is the recommended default limit on the number of entries in the in-memory antispam cache.
 * The amount of data stored for each entry is small (32 bytes of hash + 8 bytes of index), so in the general case it should be fine
 * to have a very large cache.
 */
export const DefaultAntispamInMemorySize = 256 << 10;
/** DefaultWitnessTimeout is the default maximum time to wait for responses from configured witnesses. */
export const DefaultWitnessTimeout = 5_000; // ms (Go: 5 * time.Second)

/**
 * AddFn adds a new entry to be sequenced by the storage implementation.
 *
 * This method should quickly return an IndexFuture, which can be called to resolve to the
 * index **durably** assigned to the new entry (or an error).
 *
 * Implementations MUST NOT allow the future to resolve to an index value unless/until it has
 * been durably committed by the storage.
 *
 * Callers MUST NOT assume that an entry has been accepted or durably stored until they have
 * successfully resolved the future.
 *
 * Once the future resolves and returns an index, the entry can be considered to have been
 * durably sequenced and will be preserved even in the event that the process terminates.
 *
 * Once an entry is sequenced, the storage implementation MUST integrate it into the tree soon
 * (how long this is expected to take is left unspecified, but as a guideline it should happen
 * within single digit seconds). Until the entry is integrated and published, clients of the log
 * will not be able to verifiably access this value.
 *
 * Personalities which require blocking until the entry is integrated (e.g. because they wish
 * to return an inclusion proof) may use the PublicationAwaiter to wrap the call to this method.
 *
 * Port note: `ctx context.Context` moves to an optional trailing `signal` parameter, per
 * docs/decisions/0004-errors-context-and-concurrency.md.
 */
export type AddFn = (entry: Entry, signal?: AbortSignal) => IndexFuture;

/**
 * IndexFuture is the signature of a function which can return an assigned index or error.
 *
 * Implementations of this func are likely to be "futures", or a promise to return this data at
 * some point in the future, and as such will block when called if the data isn't yet available.
 *
 * Port note: Go returns `(Index, error)`; the port throws instead of returning the error
 * (docs/decisions/0004-errors-context-and-concurrency.md), and "will block when called"
 * becomes an `await` on the returned Promise, since JavaScript cannot block a thread.
 */
export type IndexFuture = () => Promise<Index>;

/** Index represents a durably assigned index for some entry. */
export interface Index {
	/** index is the location in the log to which a particular entry has been assigned. */
	readonly index: bigint;
	/** isDup is true if index represents a previously assigned index for an identical entry. */
	readonly isDup: boolean;
}

/**
 * Appender allows personalities access to the lifecycle methods associated with logs
 * in sequencing mode. This only has a single method, but other methods are likely to be added
 * such as a Shutdown method for #341.
 */
export class Appender {
	/** add is the AddFn used to append new leaves to the log. */
	add: AddFn;

	constructor(add: AddFn) {
		this.add = add;
	}
}

/**
 * AppendLifecycle is the interface a Driver must satisfy to support Appender mode.
 *
 * Port note: Go declares this as an unexported interface local to NewAppender and type-asserts
 * the driver against it (`d.(appendLifecycle)`). TypeScript has no method-set type assertion, so
 * this is a named interface plus the isAppendLifecycle runtime guard below; it is exported so
 * storage drivers have a name to implement against.
 */
export interface AppendLifecycle {
	appender(opts: AppendOptions, signal?: AbortSignal): Promise<AppenderInit>;
}

/**
 * AppenderInit is what a Driver's appender() method returns.
 *
 * Port note: Go returns `(*Appender, LogReader, error)` positionally; a named readonly object is
 * used per docs/decisions/0031-multi-value-returns.md.
 */
export interface AppenderInit {
	readonly appender: Appender;
	readonly reader: LogReader;
}

/**
 * NewAppenderResult is what newAppender returns.
 *
 * Port note: Go returns `(*Appender, func(ctx) error, LogReader, error)` positionally; the trailing
 * error becomes a throw (docs/decisions/0004) and the remaining three values become a named
 * readonly object per docs/decisions/0031-multi-value-returns.md.
 */
export interface NewAppenderResult {
	readonly appender: Appender;
	readonly shutdown: (signal?: AbortSignal) => Promise<void>;
	readonly reader: LogReader;
}

function isAppendLifecycle(d: Driver): d is AppendLifecycle {
	return d !== null && d !== undefined && typeof (d as { appender?: unknown }).appender === "function";
}

/**
 * newAppender returns an Appender, which allows a personality to incrementally append new
 * leaves to the log and to read from it.
 *
 * The return values are the Appender for adding new entries, a shutdown function, a log reader,
 * and (via a throw) an error if any of the objects couldn't be constructed.
 *
 * shutdown ensures that all calls to add that have returned a value will be resolved. Any
 * futures returned by _this appender_ which resolve to an index will be integrated and have
 * a checkpoint that commits to them published if this returns successfully. After this returns,
 * any calls to add will fail.
 *
 * The signal passed into this function will be referenced by any background tasks that are started
 * in the Appender. The correct process for shutting down an Appender cleanly is to first call the
 * shutdown function that is returned, and then abort the signal. Aborting the signal without calling
 * shutdown first may mean that some entries added by this appender aren't in the log when the process
 * exits.
 */
export async function newAppender(
	d: Driver,
	opts: AppendOptions | null,
	signal?: AbortSignal,
): Promise<NewAppenderResult> {
	if (!isAppendLifecycle(d)) {
		throw new Error(`driver ${typeName(d)} does not implement Appender lifecycle`);
	}
	if (opts === null) {
		throw new Error("opts cannot be nil");
	}
	opts.valid();
	let init: AppenderInit;
	try {
		init = await d.appender(opts, signal);
	} catch (err) {
		throw new Error(`failed to init appender lifecycle: ${messageOf(err)}`);
	}
	const a = init.appender;
	const r = init.reader;
	for (let i = opts.addDecorators.length - 1; i >= 0; i--) {
		const dec = opts.addDecorators[i];
		if (dec !== undefined) {
			a.add = dec(a.add);
		}
	}
	const sd = new integrationStats();
	a.add = sd.statsDecorator(a.add);
	// Background lifetime is bound to `signal`; when absent, a never-aborting signal stands in for
	// Go's context.Background()-style unbounded lifetime.
	const bgSignal = signal ?? new AbortController().signal;
	for (const f of opts.followers) {
		f.follow(r, bgSignal);
		void followerStats(f, (s?: AbortSignal) => r.integratedSize(s), bgSignal);
	}
	void sd.updateStats(r, bgSignal);
	const t = new terminator(a.add, (s?: AbortSignal) => r.readCheckpoint(s));
	// TODO(mhutchinson): move this into the decorators
	a.add = (entry: Entry, sig?: AbortSignal): IndexFuture => {
		// NOTE: We memoize the returned value here so that repeated calls to the returned
		//		 future don't result in unexpected side-effects from inner AddFn functions
		//		 being called multiple times.
		//		 Currently this is the outermost wrapping of add so we do the memoization
		//		 here, if this changes, ensure that we move the memoization call so that
		//		 this remains true.
		return memoizeFuture(t.add(entry, sig));
	};
	return { appender: a, shutdown: (s?: AbortSignal) => t.shutdown(s), reader: r };
}

/**
 * memoizeFuture wraps an IndexFuture delegate with logic to ensure that the delegate is called at
 * most once.
 *
 * Port note: Go uses `sync.OnceValues`, which caches the `(Index, error)` result. A native Promise
 * already caches its own resolution (value or rejection) and shares it among all callers, so
 * memoizing the Promise returned by the first `delegate()` call gives the identical "called at most
 * once" contract, including for concurrent callers.
 */
export function memoizeFuture(delegate: IndexFuture): IndexFuture {
	let promise: Promise<Index> | undefined;
	return (): Promise<Index> => {
		promise ??= delegate();
		return promise;
	};
}

/**
 * followerStats periodically samples a follower's progress against the integrated tree size.
 *
 * Port note: with OTel emission dropped (ADR-0080), the two `.Record` calls that reported
 * `EntriesProcessed` and the lag (`size - processed`) are removed, along with `f.Name()` and the
 * attributes, which fed only those metrics and the (dropped) klog error logging. What remains is
 * the poll loop itself, ported faithfully; it currently has no observable effect until metric
 * emission is restored. Go: `func followerStats(ctx, f, size)`.
 */
async function followerStats(
	f: Follower,
	size: (signal?: AbortSignal) => Promise<bigint>,
	signal: AbortSignal,
): Promise<void> {
	await ticker(200, signal, async () => {
		try {
			await f.entriesProcessed(signal);
		} catch {
			// Go: klog.Errorf(...); continue
			return;
		}
		try {
			await size(signal);
		} catch {
			// Go: klog.Errorf(...)
		}
		// OTel emission (followerEntriesProcessed / followerLag) dropped per ADR-0080.
	});
}

/** idxAt represents an index first seen at a particular time. */
interface idxAt {
	readonly idx: bigint;
	/** at is the epoch-millis timestamp the sample was taken (Go: time.Time from time.Now()). */
	readonly at: number;
}

/**
 * integrationStats knows how to track integration performance.
 *
 * Currently, this tracks integration latency only.
 * The integration latency tracking works via a "sample & consume" mechanism, whereby an add decorator
 * will record an assigned index along with the time it was assigned. An asynchronous process will
 * periodically compare the sample with the current integrated tree size, and if the sampled index is
 * found to be covered by the tree the elapsed period is recorded and the sample "consumed".
 *
 * Only one sample may be held at a time.
 *
 * Port note: Go emits the computed latency to OTel; that emission is dropped (ADR-0080). The
 * sample/consume data structure and its timing logic are kept, exactly as ported below.
 */
class integrationStats {
	// indexSample points to a sampled idxAt, or undefined if there has been no sample made _or_ the sample was consumed.
	//
	// Port note: Go uses atomic.Pointer for cross-goroutine safety; JavaScript is single-threaded and
	// runs to completion, so a plain nullable field with a synchronous compare-and-set is sufficient
	// and no atomic/lock is needed (docs/decisions/0004-errors-context-and-concurrency.md).
	#indexSample: idxAt | undefined = undefined;

	/** sample creates a new sample with the provided index if no sample is already held. */
	sample(idx: bigint): void {
		// Go: i.indexSample.CompareAndSwap(nil, &idxAt{...}) — set only if currently empty.
		if (this.#indexSample === undefined) {
			this.#indexSample = { idx, at: Date.now() };
		}
	}

	/**
	 * latency will check whether the provided tree size is larger than the currently sampled index (if one exists),
	 * and, if so, "consume" the sample and return the elapsed interval since the sample was taken.
	 *
	 * The returned bool is true if a sample exists and whose index is lower than the provided tree size, and
	 * false otherwise.
	 *
	 * Port note: returns `[durationMs, ok]`; Go returns `(time.Duration, bool)`.
	 */
	latency(size: bigint): [number, boolean] {
		const ia = this.#indexSample;
		// If there _is_ a sample...
		if (ia !== undefined) {
			// and the sampled index is lower than the tree size
			if (ia.idx < size) {
				// then reset the sample store here so that we're able to accept a future sample.
				this.#indexSample = undefined;
			}
			return [Date.now() - ia.at, true];
		}
		return [0, false];
	}

	/**
	 * updateStats periodically checks the current integrated tree size and attempts to
	 * consume any held sample.
	 *
	 * This is a long running function, exiting only when the provided signal is aborted.
	 *
	 * Port note: the `appenderIntegratedSize`/`appenderIntegrateLatency`/`appenderNextIndex`
	 * emissions are dropped (ADR-0080). The reads and the sample-consuming `latency(s)` call are
	 * kept, as they are the behavioural half of the sample/consume mechanism.
	 */
	async updateStats(r: LogReader | undefined, signal: AbortSignal): Promise<void> {
		if (r === undefined) {
			// Go: klog.Warning("updateStates: nil logreader provided, not updating stats")
			return;
		}
		await ticker(100, signal, async () => {
			let s: bigint;
			try {
				s = await r.integratedSize(signal);
			} catch {
				// Go: klog.Errorf("IntegratedSize: %v", err); continue
				return;
			}
			// appenderIntegratedSize.Record dropped per ADR-0080.
			// The elapsed duration fed only the (dropped) appenderIntegrateLatency metric; the call
			// is kept for its sample-consuming side effect.
			this.latency(s);
			try {
				await r.nextIndex(signal);
			} catch {
				// Go: klog.Errorf("NextIndex: %v", err)
			}
			// appenderNextIndex.Record dropped per ADR-0080.
		});
	}

	/**
	 * statsDecorator wraps a delegate AddFn with code to update integration stats.
	 *
	 * Port note: the add-count/duration metric emission and the pushback/error attribute
	 * bucketing are dropped (ADR-0080). Only the success-path sampling survives. Go additionally
	 * samples index 0 on the error path (a consequence of `idx` being the zero Index when
	 * `err != nil`); the throw model rethrows before reaching the sample line, so the port does
	 * not — an unobservable difference given the emission is dropped.
	 */
	statsDecorator(delegate: AddFn): AddFn {
		return (entry: Entry, signal?: AbortSignal): IndexFuture => {
			const f = delegate(entry, signal);

			return async (): Promise<Index> => {
				const idx = await f();
				if (!idx.isDup) {
					this.sample(idx.index);
				}
				return idx;
			};
		};
	}
}

class terminator {
	readonly #delegate: AddFn;
	readonly #readCheckpoint: (signal?: AbortSignal) => Promise<Uint8Array>;

	// Port note: Go guards `stopped` with a sync.RWMutex so that no in-flight Add setup can
	// interleave with Shutdown. Both terminator.add's body and the synchronous prefix of
	// terminator.shutdown (setting stopped and reading largestIssued) contain no `await`, so under
	// JavaScript's run-to-completion semantics they cannot interleave, and per
	// docs/decisions/0004-errors-context-and-concurrency.md no lock is required: an add can never
	// observe a half-applied shutdown. The atomic.Uint64 largestIssued likewise collapses to a plain
	// field, updated with a synchronous compare-and-set.
	#stopped = false;
	// largestIssued tracks the largest index allocated by this appender.
	#largestIssued = 0n;

	constructor(delegate: AddFn, readCheckpoint: (signal?: AbortSignal) => Promise<Uint8Array>) {
		this.#delegate = delegate;
		this.#readCheckpoint = readCheckpoint;
	}

	add(entry: Entry, signal?: AbortSignal): IndexFuture {
		if (this.#stopped) {
			return async (): Promise<Index> => {
				throw new Error("appender has been shut down");
			};
		}
		const res = this.#delegate(entry, signal);
		return async (): Promise<Index> => {
			const i = await res();
			// https://github.com/golang/go/issues/63999 - atomically set largest issued index
			if (this.#largestIssued < i.index) {
				this.#largestIssued = i.index;
			}
			// appenderHighestIndex.Record dropped per ADR-0080.
			return i;
		};
	}

	/**
	 * shutdown ensures that all calls to add that have returned a value will be resolved. Any
	 * futures returned by _this appender_ which resolve to an index will be integrated and have
	 * a checkpoint that commits to them published if this returns successfully.
	 *
	 * After this returns, any calls to add will fail.
	 */
	async shutdown(signal?: AbortSignal): Promise<void> {
		this.#stopped = true;
		const maxIndex = this.#largestIssued;
		if (maxIndex === 0n) {
			// special case no work done
			return;
		}
		let sleepTimeMs = 0;
		for (;;) {
			// select { case <-ctx.Done(): return ctx.Err(); default: time.Sleep(sleepTime) }
			throwIfAborted(signal);
			await sleep(sleepTimeMs, signal);
			sleepTimeMs = 100; // after the first time, ensure we sleep in any other loops

			let cp: Uint8Array;
			try {
				cp = await this.#readCheckpoint(signal);
			} catch (err) {
				if (!errorIs(err, ErrNotExist)) {
					throw err;
				}
				continue;
			}
			const { size } = checkpointUnsafe(cp);
			// Go: klog.V(1).Infof("Shutting down, waiting for checkpoint committing to size %d ...")
			if (size > maxIndex) {
				return;
			}
		}
	}
}

/**
 * newAppendOptions creates a new options struct for configuring appender lifecycle instances.
 *
 * These options are configured through the use of the various `with*` method calls on the returned
 * instance.
 *
 * Port note: Go's `AppendOptions{...}` composite defaults are applied by the AppendOptions
 * constructor (the only supported construction path, matching how Go callers always go through
 * NewAppendOptions rather than the bare zero value); this factory mirrors Go's NewAppendOptions.
 */
export function newAppendOptions(): AppendOptions {
	return new AppendOptions();
}

/** AppendOptions holds settings for all storage implementations. */
export class AppendOptions {
	// newCP knows how to format and sign checkpoints. undefined until WithCheckpointSigner is called
	// (Go: nil func).
	//
	// Port note: Go's `func(ctx, size, hash) ([]byte, error)` is synchronous work (marshal + sign)
	// whose only use of ctx was the dropped tracer span, so it is a synchronous throwing function
	// here rather than an async one.
	#newCP: ((size: bigint, hash: Uint8Array) => Uint8Array) | undefined;

	#batchMaxAge: number; // ms
	#batchMaxSize: number;

	#pushbackMaxOutstanding: number;

	/**
	 * _entriesPath knows how to format entry bundle paths.
	 *
	 * Port note: `_`-prefixed + `@internal` per docs/decisions/0010-package-private-members.md
	 * because the exported accessor entriesPath() collides with the field name, and because
	 * ct_only.ts's WithCTLayout overrides this field cross-module (mirroring Go's cross-file
	 * package-private access from ct_only.go).
	 * @internal
	 */
	_entriesPath: (n: bigint, p: number) => string;
	/**
	 * bundleIDHasher knows how to create antispam leaf identities for entries in a serialised bundle.
	 *
	 * Port note: public (Go: unexported) because it is read cross-module by ct_only.ts's WithCTLayout,
	 * as ct_only.go reads it cross-file within the package.
	 */
	bundleIDHasher: (bundle: Uint8Array) => Uint8Array[];

	#checkpointInterval: number; // ms
	#checkpointRepublishInterval: number; // ms

	#witnesses: WitnessGroup;
	#witnessOpts: WitnessOptions;

	/**
	 * addDecorators is the ordered list of AddFn middleware to apply.
	 *
	 * Port note: public (Go: unexported) because newAppender, a module-level function, reads it;
	 * a `#private` field would be unreachable from outside the class body.
	 */
	addDecorators: ((fn: AddFn) => AddFn)[];
	/** followers is the list of Followers to run against the log (Go: unexported; public for newAppender). */
	followers: Follower[];

	// garbageCollectionInterval of zero should be interpreted as requesting garbage collection to be disabled.
	#garbageCollectionInterval: number; // ms

	constructor() {
		this.#newCP = undefined;
		this.#batchMaxSize = DefaultBatchMaxSize;
		this.#batchMaxAge = DefaultBatchMaxAge;
		this._entriesPath = layout.entriesPath;
		this.bundleIDHasher = defaultIDHasher;
		this.#checkpointInterval = DefaultCheckpointInterval;
		this.#checkpointRepublishInterval = DefaultCheckpointRepublishInterval;
		this.addDecorators = [];
		this.#pushbackMaxOutstanding = DefaultPushbackMaxOutstanding;
		this.#garbageCollectionInterval = DefaultGarbageCollectionInterval;
		// Go leaves these at their zero value; new WitnessGroup()/WitnessOptions() are those zero values.
		this.#witnesses = new WitnessGroup();
		this.#witnessOpts = new WitnessOptions();
		this.followers = [];
	}

	/**
	 * valid throws if an invalid combination of options has been set, and returns normally otherwise.
	 *
	 * Port note: Go returns an error; the port throws (docs/decisions/0004). The `%d` durations in
	 * Go print the time.Duration nanosecond count; here they print the millisecond values this port
	 * stores (docs/decisions/0004-errors-context-and-concurrency.md's Duration→ms mapping).
	 */
	valid(): void {
		if (this.#newCP === undefined) {
			throw new Error("invalid AppendOptions: WithCheckpointSigner must be set");
		}
		if (this.#checkpointRepublishInterval > 0 && this.#checkpointRepublishInterval < this.#checkpointInterval) {
			throw new Error(
				`invalid AppendOptions: WithCheckpointRepublishInterval (${this.#checkpointRepublishInterval}) is smaller than WithCheckpointInterval (${this.#checkpointInterval})`,
			);
		}
	}

	/**
	 * withAntispam configures the appender to use the antispam mechanism to reduce the number of duplicates which
	 * can be added to the log.
	 *
	 * As a starting point, the minimum size of the of in-memory cache should be set to the configured PushbackThreshold
	 * of the provided antispam implementation, multiplied by the number of concurrent front-end instances which
	 * are accepting write-traffic. Data stored in the in-memory cache is relatively small (32 bytes hash, 8 bytes index),
	 * so we recommend erring on the larger side as there is little downside to over-sizing the cache; consider using
	 * the DefaultAntispamInMemorySize as the value here.
	 *
	 * For more details on how the antispam mechanism works, including tuning guidance, see docs/design/antispam.md.
	 */
	withAntispam(inMemEntries: number, as: Antispam | null): AppendOptions {
		this.addDecorators.push(newInMemoryDedup(inMemEntries));
		if (as !== null) {
			this.addDecorators.push(as.decorator());
			this.followers.push(as.follower(this.bundleIDHasher));
		}
		return this;
	}

	/** checkpointPublisher returns a function which should be used to create, sign, and potentially witness a new checkpoint. */
	checkpointPublisher(
		lr: LogReader,
		httpClient: FetchFn,
	): (size: bigint, root: Uint8Array, signal?: AbortSignal) => Promise<Uint8Array> {
		return async (size: bigint, root: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> => {
			if (this.#newCP === undefined) {
				// Unreachable when valid() has been enforced (WithCheckpointSigner must be set).
				throw new Error("newCP: WithCheckpointSigner must be set");
			}
			let cp: Uint8Array;
			try {
				cp = this.#newCP(size, root);
			} catch (err) {
				throw new Error(`newCP: ${messageOf(err)}`);
			}
			// appenderSignedSize.Record dropped per ADR-0080.

			// Handle witnessing
			{
				// Figure out the likely size the witnesses are aware of, but don't fail hard if we're unable
				// to do so:
				// a) it could be that this is the first checkpoint we're publishing
				// b) the witnessing protocol has a fallback path in case we get it wrong, anyway.
				let oldSize = 0n;
				let oldCP: Uint8Array | undefined;
				try {
					oldCP = await lr.readCheckpoint(signal);
				} catch {
					// Go: klog.Infof("Failed to fetch old checkpoint: %v", err)
					oldCP = undefined;
				}
				if (oldCP !== undefined) {
					try {
						oldSize = checkpointUnsafe(oldCP).size;
					} catch (err) {
						throw new Error(`failed to parse old checkpoint: ${messageOf(err)}`);
					}
				}
				const wg = newWitnessGateway(
					this.#witnesses,
					httpClient,
					oldSize,
					(level: bigint, index: bigint, p: number, s?: AbortSignal) => lr.readTile(level, index, p, s),
				);

				// context.WithTimeout(ctx, o.witnessOpts.Timeout)
				const timeoutSignal = AbortSignal.timeout(this.#witnessOpts.timeout);
				const witnessSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

				try {
					cp = await wg.witness(cp, witnessSignal);
				} catch (err) {
					if (!this.#witnessOpts.failOpen) {
						// appenderWitnessRequests.Add(error) dropped per ADR-0080.
						throw err;
					}
					// Go: klog.Warningf("WitnessGateway: failing-open despite error: %v", err).
					// Fail open: Go reassigns cp to whatever wg.Witness returned even on error — the
					// partial (under-cosigned) checkpoint for a policy failure, or nil for an early
					// failure (bad checkpoint / proof builder). Mirror that: recover the partial
					// checkpoint where the error carries one, else fall back to an empty checkpoint as
					// Go's nil return would (see ADR-0082).
					cp = err instanceof PolicyNotSatisfiedError ? err.checkpoint : new Uint8Array(0);
				}
				// appenderWitnessRequests / appenderWitnessedSize / appenderWitnessHistogram emission dropped per ADR-0080.
			}

			return cp;
		};
	}

	batchMaxAge(): number {
		return this.#batchMaxAge;
	}

	batchMaxSize(): number {
		return this.#batchMaxSize;
	}

	pushbackMaxOutstanding(): number {
		return this.#pushbackMaxOutstanding;
	}

	entriesPath(): (n: bigint, p: number) => string {
		return this._entriesPath;
	}

	checkpointInterval(): number {
		return this.#checkpointInterval;
	}

	checkpointRepublishInterval(): number {
		return this.#checkpointRepublishInterval;
	}

	garbageCollectionInterval(): number {
		return this.#garbageCollectionInterval;
	}

	/**
	 * withCheckpointSigner is an option for setting the note signer and verifier to use when creating and parsing checkpoints.
	 * This option is mandatory for creating logs where the checkpoint is signed locally, e.g. in
	 * the Appender mode. This does not need to be provided where the storage will be used to mirror
	 * other logs.
	 *
	 * A primary signer must be provided:
	 * - the primary signer is the "canonical" signing identity which should be used when creating new checkpoints.
	 *
	 * Zero or more dditional signers may also be provided.
	 * This enables cases like:
	 *   - a rolling key rotation, where checkpoints are signed by both the old and new keys for some period of time,
	 *   - using different signature schemes for different audiences, etc.
	 *
	 * When providing additional signers, their names MUST be identical to the primary signer name, and this name will be used
	 * as the checkpoint Origin line.
	 *
	 * Checkpoints signed by these signer(s) will be standard checkpoints as defined by https://c2sp.org/tlog-checkpoint.
	 */
	withCheckpointSigner(s: Signer, ...additionalSigners: Signer[]): AppendOptions {
		const origin = s.name();
		for (const signer of additionalSigners) {
			if (origin !== signer.name()) {
				// Port note: Go calls klog.Exitf (log-and-exit) here — a fatal misconfiguration guard,
				// not mere logging — so it becomes a throw rather than being dropped with the other klog
				// calls (ADR-0080).
				throw new Error(
					`WithCheckpointSigner: additional signer name (${quote(signer.name())}) does not match primary signer name (${quote(origin)})`,
				);
			}
		}
		this.#newCP = (size: bigint, hash: Uint8Array): Uint8Array => {
			// If we're signing a zero-sized tree, the tlog-checkpoint spec says (via RFC6962) that
			// the root must be SHA256 of the empty string, so we'll enforce that here:
			let h = hash;
			if (size === 0n) {
				h = DefaultHasher.emptyRoot();
			}
			const cpRaw = new Checkpoint({ origin, size, hash: h }).marshal();

			const n: Note = { text: fromUTF8(cpRaw) };
			try {
				return sign(n, s, ...additionalSigners);
			} catch (err) {
				throw wrapError("note.Sign", err);
			}
		};
		return this;
	}

	/**
	 * withBatching configures the batching behaviour of leaves being sequenced.
	 * A batch will be allowed to grow in memory until either:
	 *   - the number of entries in the batch reach maxSize
	 *   - the first entry in the batch has reached maxAge
	 *
	 * At this point the batch will be sent to the sequencer.
	 *
	 * Configuring these parameters allows the personality to tune to get the desired
	 * balance of sequencing latency with cost. In general, larger batches allow for
	 * lower cost of operation, where more frequent batches reduce the amount of time
	 * required for entries to be included in the log.
	 *
	 * If this option isn't provided, storage implementations with use the DefaultBatchMaxSize and DefaultBatchMaxAge consts above.
	 */
	withBatching(maxSize: number, maxAgeMs: number): AppendOptions {
		this.#batchMaxSize = maxSize;
		this.#batchMaxAge = maxAgeMs;
		return this;
	}

	/**
	 * withPushback allows configuration of when the storage should start pushing back on add requests.
	 *
	 * maxOutstanding is the number of "in-flight" add requests - i.e. the number of entries with sequence numbers
	 * assigned, but which are not yet integrated into the log.
	 */
	withPushback(maxOutstanding: number): AppendOptions {
		this.#pushbackMaxOutstanding = maxOutstanding;
		return this;
	}

	/**
	 * withCheckpointInterval configures the frequency at which Tessera will attempt to create & publish
	 * new checkpoints.
	 *
	 * Well behaved clients of the log will only "see" newly sequenced entries once a new checkpoint is published,
	 * so it's important to set that value such that it works well with your ecosystem.
	 *
	 * Regularly publishing new checkpoints:
	 *   - helps show that the log is "live", even if no entries are being added.
	 *   - enables clients of the log to reason about how frequently they need to have their
	 *     view of the log refreshed, which in turn helps reduce work/load across the ecosystem.
	 *
	 * Note that this option probably only makes sense for long-lived applications (e.g. HTTP servers).
	 *
	 * If this option isn't provided, storage implementations will use the DefaultCheckpointInterval const above.
	 */
	withCheckpointInterval(intervalMs: number): AppendOptions {
		this.#checkpointInterval = intervalMs;
		return this;
	}

	/**
	 * withCheckpointRepublishInterval configures the frequency at which Tessera will allow re-publishing
	 * checkpoints where the log hasn't grown since the last checkpoint was published.
	 *
	 * Setting this less than or equal to zero will disable republication of unchanged checkpoints.
	 */
	withCheckpointRepublishInterval(intervalMs: number): AppendOptions {
		this.#checkpointRepublishInterval = intervalMs;
		return this;
	}

	/**
	 * withWitnesses configures the set of witnesses that Tessera will contact in order to counter-sign
	 * a checkpoint before publishing it. A request will be sent to every witness referenced by the group
	 * using the URLs method. The checkpoint will be accepted for publishing when a sufficient number of
	 * witnesses to Satisfy the group have responded.
	 *
	 * If this method is not called, then the default empty WitnessGroup will be used, which contacts zero
	 * witnesses and requires zero witnesses in order to publish.
	 */
	withWitnesses(witnesses: WitnessGroup, opts: WitnessOptions | null): AppendOptions {
		let o = opts;
		if (o === null) {
			o = new WitnessOptions();
		}
		if (o.timeout === 0) {
			o.timeout = DefaultWitnessTimeout;
		}

		this.#witnesses = witnesses;
		// Go copies by value (`o.witnessOpts = *opts`); mirror that with a fresh WitnessOptions.
		this.#witnessOpts = new WitnessOptions({ timeout: o.timeout, failOpen: o.failOpen });
		return this;
	}

	/**
	 * withGarbageCollectionInterval allows the interval between scans to remove obsolete partial
	 * tiles and entry bundles.
	 *
	 * Setting to zero disables garbage collection.
	 *
	 * Port note: Go declares WitnessOptions between WithWitnesses and this method; TypeScript requires
	 * methods inside the class body, so WitnessOptions follows the class below.
	 */
	withGarbageCollectionInterval(intervalMs: number): AppendOptions {
		this.#garbageCollectionInterval = intervalMs;
		return this;
	}
}

/**
 * WitnessOptions contains extra optional configuration for how Tessera should use/interact with
 * a user-provided WitnessGroup policy.
 */
export class WitnessOptions {
	/**
	 * timeout is the maximum time to wait while attempting to satisfy the configured witness policy.
	 *
	 * If the policy has not already been satisfied at the point this duration has passed, Tessera
	 * will stop waiting for more responses. The failOpen option below controls whether or not the
	 * checkpoint will be published in this case.
	 *
	 * If unset (0), uses DefaultWitnessTimeout.
	 */
	timeout: number; // ms

	/**
	 * failOpen controls whether a checkpoint, for which the witness policy was unable to be met,
	 * should still be published.
	 *
	 * This setting is intended only for facilitating early "non-blocking" adoption of witnessing,
	 * and will be disabled and/or removed in the future.
	 */
	failOpen: boolean;

	constructor(init?: { timeout?: number; failOpen?: boolean }) {
		this.timeout = init?.timeout ?? 0;
		this.failOpen = init?.failOpen ?? false;
	}
}

/** typeName renders a value's dynamic type the way Go's `%T` verb does (best effort). */
function typeName(d: unknown): string {
	if (d === null) {
		return "<nil>";
	}
	if (typeof d === "object") {
		return d.constructor?.name ?? typeof d;
	}
	return typeof d;
}

// messageOf renders a caught value the way Go's `%v` renders an error (no wrapping).
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
