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
// Ported from tessera/fsck/fsck.go @ 4a6d9f9
//
// Port note: `Fetcher` below is fsck's *own* interface (fsck.go:37), structurally similar
// to but not the same type as anything in client.go -- it is ported on its own terms, not
// merged with client's *FetcherFunc types. `client.FetchCheckpoint`/`client.EntryBundles`
// themselves are genuinely reused, exactly as fsck.go imports and calls them.
//
// Port note: `klog.Infof`/`klog.V(n).Infof` calls are dropped throughout, extending
// docs/decisions/0051-storage-internal-drops-otel-and-klog.md's precedent to this
// package. `klog.Exitf` calls (fatal-log-then-os.Exit) that guard genuine invariant
// violations become thrown Errors with the same message text -- see
// docs/decisions/0091-fsck-translation-choices.md for the full set of translation
// decisions this file makes (the `chan resource` -> ResourceQueue design, atomic counters
// -> plain fields, compact.NodeID map keys -> string keys, the `uint8(256)` wraparound in
// `visit`, and the package-level `New` -> `newFsck` rename).

import { sha256 } from "@noble/hashes/sha2.js";
import { EntryBundleWidth, type RangeInfo, TileHeight, tilePath } from "../api/layout/index.ts";
import { HashTile } from "../api/state.ts";
import { type CheckpointFetcherFunc, type EntryBundleFetcherFunc, fetchCheckpoint } from "../client/index.ts";
import { type Bundle, entryBundles, type TreeSizeFunc } from "../client/stream.ts";
import { bytesEqual, toHex } from "../internal/gostd/bytes.ts";
import { throwIfAborted } from "../internal/gostd/errors.ts";
import { ErrGroup } from "../internal/gostd/sync.ts";
import { type Range as CompactRange, type NodeID, RangeFactory, type VisitFn } from "../vendor/merkle/compact/index.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import type { Verifier } from "../vendor/note/note.ts";
import {
	Calculating,
	FetchError,
	Fetched,
	Fetching,
	Invalid,
	newRangeTracker,
	OK,
	type Range,
	type rangeTracker,
} from "./status.ts";

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const entryBundleWidth64 = BigInt(EntryBundleWidth);

/** Fetcher describes a struct which knows how to retrieve tlog-tiles artifacts from a log. */
export interface Fetcher {
	readCheckpoint(signal?: AbortSignal): Promise<Uint8Array>;
	readTile(l: bigint, i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array>;
	readEntryBundle(i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Opts is what {@link newFsck} takes to configure a {@link Fsck} instance. */
export interface Opts {
	/** n is the number of concurrent workers to use when comparing resources. */
	readonly n?: number;
}

/** Fsck knows how to check the integrity of tlog-tile logs. */
export class Fsck {
	readonly #origin: string;
	readonly #verifier: Verifier;
	readonly #fetcher: countingFetcher;
	readonly #bundleHasher: (bundle: Uint8Array) => Uint8Array[];
	#rangeTracker: rangeTracker | undefined;
	readonly #opts: { n: number };

	#fsckTree: fsckTree | undefined;

	/** @internal Stands in for Go's `&Fsck{...}` composite literal; construct via {@link newFsck}. */
	constructor(
		origin: string,
		verifier: Verifier,
		fetcher: countingFetcher,
		bundleHasher: (bundle: Uint8Array) => Uint8Array[],
		opts: { n: number },
	) {
		this.#origin = origin;
		this.#verifier = verifier;
		this.#fetcher = fetcher;
		this.#bundleHasher = bundleHasher;
		this.#opts = opts;
		this.#rangeTracker = undefined;
		this.#fsckTree = undefined;
	}

	/**
	 * check performs an integrity check against the log.
	 *
	 * check may only be called once per instance of Fsck.
	 */
	async check(signal?: AbortSignal): Promise<void> {
		let cpSize: bigint;
		let cpHash: Uint8Array;
		try {
			const readCheckpoint: CheckpointFetcherFunc = (s) => this.#fetcher.readCheckpoint(s);
			const fetched = await fetchCheckpoint(readCheckpoint, this.#verifier, this.#origin, signal);
			cpSize = fetched.checkpoint.size;
			cpHash = fetched.checkpoint.hash;
		} catch (err) {
			throw new Error(`failed to fetch and verify checkpoint: ${errText(err)}`);
		}

		this.#rangeTracker = newRangeTracker(cpSize);

		const tree = new fsckTree({
			fetcher: this.#fetcher,
			bundleHasher: this.#bundleHasher,
			sourceSize: cpSize,
			expectedResources: new ResourceQueue(),
			rangeTracker: this.#rangeTracker,
		});
		this.#fsckTree = tree;

		// Set up a stream of entry bundles from the log to be checked.

		// Port note: Go constructs `eg := errgroup.Group{}` -- a *bare* Group, not
		// `errgroup.WithContext(ctx)` -- so upstream's workers share the caller's own
		// ctx directly and are not cancelled on each other's first error. Our
		// ErrGroup always derives and cancels its own signal on first error (a
		// documented, strictly-safer superset of a bare Group -- see
		// docs/decisions/0004-errors-context-and-concurrency.md's Consequences),
		// so threading `eg.signal` through here costs nothing and only adds safety.
		const eg = new ErrGroup(signal);

		// Kick off resource comparing workers
		for (let i = 0; i < this.#opts.n; i++) {
			eg.go(tree.resourceCheckWorker(eg.signal));
		}

		const trackBundle: EntryBundleFetcherFunc = async (
			idx: bigint,
			p: number,
			s?: AbortSignal,
		): Promise<Uint8Array> => {
			tree.rangeTracker.update(-1, idx, Fetching);
			let r: Uint8Array;
			try {
				r = await this.#fetcher.readEntryBundle(idx, p, s);
			} catch (err) {
				tree.rangeTracker.update(-1, idx, FetchError);
				throw err;
			}
			tree.rangeTracker.update(-1, idx, Fetched);
			return r;
		};

		const getSize: TreeSizeFunc = async (): Promise<bigint> => cpSize;
		// Consume the stream of bundles to re-derive the other log resources.
		// TODO(al): consider chunking the log and doing each in parallel.
		//
		// Port note: driven manually via `.next()` rather than `for await...of` so
		// that a failure fetching a bundle (wrapped below as "error while streaming
		// bundles") cannot be conflated with a failure in appendBundle (wrapped
		// separately as "failure calling appendBundle(...)") -- the two have
		// distinct error messages in Go, each from its own `if err != nil` check.
		const bundles = entryBundles(this.#opts.n, getSize, trackBundle, 0n, cpSize, eg.signal);
		for (;;) {
			let next: IteratorResult<Bundle>;
			try {
				next = await bundles.next();
			} catch (err) {
				throw new Error(`error while streaming bundles: ${errText(err)}`);
			}
			if (next.done === true) {
				break;
			}
			const b = next.value;
			tree.rangeTracker.update(-1, b.rangeInfo.index, OK);
			try {
				tree.appendBundle(b.rangeInfo, b.data);
			} catch (err) {
				throw new Error(`failure calling appendBundle(${rangeInfoText(b.rangeInfo)}): ${errText(err)}`);
			}
			if (tree.tree.end() >= cpSize) {
				break;
			}
			// Port addition: bound the number of derived resources buffered ahead of
			// the resourceCheckWorkers. Go gets this for free from `chan resource`'s
			// fixed buffer size; ResourceQueue.push cannot block (it's called from the
			// synchronous VisitFn), so check() applies the same bound here instead, at
			// the one point in the loop that *can* await. See ResourceQueue.waitUntilBelow
			// and docs/decisions/0091-fsck-translation-choices.md.
			await tree.expectedResources.waitUntilBelow(resourceBackpressureThreshold(this.#opts.n), eg.signal);
		}

		// Ensure we see process any partial tiles too.
		tree.flushPartialTiles();
		// Signal that there will be no more resource checking jobs coming so workers can exit when the channel is drained.
		tree.expectedResources.close();

		// Wait for all the work to be done.
		try {
			await eg.wait();
		} catch (err) {
			throw new Error(`failed: ${errText(err)}`);
		}

		// Finally, check that the claimed root hash matches what we calculated.
		let gotRoot: Uint8Array;
		try {
			gotRoot = tree.getRootHash();
		} catch (err) {
			throw new Error(`failed to calculate root: ${errText(err)}`);
		}
		if (!bytesEqual(gotRoot, cpHash)) {
			throw new Error(`calculated root ${toHex(gotRoot)}, but checkpoint claims ${toHex(cpHash)}`);
		}
	}

	/** status returns a struct representing the current status of the fsck operation. */
	status(): Status {
		if (this.#rangeTracker === undefined) {
			return new Status();
		}
		const { entries, tiles } = this.#rangeTracker.ranges();
		const fetcher = (this.#fsckTree as fsckTree).fetcher;
		const bytesFetched = fetcher._bytesFetched;
		fetcher._bytesFetched = 0n;
		const resourcesFetched = fetcher._resourcesFetched;
		fetcher._resourcesFetched = 0n;
		const errorsEncountered = fetcher._errorsEncountered;
		fetcher._errorsEncountered = 0n;
		return new Status({
			entryRanges: entries,
			tileRanges: tiles,
			bytesFetched,
			resourcesFetched,
			errorsEncountered,
		});
	}
}

/**
 * rangeInfoText renders a RangeInfo the way Go's default `%v` verb formats a struct:
 * `{index partial first n}`, in declaration order.
 */
function rangeInfoText(ri: RangeInfo): string {
	return `{${ri.index} ${ri.partial} ${ri.first} ${ri.n}}`;
}

/**
 * newFsck creates a new Fsck instance configured for a particular log.
 *
 * The log resources will be retrieved via the provided fetcher, using the provided
 * bundleHasher to parse and convert entries from the log's entry bundles into leaf hashes.
 *
 * The leaf hashes are used to:
 * 1. re-construct the root hash of the log, and compare it against the value in the log's checkpoint
 * 2. re-construct the internal tiles of the log, and compare them against the log's tile resources.
 *
 * The checking will use the provided N parameter to control the number of concurrent workers undertaking
 * this process.
 *
 * Port note: Go's package-level `New` collides with the reserved word `new` once
 * camelCased; renamed `newFsck`, matching this codebase's `new<Type>` factory convention.
 * See docs/decisions/0091-fsck-translation-choices.md.
 */
export function newFsck(
	origin: string,
	verifier: Verifier,
	f: Fetcher,
	bundleHasher: (bundle: Uint8Array) => Uint8Array[],
	opts: Opts,
): Fsck {
	const n = opts.n === undefined || opts.n === 0 ? 1 : opts.n;
	return new Fsck(origin, verifier, newCountingFetcher(f), bundleHasher, { n });
}

/** Status represents the current status of an ongoing fsck check. */
export class Status {
	/** entryRanges describes the status of the entrybundles in the target log. */
	entryRanges: Range[];
	/**
	 * tileRanges describes the status of the tiles in the target log.
	 * The zeroth entry in the slice represents the lower-most tile level, just above the entry bundles.
	 */
	tileRanges: Range[][];
	/** bytesFetched is the total number of bytes fetched from the target log since the last time status() was called. */
	bytesFetched: bigint;
	/** resourcesFetched is the total number of resources fetched from the target log since the last time status() was called. */
	resourcesFetched: bigint;
	/** errorsEncountered is the total number of errors encountered since the last time status() was called. */
	errorsEncountered: bigint;

	constructor(init?: {
		entryRanges?: Range[];
		tileRanges?: Range[][];
		bytesFetched?: bigint;
		resourcesFetched?: bigint;
		errorsEncountered?: bigint;
	}) {
		this.entryRanges = init?.entryRanges ?? [];
		this.tileRanges = init?.tileRanges ?? [];
		this.bytesFetched = init?.bytesFetched ?? 0n;
		this.resourcesFetched = init?.resourcesFetched ?? 0n;
		this.errorsEncountered = init?.errorsEncountered ?? 0n;
	}

	toString(): string {
		const ret: string[] = [];
		for (let i = this.tileRanges.length - 1; i >= 0; i--) {
			const l: string[] = [];
			for (const tr of this.tileRanges[i] as Range[]) {
				l.push(tr.toString());
			}
			ret.push(`Tiles/${i}: `);
			ret.push(l.join(", "));
		}
		const l: string[] = [];
		for (const tr of this.entryRanges) {
			l.push(tr.toString());
		}
		ret.push("EntryBdl: ");
		ret.push(l.join(", "));
		return ret.join("\n");
	}
}

/**
 * resource represents a single static tile resource on the log, and the derived content we expect it to contain.
 *
 * Port note: unexported in Go (`resource`), but constructed directly by upstream's own
 * fsck_test.go (`resource{partial: 10, content: makeTile(10)}`). Exported per
 * docs/decisions/0010-package-private-members.md; not re-exported from
 * `src/fsck/index.ts`.
 */
export interface resource {
	level: bigint;
	index: bigint;
	partial: number;
	content: Uint8Array;
}

/**
 * ResourceQueue is fsck.ts's stand-in for `chan resource`, used to hand derived tile
 * resources from the (synchronous) tree-visiting code to the (async) resourceCheckWorkers.
 * Has no Go counterpart -- see docs/decisions/0091-fsck-translation-choices.md for why a
 * bounded *channel* cannot be reproduced here (`push` is called from the synchronous
 * `VisitFn`, which cannot `await`), and for the loop-level backpressure `check()` applies
 * instead via `waitUntilBelow` to bound memory the way Go's buffered channel does.
 *
 * Multiple resourceCheckWorkers `pull` concurrently (fan-out); each pushed resource is
 * delivered to exactly one puller, matching a Go channel's semantics. Constructed and
 * driven directly by upstream's own fsck_test.go (`make(chan resource, 1)`, `f.expectedResources <- test.r`, `close(...)`).
 */
export class ResourceQueue {
	readonly #items: resource[] = [];
	readonly #waiters: ((r: resource | null) => void)[] = [];
	readonly #drainWaiters: (() => void)[] = [];
	#closed = false;

	/** size is the number of items currently buffered and not yet pulled. */
	get size(): number {
		return this.#items.length;
	}

	/** push enqueues r, waking one waiting consumer if any. Never blocks. */
	push(r: resource): void {
		if (this.#closed) {
			throw new Error("ResourceQueue: push on a closed queue");
		}
		const waiter = this.#waiters.shift();
		if (waiter !== undefined) {
			waiter(r);
			return;
		}
		this.#items.push(r);
	}

	/** close signals that no more items will be pushed. */
	close(): void {
		this.#closed = true;
		// Port note: `splice(0)` both drains and returns the waiters in one step.
		// Capturing `this.#waiters` by reference and then truncating it via
		// `.length = 0` would empty the very array being iterated below, since
		// both names would refer to the same backing array -- a real bug caught by
		// the fixture-backed check() integration tests (a since-corrected earlier
		// draft of this method left every worker but one waiting forever).
		const waiters = this.#waiters.splice(0);
		for (const w of waiters) {
			w(null);
		}
		this.#releaseDrainWaiters();
	}

	/**
	 * pull resolves with the next item, or null once the queue is closed and
	 * drained -- the equivalent of `r, ok := <-ch` with `ok == false`.
	 */
	async pull(): Promise<resource | null> {
		const item = this.#items.shift();
		if (item !== undefined) {
			// A slot just freed up: wake anyone in waitUntilBelow so the producer
			// (check()'s bundle loop) can resume pushing.
			this.#releaseDrainWaiters();
			return item;
		}
		if (this.#closed) {
			return null;
		}
		return new Promise<resource | null>((resolve) => {
			this.#waiters.push(resolve);
		});
	}

	/**
	 * waitUntilBelow resolves once `size < threshold`, or resolves immediately if it
	 * already is. This is the port's substitute for the back-pressure a bounded Go
	 * channel gives for free: `check()`'s producer loop awaits this between bundles so
	 * that, however slowly the resourceCheckWorkers drain the queue (e.g. because a
	 * malicious or merely slow server stalls `readTile` while still answering
	 * `readEntryBundle` promptly), the number of buffered-but-unchecked resources never
	 * grows past `threshold` -- capping memory at O(threshold) instead of the O(log
	 * size) it would otherwise reach. See docs/decisions/0091-fsck-translation-choices.md.
	 *
	 * `signal`, if given, both aborts the wait early (mirroring every other cancellable
	 * wait in this port, ADR-0004) and -- critically -- unblocks the producer if the
	 * *consumers* all fail: `check()` passes `eg.signal`, which `ErrGroup` aborts on the
	 * resourceCheckWorkers' first error, so a producer parked here can never deadlock
	 * against a fully-dead worker pool; it will observe the abort and the caller's
	 * `await eg.wait()` then surfaces the real error.
	 */
	async waitUntilBelow(threshold: number, signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (this.#items.length < threshold) {
			return;
		}
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				const idx = this.#drainWaiters.indexOf(onDrain);
				if (idx !== -1) {
					this.#drainWaiters.splice(idx, 1);
				}
				reject(signal?.reason);
			};
			const onDrain = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			this.#drainWaiters.push(onDrain);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	#releaseDrainWaiters(): void {
		if (this.#drainWaiters.length === 0) {
			return;
		}
		const waiters = this.#drainWaiters.splice(0);
		for (const w of waiters) {
			w();
		}
	}
}

/**
 * resourceBackpressureThreshold returns the buffered-resource cap ResourceQueue.push
 * is allowed to reach before check()'s producer loop pauses. Scaled to the worker
 * count (with a small floor so a `n: 1` check still has room to pipeline) rather than
 * a single global constant, so increasing concurrency doesn't shrink each worker's
 * effective lookahead. Not a Go value -- Go's equivalent is `cap(chan resource)`,
 * which fsck.go sets to a fixed literal at the call site; see ADR-0091.
 */
export function resourceBackpressureThreshold(numWorkers: number): number {
	return Math.max(numWorkers * 4, 16);
}

const compactRangeFactory = new RangeFactory((l: Uint8Array, r: Uint8Array) => DefaultHasher.hashChildren(l, r));

/** pendingTileEntry pairs a tile-in-progress with the tile-space coordinates it lives at. */
interface pendingTileEntry {
	level: number;
	index: bigint;
	tile: HashTile;
}

/**
 * pendingTileKey renders a tile-space (level, index) pair as a Map key.
 *
 * Port note: Go keys `pendingTiles` by `compact.NodeID{Level, Index}` directly, relying on
 * Go's structural map-key equality. A JavaScript Map compares object keys by reference, so
 * this port uses a composite string key instead, following
 * docs/decisions/0050-storage-internal-map-keys-and-callback-types.md's precedent (and
 * client.ts's `tileCacheKey`, the same technique for the same reason). The map's value
 * carries the (level, index) back out, exactly as ADR-0050 recommends, since `visit` and
 * `flushPartialTiles` both need to recover them from the key alone -- Go gets that for
 * free from the struct key, this port stores it alongside the tile instead.
 */
function pendingTileKey(level: number, index: bigint): string {
	return `${level}:${index}`;
}

/**
 * fsckTree represents the tree we're currently checking.
 *
 * Port note: unexported in Go (`fsckTree`), but constructed directly by upstream's own
 * fsck_test.go. Exported per docs/decisions/0010-package-private-members.md; not
 * re-exported from `src/fsck/index.ts`. The constructor here takes an init object with
 * `bundleHasher`/`sourceSize`/`pendingTiles` optional (defaulted), because Go's
 * `&fsckTree{expectedResources: ..., fetcher: ..., rangeTracker: ...}` composite literal
 * leaves the rest at their zero values -- exactly what upstream's own
 * TestTrimFullToPartial does -- and TypeScript classes have no zero-value equivalent for
 * fields a caller chooses not to set.
 */
export class fsckTree {
	/** fetcher knows how to retrieve static tlog-tile resources. */
	fetcher: countingFetcher;
	/** bundleHasher knows how to convert entry bundles into leaf hashes. */
	bundleHasher: (bundle: Uint8Array) => Uint8Array[];
	/** tree contains the running state of the leaves we've appended so far. */
	tree: CompactRange;
	/** sourceSize is the size of the source log we're checking. */
	sourceSize: bigint;

	/**
	 * pendingTiles holds tlog-tile structs which we are currently populating, but which we haven't yet
	 * verified.
	 * Entries are removed from this map once they either a) become fully populated, or b) flushPartialTiles is called.
	 */
	pendingTiles: Map<string, pendingTileEntry>;

	/**
	 * expectedResources is a queue of derived tlog resources which need to be verified against the source log's static resources.
	 * Entries in this queue are consumed by the resourceCheckWorker functions.
	 */
	expectedResources: ResourceQueue;

	rangeTracker: rangeTracker;

	/** @internal Stands in for Go's `&fsckTree{...}` composite literal. */
	constructor(init: {
		fetcher: countingFetcher;
		rangeTracker: rangeTracker;
		expectedResources: ResourceQueue;
		bundleHasher?: (bundle: Uint8Array) => Uint8Array[];
		sourceSize?: bigint;
		pendingTiles?: Map<string, pendingTileEntry>;
	}) {
		this.fetcher = init.fetcher;
		this.rangeTracker = init.rangeTracker;
		this.expectedResources = init.expectedResources;
		this.bundleHasher =
			init.bundleHasher ??
			(() => {
				throw new Error("fsckTree: bundleHasher not set");
			});
		this.sourceSize = init.sourceSize ?? 0n;
		this.pendingTiles = init.pendingTiles ?? new Map();
		this.tree = compactRangeFactory.newEmptyRange(0n);
	}

	/** appendBundle appends leaf hashes from the provided entry bundle. */
	appendBundle(ri: RangeInfo, data: Uint8Array): void {
		const impliedSeq = ri.index * entryBundleWidth64 + BigInt(ri.first);
		if (impliedSeq !== this.tree.end()) {
			throw new Error(`bundle with implied sequence number ${impliedSeq} but expected ${this.tree.end()}`);
		}

		const hs = this.bundleHasher(data);
		for (let i = ri.first; i < ri.first + ri.n; i++) {
			this.tree.append(hs[i] as Uint8Array, this.visit);
		}
	}

	getRootHash(): Uint8Array {
		if (this.tree.end() === 0n) {
			return DefaultHasher.emptyRoot();
		}
		// Port note: `this.tree` always has `begin() === 0n` (constructed via
		// compactRangeFactory.newEmptyRange(0n) and only ever extended, never
		// re-based), and `end() !== 0n` here implies its hashes are non-empty, so
		// neither of getRootHash's two non-success outcomes (the `begin != 0` throw,
		// the empty-range `null`) can occur in this call path. See
		// merkle/compact/range.go's GetRootHash for the two conditions this
		// reasons about.
		const root = this.tree.getRootHash(null);
		if (root === null) {
			throw new Error("fsckTree.getRootHash: empty range after non-zero end");
		}
		return root;
	}

	/**
	 * visit is used to populate the derived tiles as we consume entries from the log we're checking.
	 *
	 * Port note: an arrow-function class field rather than a regular method, so that
	 * `this.tree.append(hs[i], this.visit)` in appendBundle above passes an
	 * already-bound callback -- the direct equivalent of Go's `f.visit` method value,
	 * which auto-binds its receiver when used as a value.
	 *
	 * Port note: unlike `storage/internal/integrate.go`'s `tileWriteCache.Visitor`
	 * (docs/decisions/0052-tilewritecache-visitor-is-synchronous.md), this visitor
	 * never needs to read anything -- it only accumulates in-memory state and enqueues
	 * work for the async resourceCheckWorkers to fetch and compare later -- so no
	 * prewarm/cache-only-fallback machinery is needed here. See
	 * docs/decisions/0092-fsck-visitor-has-no-io-adr-0052-does-not-apply.md.
	 */
	visit: VisitFn = (id: NodeID, h: Uint8Array): void => {
		// We're only storing the lowest level of hash in the tiles, so early-out in other cases.
		if (id.level % TileHeight !== 0) {
			return;
		}
		const tLevel = id.level / TileHeight;
		const tIdx = id.index / entryBundleWidth64;
		const hIdx = id.index % entryBundleWidth64;
		const key = pendingTileKey(tLevel, tIdx);
		let entry = this.pendingTiles.get(key);
		if (entry === undefined) {
			entry = { level: tLevel, index: tIdx, tile: new HashTile() };
			this.pendingTiles.set(key, entry);
		}
		const t = entry.tile;
		if (hIdx !== BigInt(t.nodes.length)) {
			// Port note: Go's `klog.Exitf` (log then os.Exit(255)) on this genuine
			// invariant violation. There is no process to exit on the edge or in a
			// browser tab, so this throws with the same message text instead.
			throw new Error(
				`LOGIC ERROR: got tile (l: ${tLevel}, idx: ${tIdx}) node index ${hIdx}, for tile with ${t.nodes.length} nodes`,
			);
		}
		t.nodes.push(h);
		if (t.nodes.length === EntryBundleWidth) {
			// Port note: HashTile.marshalText never throws in this port (see
			// api/state.ts's own port note), so the `err != nil` branch Go guards
			// this with (another klog.Exitf) is unreachable here and not ported.
			const c = t.marshalText();
			this.expectedResources.push({
				level: BigInt(tLevel),
				index: tIdx,
				// Port note: Go's `uint8(len(t.Nodes))` here is `uint8(256)`, which
				// *wraps* to 0 -- not truncation-as-bug but the tlog-tiles
				// convention itself: partial == 0 means "full tile". t.nodes.length
				// is exactly EntryBundleWidth (256) by the `if` above, so `% 256`
				// reproduces the same wrap explicitly. See
				// docs/decisions/0091-fsck-translation-choices.md.
				partial: t.nodes.length % 256,
				content: c,
			});
			this.pendingTiles.delete(key);
		}
	};

	/**
	 * flushPartialTiles ensures that any remaining derived tiles, which due to the size of the tree are partial, are also flushed to the
	 * expectedResources work queue.
	 */
	flushPartialTiles(): void {
		for (const [key, entry] of this.pendingTiles) {
			const c = entry.tile.marshalText();
			this.expectedResources.push({
				level: BigInt(entry.level),
				index: entry.index,
				partial: entry.tile.nodes.length,
				content: c,
			});
			this.pendingTiles.delete(key);
		}
	}

	/**
	 * resourceCheckWorker returns a func which will consume resource check jobs from the
	 * expectedResources queue.
	 *
	 * Port note: `resourceWorkerID`/the `id` debug label are dropped along with the
	 * `klog.V(2).Infof` call that was their only use.
	 */
	resourceCheckWorker(signal?: AbortSignal): () => Promise<void> {
		return async (): Promise<void> => {
			for (let r = await this.expectedResources.pull(); r !== null; r = await this.expectedResources.pull()) {
				this.rangeTracker.update(Number(r.level), r.index, Fetching);
				let data: Uint8Array;
				try {
					data = await this.fetcher.readTile(r.level, r.index, r.partial, signal);
				} catch (err) {
					this.rangeTracker.update(Number(r.level), r.index, FetchError);
					throw err;
				}
				this.rangeTracker.update(Number(r.level), r.index, Calculating);
				const l = data.length;
				const e = r.partial * sha256.outputLen;
				if (r.partial !== 0 && l > e) {
					// We were likely given a full tile rather than a partial tile, so trim it to the expected size.
					data = data.subarray(0, e);
				}
				const p = tilePath(r.level, r.index, r.partial);
				if (!bytesEqual(data, r.content)) {
					this.rangeTracker.update(Number(r.level), r.index, Invalid);
					throw new Error(`${p}: log has:\n${toHex(data)}\nexpected:\n${toHex(r.content)}`);
				}
				this.rangeTracker.update(Number(r.level), r.index, OK);
			}
		};
	}
}

/** countingFetcher is a Fetcher which keeps track of the total number of bytes and resources fetched. */
export class countingFetcher {
	readonly #f: Fetcher;
	/** @internal */
	_bytesFetched = 0n;
	/** @internal */
	_resourcesFetched = 0n;
	/** @internal */
	_errorsEncountered = 0n;

	constructor(f: Fetcher) {
		this.#f = f;
	}

	async #count(fn: () => Promise<Uint8Array>): Promise<Uint8Array> {
		let r: Uint8Array;
		try {
			r = await fn();
		} catch (err) {
			this._errorsEncountered++;
			throw err;
		}
		this._bytesFetched += BigInt(r.length);
		this._resourcesFetched++;
		return r;
	}

	readCheckpoint(signal?: AbortSignal): Promise<Uint8Array> {
		return this.#count(() => this.#f.readCheckpoint(signal));
	}

	readEntryBundle(i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return this.#count(() => this.#f.readEntryBundle(i, p, signal));
	}

	readTile(l: bigint, i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return this.#count(() => this.#f.readTile(l, i, p, signal));
	}
}

/** newCountingFetcher wraps f so that fetched bytes/resources/errors are counted. */
export function newCountingFetcher(f: Fetcher): countingFetcher {
	return new countingFetcher(f);
}
