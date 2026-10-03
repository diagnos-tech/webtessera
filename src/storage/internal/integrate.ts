// Copyright 2024 Google LLC. All Rights Reserved.
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
// Ported from tessera/storage/internal/integrate.go @ 4a6d9f9
//
// Port note: every OpenTelemetry span/attribute and every klog debug log line from the Go
// source is dropped. Neither has any TypeScript counterpart anywhere in this port (no
// other file imports an OTel or klog shim), storage/internal/otel.go itself is not
// ported, and AGENTS.md §7 restricts runtime dependencies to `@noble/*`. See
// docs/decisions/0051-storage-internal-drops-otel-and-klog.md.

import { nodeCoordsToTileAddress, partialTileSize, TileWidth, tilePath } from "../../api/layout/index.ts";
import { HashTile } from "../../api/state.ts";
import { asUint64, shiftLeft64 } from "../../internal/gostd/bits.ts";
import { bytesEqual } from "../../internal/gostd/bytes.ts";
import { joinErrors, wrapError } from "../../internal/gostd/errors.ts";
import {
	rangeNodes as compactRangeNodes,
	type NodeID,
	newNodeID,
	type Range,
	RangeFactory,
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
 * GetTilesFunc fetches tiles from storage.
 *
 * Port note: Go leaves this func type anonymous, repeating the same signature at each of
 * its four use sites (Integrate's param, newTreeBuilder's param, tileReadCache.getTiles's
 * field type, and newTileReadCache's param); its contract is the one documented on
 * newTreeBuilder below. It is named here purely for readability and is not upstream API
 * surface. See docs/decisions/0050-storage-internal-map-keys-and-callback-types.md.
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
 * Port note: Go's version takes a ctx and returns `(*populatedTile, error)`; here it is
 * synchronous and throws instead of returning an error, because it is called from inside
 * the synchronous compact.VisitFn. integrate() hands tileWriteCache a function that
 * replays, in order, the outcomes of `tileReadCache.get` calls made before the visitor
 * runs — see replayedTileReads below and
 * docs/decisions/0190-integrate-visitor-tile-reads-are-replayed.md.
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
		const rangeNodes = compactRangeNodes(0n, treeSize, []);
		const toFetch = new Map<string, TileID>();
		for (const id of rangeNodes) {
			const { tileLevel, tileIndex } = nodeCoordsToTileAddress(BigInt(id.level), id.index);
			const tid = new TileID(tileLevel, tileIndex);
			toFetch.set(tileIDKey(tid), tid);
		}
		try {
			await this.readCache.prewarm([...toFetch.values()], treeSize, signal);
		} catch (err) {
			if (err instanceof panicError) {
				throw err;
			}
			throw new Error(`Prewarm: ${messageOf(err)}`);
		}

		const hashes: Uint8Array[] = [];
		for (const id of rangeNodes) {
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
			if (err instanceof panicError) {
				throw err;
			}
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
		// Port note: Go hands the visitor `t.readCache.Get`, which may block on a fetch from
		// inside the synchronous compact.VisitFn. JavaScript cannot suspend a synchronous
		// callback, so `reads` performs those same readCache.get calls up front — the same
		// tiles, in the same order, with the same retries after a failure — and the
		// visitor's getTile replays their outcomes. See
		// docs/decisions/0190-integrate-visitor-tile-reads-are-replayed.md.
		const reads = new replayedTileReads(this.readCache, fromSize, baseRange.hashes().length);
		const tc = newTileWriteCache(fromSize, reads.getTile);
		const visitor = tc.visitor();
		await reads.prefetchAppends(leafHashes.length, signal);
		for (const e of leafHashes) {
			// Update range and set nodes
			try {
				newRange.append(e, visitor);
			} catch (err) {
				if (err instanceof panicError) {
					throw err;
				}
				throw new Error(`newRange.Append(): ${messageOf(err)}`);
			}
		}
		// Check whether the visitor had any problems building the update range
		const errAfterAppend = tc.err();
		if (errAfterAppend !== undefined) {
			throw errAfterAppend;
		}

		// Merge the update range into the old tree
		await reads.prefetchAppendRange(signal);
		try {
			baseRange.appendRange(newRange, visitor);
		} catch (err) {
			if (err instanceof panicError) {
				throw err;
			}
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

/**
 * newTreeBuilder creates a new instance of treeBuilder.
 *
 * The getTiles param must know how to fetch the specified tiles from storage. It must return tiles in the same order as the
 * provided tileIDs, substituing undefined for any tiles which were not found.
 */
export function newTreeBuilder(getTiles: GetTilesFunc): treeBuilder {
	const readCache = newTileReadCache(getTiles);
	return new treeBuilder(readCache, new RangeFactory((l, r) => DefaultHasher.hashChildren(l, r)));
}

/**
 * tileReadCache is a structure which provides a very simple thread-safe read-through cache based on a map of tiles.
 *
 * Port note: despite the comment, Go's struct holds no lock — just `entries` and
 * `getTiles` — so there is nothing to translate; JavaScript's single thread gives this
 * class the same exclusivity between awaits that Go's callers get by not sharing it.
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
			// Port note: Go reads `t[0]` unguarded, which panics if getTiles broke its
			// contract and returned no tiles; an undefined here would instead read as
			// "tile not found" and silently start the tile afresh.
			if (t.length === 0) {
				throw new panicError("runtime error: index out of range [0] with length 0");
			}
			try {
				e = newPopulatedTile(t[0]);
			} catch (err) {
				if (err instanceof panicError) {
					throw err;
				}
				throw new Error(`failed to create fulltile: ${messageOf(err)}`);
			}
			this.entries.set(k, e);
		}
		return e;
	}

	/**
	 * prewarm fills the cache by fetching the given tilesIDs.
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
				if (err instanceof panicError) {
					throw err;
				}
				throw new Error(`failed to create fulltile: ${messageOf(err)}`);
			}
			// Port note: Go indexes `tileIDs[i]` unguarded, which panics if getTiles
			// returned more tiles than it was asked for. Fewer is tolerated, as in Go:
			// newRange's subsequent get() calls fetch whatever is missing one by one.
			const id = tileIDs[i];
			if (id === undefined) {
				throw new panicError(`runtime error: index out of range [${i}] with length ${tileIDs.length}`);
			}
			const k = tilePath(id.level, id.index, partialTileSize(id.level, id.index, treeSize));
			this.entries.set(k, e);
		}
	}
}

/** newTileReadCache creates a new instance of tileReadCache. */
function newTileReadCache(getTiles: GetTilesFunc): tileReadCache {
	return new tileReadCache(getTiles);
}

/**
 * tileReadOutcome is the result of one `tileReadCache.get` call made on the visitor's behalf.
 *
 * Port note: has no Go counterpart; see replayedTileReads.
 */
type tileReadOutcome =
	| { readonly key: string; readonly tile: populatedTile; readonly err?: undefined }
	| { readonly key: string; readonly tile?: undefined; readonly err: unknown };

/**
 * replayedTileReads performs, before the tileWriteCache visitor runs, every
 * `tileReadCache.get` call Go's visitor would make from inside compact.Range's
 * synchronous callbacks, and replays their outcomes to the visitor in the same order.
 *
 * Port note: has no Go counterpart. Go's visitor calls `t.readCache.Get` the first time
 * it touches a tile that may already exist (`minImpliedTreeSize(tileID) <= treeSize`),
 * blocking on `getTiles` when the tile is not cached — including tiles left behind by an
 * earlier integration that crashed before updating the tree size — and calls it again on
 * the next touch if the read failed. Which tiles it touches depends only on the shape of
 * the ranges, never on hash values, so this class first records the visits a structural
 * copy of the same appends would make (prefetchAppends / prefetchAppendRange), then
 * replays them through a scratch tileWriteCache whose getTile asks for each read in turn.
 * The reads therefore happen in exactly the order, with exactly the arguments, Go's would,
 * and the real visitor's getTile hands back their results (or rethrows their errors) one
 * by one. See docs/decisions/0190-integrate-visitor-tile-reads-are-replayed.md.
 */
class replayedTileReads {
	readonly #readCache: tileReadCache;
	readonly #treeSize: bigint;
	readonly #baseRangeHashes: number;
	readonly #dryRF = new RangeFactory(() => placeholderHash);
	readonly #dryNewRange: Range;
	/** visits holds, in order, every node the visitor will be called with so far. */
	readonly #visits: NodeID[] = [];
	readonly #outcomes: tileReadOutcome[] = [];
	readonly #dryCache: tileWriteCache;
	#dryVisitor: VisitFn;
	#dryReplayed = 0;
	#dryNext = 0;
	#dryAsked: TileID | undefined;
	#next = 0;

	constructor(readCache: tileReadCache, treeSize: bigint, baseRangeHashes: number) {
		this.#readCache = readCache;
		this.#treeSize = treeSize;
		this.#baseRangeHashes = baseRangeHashes;
		this.#dryNewRange = this.#dryRF.newEmptyRange(treeSize);
		this.#dryCache = newTileWriteCache(treeSize, (tileID) => this.#dryGetTile(tileID));
		this.#dryVisitor = this.#dryCache.visitor();
	}

	/** getTile is the getPopulatedTileFunc handed to the real tileWriteCache. */
	readonly getTile = (tileID: TileID, _treeSize: bigint): populatedTile | undefined => {
		const o = this.#outcomes[this.#next];
		if (o === undefined || o.key !== tileIDKey(tileID)) {
			throw new panicError(`replayedTileReads: unplanned tile read for ${tileIDKey(tileID)}`);
		}
		this.#next++;
		if (o.tile === undefined) {
			throw o.err;
		}
		return o.tile;
	};

	/** prefetchAppends performs the reads `n` calls of `newRange.append(e, visitor)` make. */
	async prefetchAppends(n: number, signal?: AbortSignal): Promise<void> {
		const record: VisitFn = (id) => {
			this.#visits.push(id);
		};
		for (let i = 0; i < n; i++) {
			this.#dryNewRange.append(placeholderHash, record);
		}
		await this.#fetch(signal);
	}

	/** prefetchAppendRange performs the reads `baseRange.appendRange(newRange, visitor)` makes. */
	async prefetchAppendRange(signal?: AbortSignal): Promise<void> {
		const dryBase = this.#dryRF.newRange(
			0n,
			this.#treeSize,
			new Array<Uint8Array>(this.#baseRangeHashes).fill(placeholderHash),
		);
		dryBase.appendRange(this.#dryNewRange, (id) => {
			this.#visits.push(id);
		});
		await this.#fetch(signal);
	}

	/**
	 * fetch replays the recorded visits through the scratch tileWriteCache. When a visit
	 * asks for a read that has not happened yet, the scratch visitor records the request
	 * and returns early (its error path, which leaves the tile unset); fetch then performs
	 * the read and replays the same visit, now with its outcome known.
	 */
	async #fetch(signal?: AbortSignal): Promise<void> {
		while (this.#dryReplayed < this.#visits.length) {
			const id = this.#visits[this.#dryReplayed] as NodeID;
			this.#dryAsked = undefined;
			this.#dryVisitor(id, placeholderHash);
			const asked = this.#dryAsked as TileID | undefined;
			if (asked === undefined) {
				this.#dryReplayed++;
				continue;
			}
			const key = tileIDKey(asked);
			try {
				this.#outcomes.push({ key, tile: await this.#readCache.get(asked, this.#treeSize, signal) });
			} catch (err) {
				if (err instanceof panicError) {
					throw err;
				}
				this.#outcomes.push({ key, err });
			}
		}
	}

	#dryGetTile(tileID: TileID): populatedTile | undefined {
		const o = this.#outcomes[this.#dryNext];
		if (o === undefined) {
			this.#dryAsked = tileID;
			throw readNotYetMade;
		}
		this.#dryNext++;
		if (o.tile === undefined) {
			throw o.err;
		}
		return new populatedTile();
	}
}

/** placeholderHash stands in for every hash in replayedTileReads' structural ranges. */
const placeholderHash = new Uint8Array(0);

/** readNotYetMade is what replayedTileReads' scratch getTile throws for a read still to be made. */
const readNotYetMade = new Error("replayedTileReads: read not yet made");

/**
 * panicError is thrown where Go panics. Error-wrapping sites in this file rethrow it
 * unchanged rather than reporting it as an ordinary error, as a Go panic unwinds past
 * them.
 *
 * Port note: has no Go counterpart; see
 * docs/decisions/0190-integrate-visitor-tile-reads-are-replayed.md.
 */
class panicError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "panicError";
	}
}

/**
 * tileWriteCache is a simple cache for storing the newly created tiles produced by
 * the integration of new leaves into the tree.
 *
 * Calls to Visit will cause the map of tiles to become filled with the set of
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

	/** @internal Use newTileWriteCache. */
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
	 *
	 * Port note: Go's `Visitor(ctx)` only passes ctx on to getTile, which takes none here
	 * (see getPopulatedTileFunc), so the parameter is dropped.
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
						if (err instanceof panicError) {
							throw err;
						}
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
	 * Port note: Go's `leaves [][]byte` can hold nil entries for slots `Set` never
	 * reached, and `api.HashTile{Nodes: t.leaves}` copies that slice straight into a
	 * `HashTile`; Go's `bytes.Buffer.Write(nil)` then writes zero bytes for it, silently
	 * producing an undersized tile. `HashTile.nodes` is typed `Uint8Array[]` here with no
	 * such escape hatch, so a gap is rejected instead. compact.Range only ever visits leaf
	 * indices in order from a tile's first unset slot, so no well-formed integration
	 * produces one. See docs/decisions/0191-integrate-rejects-a-tile-with-a-gap.md.
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

/**
 * newTileWriteCache creates a new cache for the given treeSize, and uses the provided
 * function to fetch existing tiles which are being updated by the Visitor func.
 */
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
 * allows for. Both the product and the shift count wrap as Go's uint64 arithmetic does
 * (docs/decisions/0014-uint64-wrapping-made-explicit.md).
 */
function minImpliedTreeSize(id: TileID): bigint {
	return shiftLeft64(asUint64(id.index * tileWidth64), Number(asUint64(id.level * 8n)));
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
				throw new panicError(`Weird node ID: ${nodeIDString(id)}`);
			}
			const idx = Number(id.index);
			while (this.leaves.length <= idx) {
				this.leaves.push(undefined);
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
				if (err instanceof panicError) {
					throw err;
				}
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
