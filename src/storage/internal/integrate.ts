// Copyright 2024 Google LLC. All Rights Reserved.
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
//
// Ported from tessera/storage/internal/integrate.go @ 4a6d9f9
//
// Port note: every OpenTelemetry span/attribute and every klog debug log line from the Go
// source is dropped. Neither has any TypeScript counterpart anywhere in this port (no
// other file imports an OTel or klog shim), storage/internal/otel.go itself is out of
// scope for this work package, and PORTING.md §7 restricts donatable dependencies to
// `@noble/*`. See docs/decisions/0051-storage-internal-drops-otel-and-klog.md.

import { nodeCoordsToTileAddress, partialTileSize, TileWidth, tilePath } from "../../api/layout/index.ts";
import { HashTile } from "../../api/state.ts";
import { asUint64, shiftLeft64 } from "../../internal/gostd/bits.ts";
import { bytesEqual } from "../../internal/gostd/bytes.ts";
import { joinErrors, wrapError } from "../../internal/gostd/errors.ts";
import {
	type NodeID,
	newNodeID,
	type Range,
	RangeFactory,
	rangeNodes,
	type VisitFn,
} from "../../vendor/merkle/compact/index.ts";
import { DefaultHasher } from "../../vendor/merkle/rfc6962/rfc6962.ts";
import { TileID, tileIDKey } from "./tileid.ts";

// Port note: layout.TileWidth is exported as `number` (ADR-0030); the bigint companion
// mirrors tile.ts's own `tileWidth64`, used wherever Go's uint64 arithmetic needs it.
const tileWidth64 = BigInt(TileWidth);

/** SequencedEntry represents a log entry which has already been sequenced. */
export interface SequencedEntry {
	/** bundleData is the entry's data serialised into the correct format for appending to an entry bundle. */
	bundleData: Uint8Array;
	/** leafHash is the entry's Merkle leaf hash. */
	leafHash: Uint8Array;
}

/**
 * GetTilesFunc fetches tiles from storage. Implementations must return tiles in the same
 * order as the provided tileIDs, substituting undefined for any tiles which were not found.
 *
 * Port note: Go leaves this func type anonymous, repeating the same signature at each of
 * its four use sites (Integrate's param, newTreeBuilder's param, tileReadCache.getTiles's
 * field type, and newTileReadCache's param). It is named here purely for readability and
 * is not upstream API surface. See
 * docs/decisions/0050-storage-internal-map-keys-and-callback-types.md.
 */
export type GetTilesFunc = (
	tileIDs: readonly TileID[],
	treeSize: bigint,
	signal?: AbortSignal,
) => Promise<(HashTile | undefined)[]>;

/**
 * IntegrateResult is what integrate returns.
 *
 * Port note: Go returns four values positionally (`newSize uint64, rootHash []byte, tiles
 * map[TileID]*api.HashTile, err error`); see docs/decisions/0031-multi-value-returns.md.
 * `tiles` uses tileIDKey(id) as its Map key rather than TileID itself — see
 * docs/decisions/0050-storage-internal-map-keys-and-callback-types.md — and carries the
 * TileID alongside its tile as the value, so callers (storage drivers) have both without
 * re-parsing the key. Go's nil-vs-empty-map distinction for "nothing to integrate" is not
 * reproduced: a nil map and an empty map range identically in Go, so no caller can
 * observe the difference, and `tiles` here is always a Map, sometimes empty.
 */
export interface IntegrateResult {
	readonly newSize: bigint;
	readonly rootHash: Uint8Array;
	readonly tiles: ReadonlyMap<string, { readonly id: TileID; readonly tile: HashTile }>;
}

export async function integrate(
	getTiles: GetTilesFunc,
	fromSize: bigint,
	leafHashes: readonly Uint8Array[],
	signal?: AbortSignal,
): Promise<IntegrateResult> {
	const tb = newTreeBuilder(getTiles);
	return tb.integrate(fromSize, leafHashes, signal);
}

/**
 * getPopulatedTileFunc is the signature of a function which can return a fully populated tile for the given tile coords.
 *
 * Port note: Go's version takes a ctx and returns `(*populatedTile, error)`. The port
 * drops both: see the treeBuilder Port note below for why this can be a plain synchronous
 * lookup with no error channel in this package.
 */
type getPopulatedTileFunc = (tileID: TileID, treeSize: bigint) => populatedTile | undefined;

/**
 * treeBuilder constructs Merkle trees.
 *
 * This struct it indended to be used by storage implementations during the integration of entries into the log.
 * treeBuilder caches data from tiles to speed things up, but has no mechanism for evicting from its internal cache,
 * so while it _may_ be possible to use the same instance across a number of integration runs (e.g. if the same job
 * is responsible for integrating entries for a number of contiguous trees), the lifetime should be bounded so as not
 * to leak memory.
 *
 * Port note: Go's `compact.VisitFn` (src/vendor/merkle/compact/range.ts, landed and
 * reviewed in Wave 1) is synchronous — `(id: NodeID, hash: Uint8Array) => void`, no
 * Promise — because Go's goroutines can block on I/O mid-callback where JavaScript
 * cannot. `tileWriteCache`'s Visitor (below) sometimes needs to fetch a tile that already
 * exists on disk (when integration extends a partial tile from a previous run), and in Go
 * that fetch happens synchronously inside the callback via `tileReadCache.Get`.
 *
 * This port instead relies on an invariant that already holds in Go's own data flow:
 * `integrate()` always calls `newRange(fromSize)` — which fully warms `readCache` for
 * every tile implied by `compact.RangeNodes(0, fromSize, nil)`, using the *same* fromSize
 * — before constructing the write-cache's Visitor. Any tile the Visitor's fallback path
 * can need (`minImpliedTreeSize(tileID) <= fromSize`) shares its cache key
 * (`tilePath(level, index, partialTileSize(level, index, fromSize))`) with a tile that
 * prewarm already fetched, because a tile groups every Merkle node at its levels and
 * index range into one unit: any node from the pre-integration tree's frontier that
 * shares a tile with a node the Visitor later touches was already fetched. So by the
 * time the Visitor runs, the read cache is guaranteed to already hold whatever it needs —
 * the fetch is only ever a cache lookup, never new I/O — and `tileReadCache.peek` gives
 * synchronous access to that already-warm cache, letting `getPopulatedTileFunc` be a
 * plain synchronous function instead of an async one the (synchronous) VisitFn could
 * never await. This is verified end-to-end by integrate_test.ts's golden-fixture test,
 * which resumes integration from a non-zero fromSize (255→256→257) specifically to
 * exercise this fallback path against real, byte-verified Tessera output. See
 * docs/decisions/0052-tilewritecache-visitor-is-synchronous.md.
 *
 * Port note: exported, along with tileWriteCache and populatedTile below, even though
 * Go's equivalents are unexported. `integrate_test.go` is an in-package test that reaches
 * them directly (`newTreeBuilder`, `tb.newRange`, `newTileWriteCache`, `twc.Visitor`,
 * `memTileStore[populatedTile]`); TypeScript has no package-private visibility, so
 * `integrate_test.ts` needs the same reachability via a module export. None of these are
 * re-exported from any package barrel, so they stay off the published API surface — the
 * same pattern docs/decisions/0044-ct-only-partial-port.md used for ct_only.go's
 * unexported bundle parsers.
 */
export class treeBuilder {
	private readonly readCache: tileReadCache;
	private readonly rf: RangeFactory;

	constructor(readCache: tileReadCache, rf: RangeFactory) {
		this.readCache = readCache;
		this.rf = rf;
	}

	/** newRange creates a new compact.Range for the specified treeSize, fetching tiles as necessary. */
	async newRange(treeSize: bigint, signal?: AbortSignal): Promise<Range> {
		const nodes = rangeNodesFor(treeSize);
		const toFetch = new Map<string, TileID>();
		for (const id of nodes) {
			const { tileLevel, tileIndex } = nodeCoordsToTileAddress(BigInt(id.level), id.index);
			const tid = new TileID(tileLevel, tileIndex);
			toFetch.set(tileIDKey(tid), tid);
		}
		try {
			await this.readCache.prewarm([...toFetch.values()], treeSize, signal);
		} catch (err) {
			throw new Error(`Prewarm: ${messageOf(err)}`);
		}

		const hashes: Uint8Array[] = [];
		for (const id of nodes) {
			const { tileLevel, tileIndex, nodeLevel, nodeIndex } = nodeCoordsToTileAddress(BigInt(id.level), id.index);
			const ft = await this.readCache.get(new TileID(tileLevel, tileIndex), treeSize, signal);
			const h = ft.get(newNodeID(nodeLevel, nodeIndex));
			if (h === undefined) {
				throw new Error(`missing node: [${id.level}/${id.index}@${treeSize}]`);
			}
			hashes.push(h);
		}
		return this.rf.newRange(0n, treeSize, hashes);
	}

	async integrate(fromSize: bigint, leafHashes: readonly Uint8Array[], signal?: AbortSignal): Promise<IntegrateResult> {
		const baseRange = await this.newRange(fromSize, signal).catch((err: unknown) => {
			throw wrapError("failed to create range covering existing log", err);
		});

		// Initialise a compact range representation, and verify the stored state.
		let r: Uint8Array | null;
		try {
			r = baseRange.getRootHash(null);
		} catch (err) {
			throw wrapError("invalid log state, unable to recalculate root", err);
		}
		if (leafHashes.length === 0) {
			// C2SP.org/log-tiles says all Merkle operations are those from RFC6962, we need to override
			// the root of the empty tree to match (compact.Range will return an empty slice).
			if (fromSize === 0n) {
				r = DefaultHasher.emptyRoot();
			}
			// Nothing to do, nothing done.
			return { newSize: fromSize, rootHash: r as Uint8Array, tiles: new Map() };
		}

		// Create a new compact range which represents the update to the tree
		const newRange = this.rf.newEmptyRange(fromSize);
		const tc = newTileWriteCache(fromSize, (tileID, treeSize) => this.readCache.peek(tileID, treeSize));
		const visitor = tc.visitor();
		for (const e of leafHashes) {
			// Update range and set nodes
			try {
				newRange.append(e, visitor);
			} catch (err) {
				throw new Error(`newRange.Append(): ${messageOf(err)}`);
			}
		}
		// Check whether the visitor had any problems building the update range
		const errAfterAppend = tc.err();
		if (errAfterAppend !== undefined) {
			throw errAfterAppend;
		}

		// Merge the update range into the old tree
		try {
			baseRange.appendRange(newRange, visitor);
		} catch (err) {
			throw wrapError("failed to merge new range onto existing log", err);
		}

		// Check whether the visitor had any problems when merging the new range into the tree
		const errAfterMerge = tc.err();
		if (errAfterMerge !== undefined) {
			throw errAfterMerge;
		}

		// Calculate the new root hash - don't pass in the tileCache visitor here since
		// this will construct any ephemeral nodes and we do not want to store those.
		let newRoot: Uint8Array | null;
		try {
			newRoot = baseRange.getRootHash(null);
		} catch (err) {
			throw wrapError("failed to calculate new root hash", err);
		}

		// All calculation is now complete, all that remains is to store the new
		// tiles and updated log state.
		return { newSize: baseRange.end(), rootHash: newRoot as Uint8Array, tiles: tc.tiles() };
	}
}

/** newTreeBuilder creates a new instance of treeBuilder. */
export function newTreeBuilder(getTiles: GetTilesFunc): treeBuilder {
	const readCache = newTileReadCache(getTiles);
	return new treeBuilder(readCache, new RangeFactory((l, r) => DefaultHasher.hashChildren(l, r)));
}

/**
 * rangeNodesFor is `compact.RangeNodes(0, treeSize, nil)`, named to avoid clashing with
 * this file's own `treeBuilder.newRange`.
 */
function rangeNodesFor(treeSize: bigint): NodeID[] {
	return rangeNodes(0n, treeSize, []);
}

/**
 * tileReadCache is a structure which provides a very simple thread-safe read-through cache based on a map of tiles.
 *
 * Port note: "thread-safe" in Go means guarded by a mutex for concurrent goroutines.
 * JavaScript is single-threaded, and every method here is synchronous except where it
 * awaits `getTiles` — a critical section that stays synchronous needs no lock at all
 * (docs/decisions/0004-errors-context-and-concurrency.md), so none is taken.
 */
class tileReadCache {
	private readonly entries = new Map<string, populatedTile>();
	private readonly getTiles: GetTilesFunc;

	constructor(getTiles: GetTilesFunc) {
		this.getTiles = getTiles;
	}

	/** get returns a previously set tile and true, or, if no such tile is in the cache, attempt to fetch it. */
	async get(tileID: TileID, treeSize: bigint, signal?: AbortSignal): Promise<populatedTile> {
		const k = tilePath(tileID.level, tileID.index, partialTileSize(tileID.level, tileID.index, treeSize));
		let e = this.entries.get(k);
		if (e === undefined) {
			const t = await this.getTiles([tileID], treeSize, signal);
			try {
				e = newPopulatedTile(t[0]);
			} catch (err) {
				throw new Error(`failed to create fulltile: ${messageOf(err)}`);
			}
			this.entries.set(k, e);
		}
		return e;
	}

	/**
	 * prewarm fills the cache by fetching the given tileIDs.
	 *
	 * Throws if any of the tiles couldn't be fetched.
	 */
	async prewarm(tileIDs: readonly TileID[], treeSize: bigint, signal?: AbortSignal): Promise<void> {
		const t = await this.getTiles(tileIDs, treeSize, signal);
		for (let i = 0; i < t.length; i++) {
			let e: populatedTile;
			try {
				e = newPopulatedTile(t[i]);
			} catch (err) {
				throw new Error(`failed to create fulltile: ${messageOf(err)}`);
			}
			const id = tileIDs[i] as TileID;
			const k = tilePath(id.level, id.index, partialTileSize(id.level, id.index, treeSize));
			this.entries.set(k, e);
		}
	}

	/**
	 * peek returns a tile already present in the cache, or undefined if it has not been
	 * fetched. It never fetches. See the treeBuilder Port note for why this is safe to use
	 * as tileWriteCache's synchronous getTile fallback.
	 *
	 * Port note: has no counterpart in Go — see
	 * docs/decisions/0052-tilewritecache-visitor-is-synchronous.md.
	 */
	peek(tileID: TileID, treeSize: bigint): populatedTile | undefined {
		const k = tilePath(tileID.level, tileID.index, partialTileSize(tileID.level, tileID.index, treeSize));
		return this.entries.get(k);
	}
}

/** newTileReadCache creates a new instance of tileReadCache. */
function newTileReadCache(getTiles: GetTilesFunc): tileReadCache {
	return new tileReadCache(getTiles);
}

/**
 * tileWriteCache is a simple cache for storing the newly created tiles produced by
 * the integration of new leaves into the tree.
 *
 * Calls to visitor() cause the map of tiles to become filled with the set of
 * `dirty` tiles which need to be flushed back to storage to preserve the updated
 * tree state.
 *
 * Note that by itself, this cache does not update any persisted state.
 */
export class tileWriteCache {
	private readonly m = new Map<string, populatedTile>();
	private readonly ids = new Map<string, TileID>();
	private readonly errs: unknown[] = [];

	private readonly treeSize: bigint;
	private readonly getTile: getPopulatedTileFunc;

	/** newTileWriteCache creates a new cache for the given treeSize, and uses the provided function to fetch existing tiles which are being updated by the Visitor func. */
	constructor(treeSize: bigint, getTile: getPopulatedTileFunc) {
		this.treeSize = treeSize;
		this.getTile = getTile;
	}

	/**
	 * err returns an aggregated view of any errors seen by the visitor function.
	 *
	 * This can be used to check whether updates to the tile cache made by the visitor
	 * were made correctly. Any errors returned here are most likely to be due to
	 * the cache attempting to read an existing tile which is being updated.
	 */
	err(): Error | undefined {
		return joinErrors(this.errs);
	}

	/**
	 * visitor returns a function suitable for use with the compact.Range visitor pattern.
	 *
	 * The returned function is expected to be called sequentially to set one or nodes
	 * to their corresponding hash values.
	 */
	visitor(): VisitFn {
		return (id: NodeID, hash: Uint8Array): void => {
			const { tileLevel, tileIndex, nodeLevel, nodeIndex } = nodeCoordsToTileAddress(BigInt(id.level), id.index);
			const tileID = new TileID(tileLevel, tileIndex);
			const key = tileIDKey(tileID);
			let tile = this.m.get(key);
			if (tile === undefined) {
				// If this tile implies a larger tree size than we started integrating at, we don't
				// need to try to fetch the tile since it probably doesn't exist.
				// If it _does_ exist, e.g. due to an earlier crash during integration, we'll discover
				// any non-idempotency issues when we come to flush these new tiles out.
				if (minImpliedTreeSize(tileID) <= this.treeSize) {
					try {
						tile = this.getTile(tileID, this.treeSize);
					} catch (err) {
						this.errs.push(err);
						return;
					}
				}
				if (tile === undefined) {
					// No tile found in storage: this is a brand new tile being created due to tree growth.
					tile = newPopulatedTile(undefined);
				}
			}
			this.m.set(key, tile);
			this.ids.set(key, tileID);
			// Update the tile with the new node hash.
			tile.set(newNodeID(nodeLevel, nodeIndex), hash);
		};
	}

	/**
	 * tiles returns all visited tiles.
	 *
	 * Port note: Go's `leaves [][]byte` can, in principle, hold nil entries for slots
	 * `Set` never reached, and `api.HashTile{Nodes: t.leaves}` copies that nil-tolerant
	 * slice straight into a `HashTile`; Go's `bytes.Buffer.Write(nil)` then writes zero
	 * bytes for it, silently producing an undersized tile. `HashTile.nodes` is typed
	 * `Uint8Array[]` here (Wave 1, api/state.ts) with no such escape hatch, so a genuine
	 * gap is rejected loudly instead of silently mis-sized. In practice this is
	 * unreachable: `compact.Range.append`/`appendRange` only ever visit leaf indices in
	 * sequential order starting from the tile's first unset slot, so `leaves` has no
	 * internal gaps by construction — see the treeBuilder Port note above.
	 */
	tiles(): Map<string, { id: TileID; tile: HashTile }> {
		const newTiles = new Map<string, { id: TileID; tile: HashTile }>();
		for (const [k, t] of this.m) {
			const leaves = t.leaves.map((l, i) => {
				if (l === undefined) {
					throw new Error(`populatedTile has an unset leaf at index ${i} in tile ${k}`);
				}
				return l;
			});
			newTiles.set(k, { id: this.ids.get(k) as TileID, tile: new HashTile(leaves) });
		}
		return newTiles;
	}
}

/** newTileWriteCache creates a new cache for the given treeSize. */
export function newTileWriteCache(treeSize: bigint, getTile: getPopulatedTileFunc): tileWriteCache {
	return new tileWriteCache(treeSize, getTile);
}

/**
 * minImpliedTreeSize returns the smallest possible tree size implied by the existence of a tile
 * with the given ID.
 *
 * Port note: Go declares this package-level function between `newTileWriteCache` and
 * `(tc *tileWriteCache) Visitor`, interleaved with that type's methods, because Go methods need
 * not be declared contiguously. TypeScript requires every method inside one class body, so this
 * free function (it is not a tileWriteCache method in Go either) moves to just after the class
 * instead of sitting inside it — the smallest structural adjustment upstream's declaration order
 * allows for.
 */
function minImpliedTreeSize(id: TileID): bigint {
	return shiftLeft64(asUint64(id.index * tileWidth64), Number(id.level * 8n));
}

/**
 * populatedTile represents a "fully populated" tile, i.e. it has all non-ephemeral internal nodes
 * implied by the leaves.
 */
export class populatedTile {
	readonly inner = new Map<string, Uint8Array>();
	leaves: (Uint8Array | undefined)[] = [];

	/**
	 * set allows setting of individual leaf/inner nodes.
	 * It's intended to be used as a visitor for compact.Range.
	 */
	set(id: NodeID, hash: Uint8Array): void {
		if (id.level === 0) {
			if (id.index > 255n) {
				throw new Error(`Weird node ID: ${nodeIDString(id)}`);
			}
			const idx = Number(id.index);
			if (idx >= this.leaves.length) {
				this.leaves = this.leaves.concat(
					new Array<Uint8Array | undefined>(idx - this.leaves.length + 1).fill(undefined),
				);
			}
			this.leaves[idx] = hash;
		} else {
			this.inner.set(nodeIDKey(id), hash);
		}
	}

	/** get allows access to individual leaf/inner nodes. */
	get(id: NodeID): Uint8Array | undefined {
		if (id.level === 0) {
			const idx = Number(id.index);
			if (idx >= this.leaves.length) {
				return undefined;
			}
			return this.leaves[idx];
		}
		return this.inner.get(nodeIDKey(id));
	}

	equals(other: populatedTile): boolean {
		if (this.leaves.length !== other.leaves.length || this.inner.size !== other.inner.size) {
			return false;
		}
		for (let i = 0; i < this.leaves.length; i++) {
			if (!bytesOrUndefinedEqual(this.leaves[i], other.leaves[i])) {
				return false;
			}
		}
		for (const [k, v] of this.inner) {
			const ov = other.inner.get(k);
			if (ov === undefined || !bytesEqual(v, ov)) {
				return false;
			}
		}
		return true;
	}
}

/** newPopulatedTile creates and populates a fullTile struct based on the passed in HashTile data. */
function newPopulatedTile(h: HashTile | undefined): populatedTile {
	const ft = new populatedTile();

	if (h !== undefined) {
		// TODO: it might be better if we calculate (and cache) nodes in get, so we don't do more work that necessary.
		const r = new RangeFactory((l, rr) => DefaultHasher.hashChildren(l, rr)).newEmptyRange(0n);
		for (const node of h.nodes) {
			try {
				r.append(node, (id, hash) => ft.set(id, hash));
			} catch (err) {
				throw new Error(`failed to append to range: ${messageOf(err)}`);
			}
		}
	}
	return ft;
}

/**
 * nodeIDKey is populatedTile's local equivalent of tileIDKey (docs/decisions/0050-storage-internal-map-keys-and-callback-types.md),
 * for the same reason: `map[compact.NodeID][]byte` relies on Go struct value equality that
 * a JavaScript Map does not give for object keys. Scoped to this file because `inner` is
 * private to populatedTile; not exported.
 */
function nodeIDKey(id: NodeID): string {
	return `${id.level}/${id.index}`;
}

/** nodeIDString renders a NodeID the way Go's %v does for the "Weird node ID" panic message. */
function nodeIDString(id: NodeID): string {
	return `{${id.level} ${id.index}}`;
}

/** bytesOrUndefinedEqual wraps gostd/bytes.ts's bytesEqual (Go's bytes.Equal) to also accept an absent leaf. */
function bytesOrUndefinedEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	return bytesEqual(a, b);
}

// messageOf renders a caught value the way Go's `%v` renders an error.
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
