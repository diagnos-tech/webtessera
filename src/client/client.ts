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
// Ported from tessera/client/client.go @ 4a6d9f9
//
// Port note: upstream's OpenTelemetry spans (`tracer.Start`, `span.SetAttributes`) and
// client/otel.go, which defines the tracer and attribute keys they use, are dropped.
// See docs/decisions/0061-otel-tracing-dropped.md.

// Module client provides client support for interacting with logs that
// uses the [tlog-tiles API].
//
// [tlog-tiles API]: https://c2sp.org/tlog-tiles

import { EntryBundleWidth, nodeCoordsToTileAddress, partialTileSize, TileWidth } from "../api/layout/tile.ts";
import { EntryBundle, HashTile } from "../api/state.ts";
import { asUint64 } from "../internal/gostd/bits.ts";
import { Mutex } from "../internal/gostd/sync.ts";
import { Checkpoint, parseCheckpoint } from "../vendor/formats/log/index.ts";
import { type NodeID, newNodeID, RangeFactory, rangeNodes } from "../vendor/merkle/compact/index.ts";
import { consistency, inclusion, type Nodes } from "../vendor/merkle/proof/proof.ts";
import { verifyConsistency } from "../vendor/merkle/proof/verify.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import type { Note, Verifier } from "../vendor/note/note.ts";

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const hasher = DefaultHasher;

/**
 * ErrInconsistency should be thrown when there has been an error proving consistency
 * between log states.
 * The raw log state representations are included as-thrown by the target log, this
 * ensures that evidence of inconsistent log updates are available to the caller of
 * the method(s) throwing this error.
 *
 * Port note: Go's `Wrapped error` field plus its `Unwrap() error` method are the exact
 * job `Error.cause` already does in TypeScript (`errorIs`/`errorAs` walk `cause` exactly
 * as `errors.Is`/`errors.As` walk `Unwrap()`), so there is no separate `wrapped`
 * property here — `cause` is that field.
 */
export class ErrInconsistency extends Error {
	readonly smallerRaw: Uint8Array;
	readonly largerRaw: Uint8Array;
	readonly proof: Uint8Array[];

	constructor(smallerRaw: Uint8Array, largerRaw: Uint8Array, proof: Uint8Array[], wrapped: unknown) {
		super(`log consistency check failed: ${errText(wrapped)}`, { cause: wrapped });
		this.name = "ErrInconsistency";
		this.smallerRaw = smallerRaw;
		this.largerRaw = largerRaw;
		this.proof = proof;
	}
}

/**
 * CheckpointFetcherFunc is the signature of a function which can retrieve the latest
 * checkpoint from a log's data storage.
 *
 * Note that the implementation of this MUST throw (either directly or wrapped)
 * an ErrNotExist when the file referenced by path does not exist, e.g. a HTTP
 * based implementation MUST throw this when it receives a 404 StatusCode.
 *
 * Port note: `context.Context` becomes an optional trailing `AbortSignal`, per
 * docs/decisions/0060-fetcher-signal-parameter-order.md.
 */
export type CheckpointFetcherFunc = (signal?: AbortSignal) => Promise<Uint8Array>;

/**
 * TileFetcherFunc is the signature of a function which can fetch the raw data
 * for a given tile.
 *
 * Note that the implementation of this MUST:
 *   - when asked to fetch a partial tile (i.e. p != 0), fall-back to fetching the corresponding full
 *     tile if the partial one does not exist.
 *   - throw (either directly or wrapped) an ErrNotExist when neither the requested tile nor any
 *     fallback tile exists.
 */
export type TileFetcherFunc = (level: bigint, index: bigint, p: number, signal?: AbortSignal) => Promise<Uint8Array>;

/**
 * EntryBundleFetcherFunc is the signature of a function which can fetch the raw data
 * for a given entry bundle.
 *
 * Note that the implementation of this MUST:
 *   - when asked to fetch a partial entry bundle (i.e. p != 0), fall-back to fetching the corresponding full
 *     bundle if the partial one does not exist.
 *   - throw (either directly or wrapped) an ErrNotExist when neither the requested bundle nor any
 *     fallback bundle exists.
 */
export type EntryBundleFetcherFunc = (bundleIndex: bigint, p: number, signal?: AbortSignal) => Promise<Uint8Array>;

/**
 * FetchedCheckpoint is what {@link fetchCheckpoint} and {@link ConsensusCheckpointFunc}
 * return.
 *
 * Port note: Go returns `(*log.Checkpoint, []byte, *note.Note, error)` positionally; see
 * docs/decisions/0031-multi-value-returns.md. Field names follow FetchCheckpoint's own
 * doc comment ("Returns both the parsed structure and the raw serialised checkpoint")
 * plus the note it was verified against.
 */
export interface FetchedCheckpoint {
	/** checkpoint is the parsed checkpoint structure. */
	readonly checkpoint: Checkpoint;
	/** raw is the raw serialised checkpoint, exactly as fetched. */
	readonly raw: Uint8Array;
	/** note is the underlying signed note the checkpoint was parsed from. */
	readonly note: Note;
}

/**
 * ConsensusCheckpointFunc is a function which returns the largest checkpoint known which is
 * signed by logSigV and satisfies some consensus algorithm.
 *
 * This is intended to provide a hook for adding a consensus view of a log, e.g. via witnessing.
 */
export type ConsensusCheckpointFunc = (
	logSigV: Verifier,
	origin: string,
	signal?: AbortSignal,
) => Promise<FetchedCheckpoint>;

/** unilateralConsensus blindly trusts the source log, returning the checkpoint it provided. */
export function unilateralConsensus(f: CheckpointFetcherFunc): ConsensusCheckpointFunc {
	return (logSigV: Verifier, origin: string, signal?: AbortSignal): Promise<FetchedCheckpoint> =>
		fetchCheckpoint(f, logSigV, origin, signal);
}

/**
 * fetchCheckpoint retrieves and opens a checkpoint from the log.
 * Returns both the parsed structure and the raw serialised checkpoint.
 */
export async function fetchCheckpoint(
	f: CheckpointFetcherFunc,
	v: Verifier,
	origin: string,
	signal?: AbortSignal,
): Promise<FetchedCheckpoint> {
	const cpRaw = await f(signal);
	try {
		const parsed = parseCheckpoint(cpRaw, origin, v);
		return { checkpoint: parsed.checkpoint, raw: cpRaw, note: parsed.note };
	} catch (err) {
		throw new Error(`failed to parse Checkpoint: ${errText(err)}`);
	}
}

/**
 * fetchRangeNodes returns the set of nodes representing the compact range covering
 * a log of size s.
 */
export async function fetchRangeNodes(s: bigint, f: TileFetcherFunc, signal?: AbortSignal): Promise<Uint8Array[]> {
	const nc = newNodeCache(f, s);
	const nIDs = rangeNodes(0n, s, []);
	const hashes: Uint8Array[] = [];
	for (const n of nIDs) {
		hashes.push(await nc.getNode(n, signal));
	}
	return hashes;
}

/** fetchLeafHashes fetches N consecutive leaf hashes starting with the leaf at index first. */
export async function fetchLeafHashes(
	f: TileFetcherFunc,
	first: bigint,
	N: bigint,
	logSize: bigint,
	signal?: AbortSignal,
): Promise<Uint8Array[]> {
	const nc = newNodeCache(f, logSize);
	// Port note: Go preallocates `make([][]byte, 0, N)`, which aborts the process for an N it
	// cannot allocate (out of memory, or "makeslice: cap out of range"); the array grows as
	// hashes arrive instead, so such an N fails at the first leaf the log does not have
	// (docs/decisions/0194-tile-and-bundle-size-limits.md).
	const hashes: Uint8Array[] = [];
	// Port note: `first+N` wraps as Go's uint64 addition does, so a range whose end
	// overflows fetches nothing, as in Go (docs/decisions/0014-uint64-wrapping-made-explicit.md).
	for (let i = first, end = asUint64(first + N); i < end; i++) {
		const nID = newNodeID(0, i);
		let h: Uint8Array;
		try {
			h = await nc.getNode(nID, signal);
		} catch (err) {
			throw new Error(`failed to fetch node ${formatNodeID(nID)}: ${errText(err)}`);
		}
		hashes.push(h);
	}
	return hashes;
}

/** formatNodeID renders a NodeID the way Go's default `%v` verb formats a struct: `{level index}`. */
function formatNodeID(id: NodeID): string {
	return `{${id.level} ${id.index}}`;
}

/** getEntryBundle fetches the entry bundle at the given _tile index_. */
export async function getEntryBundle(
	f: EntryBundleFetcherFunc,
	i: bigint,
	logSize: bigint,
	signal?: AbortSignal,
): Promise<EntryBundle> {
	const p = partialTileSize(0n, i, logSize);
	let sRaw: Uint8Array;
	try {
		sRaw = await f(i, p, signal);
	} catch (err) {
		throw new Error(`failed to fetch bundle at index ${i}: ${errText(err)}`);
	}
	const bundle = new EntryBundle();
	try {
		bundle.unmarshalText(sRaw);
	} catch (err) {
		throw new Error(`failed to parse EntryBundle at index ${i}: ${errText(err)}`);
	}
	// Port note: hardening with no Go counterpart: a bundle holding more entries than the
	// requested partial size is rejected, unless it is the full bundle a fetcher falls back
	// to. Fewer entries are passed through, as upstream does. See
	// docs/decisions/0194-tile-and-bundle-size-limits.md.
	if (p !== 0 && bundle.entries.length > p && bundle.entries.length !== EntryBundleWidth) {
		throw new Error(`EntryBundle at index ${i} has ${bundle.entries.length} entries, more than the ${p} expected`);
	}
	return bundle;
}

/**
 * ProofBuilder knows how to build inclusion and consistency proofs from tiles.
 * Since the tiles commit only to immutable nodes, the job of building proofs is slightly
 * more complex as proofs can touch "ephemeral" nodes, so these need to be synthesized.
 * This object constructs a cache internally to make it efficient for multiple operations
 * at a given tree size.
 */
export class ProofBuilder {
	readonly #treeSize: bigint;
	readonly #nodeCache: nodeCache;

	/** @internal Stands in for Go's `&ProofBuilder{...}` composite literal; construct via {@link newProofBuilder}. */
	constructor(treeSize: bigint, nodeCache: nodeCache) {
		this.#treeSize = treeSize;
		this.#nodeCache = nodeCache;
	}

	/**
	 * inclusionProof constructs an inclusion proof for the leaf at index in a tree of
	 * the given size.
	 */
	async inclusionProof(index: bigint, signal?: AbortSignal): Promise<Uint8Array[]> {
		let nodes: Nodes;
		try {
			nodes = inclusion(index, this.#treeSize);
		} catch (err) {
			throw new Error(`failed to calculate inclusion proof node list: ${errText(err)}`);
		}
		return this.fetchNodes(nodes, signal);
	}

	/** consistencyProof constructs a consistency proof between the provided tree sizes. */
	async consistencyProof(smaller: bigint, larger: bigint, signal?: AbortSignal): Promise<Uint8Array[]> {
		const m = smaller > larger ? smaller : larger;
		if (m > this.#treeSize) {
			throw new Error(`requested consistency proof to ${m} which is larger than tree size ${this.#treeSize}`);
		}

		let nodes: Nodes;
		try {
			nodes = consistency(smaller, larger);
		} catch (err) {
			throw new Error(`failed to calculate consistency proof node list: ${errText(err)}`);
		}
		return this.fetchNodes(nodes, signal);
	}

	/**
	 * fetchNodes retrieves the specified proof nodes via pb's nodeCache.
	 *
	 * @internal Unexported in Go (`fetchNodes`), but reached directly by upstream's own
	 * TestNodeFetcherAddressing; see docs/decisions/0010-package-private-members.md. Not
	 * re-exported from client/index.ts.
	 */
	async fetchNodes(nodes: Nodes, signal?: AbortSignal): Promise<Uint8Array[]> {
		// TODO(al) parallelise this.
		const hashes: Uint8Array[] = [];
		for (const id of nodes.ids) {
			let h: Uint8Array;
			try {
				h = await this.#nodeCache.getNode(id, signal);
			} catch (err) {
				throw new Error(`failed to get node (${formatNodeID(id)}): ${errText(err)}`);
			}
			hashes.push(h);
		}
		try {
			return nodes.rehash(hashes, (l, r) => hasher.hashChildren(l, r));
		} catch (err) {
			throw new Error(`failed to rehash proof: ${errText(err)}`);
		}
	}
}

/**
 * newProofBuilder creates a new ProofBuilder object for a given tree size.
 * The returned ProofBuilder can be re-used for proofs related to a given tree size, but
 * it is not thread-safe and should not be accessed concurrently.
 *
 * Port note: Go's signature takes a ctx and returns `(*ProofBuilder, error)`, which
 * AGENTS.md §3.7 maps to `async` even though nothing here currently awaits anything —
 * upstream's own error return is likewise always nil today. Kept for shape fidelity.
 */
export async function newProofBuilder(treeSize: bigint, f: TileFetcherFunc): Promise<ProofBuilder> {
	return new ProofBuilder(treeSize, newNodeCache(f, treeSize));
}

/**
 * UpdateResult is what {@link LogStateTracker.update} returns on success.
 *
 * Port note: Go returns `([]byte, [][]byte, []byte, error)` positionally (old
 * checkpoint, consistency proof, newer checkpoint, error); see
 * docs/decisions/0031-multi-value-returns.md. `old`/`newer` are `undefined` exactly
 * where Go's `oldRaw`/`lst.latestConsistentRaw` would be a nil slice: before any
 * checkpoint has ever been recorded.
 */
export interface UpdateResult {
	readonly old: Uint8Array | undefined;
	readonly proof: Uint8Array[];
	readonly newer: Uint8Array | undefined;
}

/**
 * LogStateTracker represents a client-side view of a target log's state.
 * This tracker handles verification that updates to the tracked log state are
 * consistent with previously seen states.
 *
 * Port note: Go guards this with a `sync.RWMutex`. `update`'s critical section spans an
 * `await` (it fetches a consistency proof while holding the lock), so it genuinely needs
 * `Mutex` per docs/decisions/0004-errors-context-and-concurrency.md — but `latest` has no
 * `await` in its body, and a synchronous JavaScript statement cannot be interleaved with
 * another one, so it can never observe a torn write. `latest` therefore takes no lock at
 * all and is a plain synchronous method (matching AGENTS.md §3.7: `Latest()` takes no
 * `ctx` in Go, so it stays synchronous here too). Unlike Go's `RLock`, which waits for an
 * in-flight `Update` to finish, `latest` therefore returns the state from before that
 * update. See docs/decisions/0063-logstatetracker-mutex.md.
 */
export class LogStateTracker {
	readonly #origin: string;
	readonly #consensusCheckpoint: ConsensusCheckpointFunc;
	readonly #cpSigVerifier: Verifier;
	readonly #tileFetcher: TileFetcherFunc;

	// The fields under here will all be updated at the same time.
	// Access to any of these fields is guarded by mu.
	//
	// Port note: `mu` guards `update` only; `latest` reads without it (see the class
	// Port note).
	readonly #mu = new Mutex();

	/**
	 * @internal latestConsistent is the deserialised form of LatestConsistentRaw
	 *
	 * Port note: unexported in Go, but newLogStateTracker (a module-level function, not a
	 * method) populates it directly on the bootstrap-from-an-initial-checkpoint path, the
	 * way Go's same-package NewLogStateTracker writes `ret.latestConsistent` directly. See
	 * docs/decisions/0010-package-private-members.md. Go holds a `log.Checkpoint` value,
	 * so every assignment and every `latest()` copies it (copyCheckpoint).
	 */
	_latestConsistent: Checkpoint = new Checkpoint();
	/**
	 * @internal latestConsistentRaw holds the raw bytes of the latest proven-consistent
	 * LogState seen by this tracker.
	 */
	_latestConsistentRaw: Uint8Array | undefined;
	/** @internal proofBuilder for building proofs at LatestConsistent checkpoint. */
	_proofBuilder: ProofBuilder | undefined;

	/** @internal Stands in for Go's `&LogStateTracker{...}` composite literal; construct via {@link newLogStateTracker}. */
	constructor(
		origin: string,
		consensusCheckpoint: ConsensusCheckpointFunc,
		cpSigVerifier: Verifier,
		tileFetcher: TileFetcherFunc,
	) {
		this.#origin = origin;
		this.#consensusCheckpoint = consensusCheckpoint;
		this.#cpSigVerifier = cpSigVerifier;
		this.#tileFetcher = tileFetcher;
	}

	/**
	 * update attempts to update the local view of the target log's state.
	 * If a more recent logstate is found, this method will attempt to prove
	 * that it is consistent with the local state before updating the tracker's
	 * view.
	 * Returns the old checkpoint, consistency proof, and newer checkpoint used to update.
	 * If the LatestConsistent checkpoint is 0 sized, no consistency proof will be returned
	 * since it would be meaningless to do so.
	 *
	 * Port note: hardening with no Go counterpart: a checkpoint that is not newer is no
	 * longer ignored unchecked. One of the same size must have the same root hash, and a
	 * smaller one must be proven consistent with the tracked checkpoint; either failure
	 * throws ErrInconsistency, and neither changes what is returned on success. See
	 * docs/decisions/0196-logstatetracker-checks-older-checkpoints.md.
	 */
	async update(signal?: AbortSignal): Promise<UpdateResult> {
		const { checkpoint: c, raw: cRaw } = await this.#consensusCheckpoint(this.#cpSigVerifier, this.#origin, signal);
		let builder: ProofBuilder;
		try {
			builder = await newProofBuilder(c.size, this.#tileFetcher);
		} catch (err) {
			throw new Error(`failed to create proof builder: ${errText(err)}`);
		}

		return this.#mu.do(async (): Promise<UpdateResult> => {
			let p: Uint8Array[] = [];
			if (this._latestConsistent.size > 0n) {
				if (c.size <= this._latestConsistent.size) {
					await this.#verifyNotNewer(c, cRaw, signal);
					return { old: this._latestConsistentRaw, proof: p, newer: this._latestConsistentRaw };
				}
				p = await builder.consistencyProof(this._latestConsistent.size, c.size, signal);
				try {
					verifyConsistency(hasher, this._latestConsistent.size, c.size, p, this._latestConsistent.hash, c.hash);
				} catch (err) {
					throw new ErrInconsistency(this._latestConsistentRaw ?? new Uint8Array(0), cRaw, p, err);
				}
				// Update is consistent,
			}
			const oldRaw = this._latestConsistentRaw;
			this._latestConsistentRaw = cRaw;
			this._latestConsistent = copyCheckpoint(c);
			this._proofBuilder = builder;
			return { old: oldRaw, proof: p, newer: this._latestConsistentRaw };
		});
	}

	/**
	 * verifyNotNewer checks a checkpoint no larger than the tracked one against it: equal
	 * sizes must have equal root hashes, and a smaller tree must be consistent with the
	 * tracked one. Must be called with mu held.
	 *
	 * Port note: has no Go counterpart; see the Port note on update.
	 */
	async #verifyNotNewer(c: Checkpoint, cRaw: Uint8Array, signal?: AbortSignal): Promise<void> {
		const tracked = this._latestConsistent;
		const trackedRaw = this._latestConsistentRaw ?? new Uint8Array(0);
		if (c.size === tracked.size) {
			try {
				verifyConsistency(hasher, tracked.size, c.size, [], tracked.hash, c.hash);
			} catch (err) {
				throw new ErrInconsistency(trackedRaw, cRaw, [], err);
			}
			return;
		}
		const pb = this._proofBuilder ?? (await newProofBuilder(tracked.size, this.#tileFetcher));
		const p = await pb.consistencyProof(c.size, tracked.size, signal);
		try {
			verifyConsistency(hasher, c.size, tracked.size, p, c.hash, tracked.hash);
		} catch (err) {
			throw new ErrInconsistency(cRaw, trackedRaw, p, err);
		}
	}

	/**
	 * Port note: Go's `Latest()` has no doc comment. It returns the tracked checkpoint by
	 * value, so this returns a copy (copyCheckpoint), and it takes no lock (see the class
	 * Port note).
	 */
	latest(): Checkpoint {
		return copyCheckpoint(this._latestConsistent);
	}
}

/**
 * copyCheckpoint is Go's assignment of a `log.Checkpoint` value: a new struct with the
 * same fields, whose Hash slice still shares its bytes with the original.
 *
 * Port note: has no Go counterpart; Go copies the struct implicitly.
 */
function copyCheckpoint(c: Checkpoint): Checkpoint {
	return new Checkpoint({ origin: c.origin, size: c.size, hash: c.hash });
}

/**
 * newLogStateTracker creates a newly initialised tracker.
 * If a serialised LogState representation is provided then this is used as the
 * initial tracked state, otherwise a log state is fetched from the target log.
 *
 * Port note: Go returns `(*LogStateTracker, error)`, and on the checkpoint-parsing or
 * proof-builder failure paths it returns the *partially populated* tracker alongside the
 * error. No caller in this port (client_test.go's TestCheckLogStateTracker) inspects that
 * partial value, and every other port in this codebase throws rather than returning a value alongside an error (AGENTS.md §3.6), so
 * this throws and the partial tracker is discarded.
 *
 * Port note: checkpointRaw may be undefined or null, as Go's []byte may be nil; both mean
 * no serialised state, like an empty array.
 */
export async function newLogStateTracker(
	tF: TileFetcherFunc,
	checkpointRaw: Uint8Array | undefined | null,
	nV: Verifier,
	origin: string,
	cc: ConsensusCheckpointFunc,
	signal?: AbortSignal,
): Promise<LogStateTracker> {
	const ret = new LogStateTracker(origin, cc, nV, tF);
	if (checkpointRaw !== undefined && checkpointRaw !== null && checkpointRaw.length > 0) {
		ret._latestConsistentRaw = checkpointRaw;
		const checkpoint = parseCheckpoint(checkpointRaw, origin, nV).checkpoint;
		ret._latestConsistent = copyCheckpoint(checkpoint);
		try {
			ret._proofBuilder = await newProofBuilder(ret._latestConsistent.size, tF);
		} catch (err) {
			throw new Error(`NewProofBuilder: ${errText(err)}`);
		}
		return ret;
	}
	await ret.update(signal);
	return ret;
}

/**
 * tileKey is used as a key in nodeCache's tile map.
 *
 * Port note: Go's `tileKey` is a struct of the two coordinates, used directly as a map
 * key. A JavaScript Map compares object keys by reference, so tileKey here is a function
 * that renders the coordinates as the composite string the map is keyed by instead.
 */
function tileKey(tileLevel: bigint, tileIndex: bigint): string {
	return `${tileLevel}:${tileIndex}`;
}

/**
 * @internal nodeCache hides the tiles abstraction away, and improves
 * performance by caching tiles it's seen.
 * Not threadsafe, and intended to be only used throughout the course
 * of a single request.
 *
 * Port note: Go's `nodeCache` type is unexported, but upstream's own
 * TestNodeCacheHandlesInvalidRequest constructs and calls it directly. Exported and
 * marked @internal per docs/decisions/0010-package-private-members.md; not re-exported
 * from client/index.ts, so a consumer importing "webtessera/client" cannot reach
 * it.
 *
 * Go keys its two caches with `map[compact.NodeID][]byte` and `map[tileKey]api.HashTile`,
 * relying on Go's structural map-key equality. JavaScript's Map keys object values by
 * reference, so two different NodeID instances with the same level/index would not
 * collide the way Go's do; both caches are therefore keyed by a composite string built
 * from the coordinates (nodeIDKey, tileKey), the same technique note.ts's `nameHash`
 * already uses for the same reason.
 */
export class nodeCache {
	readonly #logSize: bigint;
	readonly #ephemeral = new Map<string, Uint8Array>();
	readonly #tiles = new Map<string, HashTile>();
	readonly #getTile: TileFetcherFunc;

	/** @internal Construct via {@link newNodeCache}. */
	constructor(f: TileFetcherFunc, logSize: bigint) {
		this.#logSize = logSize;
		this.#getTile = f;
	}

	/** setEphemeralNode stored a derived "ephemeral" tree node. */
	setEphemeralNode(id: NodeID, h: Uint8Array): void {
		this.#ephemeral.set(nodeIDKey(id), h);
	}

	/**
	 * getNode returns the internal log tree node hash for the specified node ID.
	 * A previously set ephemeral node will be returned if id matches, otherwise
	 * the tile containing the requested node will be fetched and cached, and the
	 * node hash returned.
	 */
	async getNode(id: NodeID, signal?: AbortSignal): Promise<Uint8Array> {
		// First check for ephemeral nodes:
		const e = this.#ephemeral.get(nodeIDKey(id));
		if (e !== undefined && e.length !== 0) {
			return e;
		}
		// Otherwise look in fetched tiles:
		const { tileLevel, tileIndex, nodeLevel, nodeIndex } = nodeCoordsToTileAddress(BigInt(id.level), id.index);
		const tKey = tileKey(tileLevel, tileIndex);
		let t = this.#tiles.get(tKey);
		if (t === undefined) {
			const p = partialTileSize(tileLevel, tileIndex, this.#logSize);
			let tileRaw: Uint8Array;
			try {
				tileRaw = await this.#getTile(tileLevel, tileIndex, p, signal);
			} catch (err) {
				throw new Error(`failed to fetch tile: ${errText(err)}`);
			}
			const tile = new HashTile();
			try {
				tile.unmarshalText(tileRaw);
			} catch (err) {
				throw new Error(`failed to parse tile: ${errText(err)}`);
			}
			// Port note: hardening with no Go counterpart: a tile holding more hashes than
			// the requested partial size is rejected, unless it is the full tile a fetcher
			// falls back to. Fewer are tolerated, as upstream does; the range check below
			// reports any node that is then missing. See
			// docs/decisions/0194-tile-and-bundle-size-limits.md.
			if (p !== 0 && tile.nodes.length > p && tile.nodes.length !== TileWidth) {
				throw new Error(`tile has ${tile.nodes.length} hashes, more than the ${p} expected`);
			}
			t = tile;
			this.#tiles.set(tKey, tile);
		}
		// We've got the tile, now we need to look up (or calculate) the node inside of it
		const numLeaves = 1 << nodeLevel;
		const firstLeaf = Number(nodeIndex) * numLeaves;
		const lastLeaf = firstLeaf + numLeaves;
		if (lastLeaf > t.nodes.length) {
			throw new Error(`require leaf nodes [${firstLeaf}, ${lastLeaf}) but only got ${t.nodes.length} leaves`);
		}
		const rf = new RangeFactory((l: Uint8Array, r: Uint8Array) => hasher.hashChildren(l, r));
		const r = rf.newEmptyRange(0n);
		for (const l of t.nodes.slice(firstLeaf, lastLeaf)) {
			try {
				r.append(l, null);
			} catch (err) {
				throw new Error(`failed to Append: ${errText(err)}`);
			}
		}
		const root = r.getRootHash(null);
		if (root === null) {
			// Unreachable: numLeaves >= 1 always, so the loop above always appends at
			// least one leaf before getRootHash is called.
			throw new Error("nodeCache.getNode: empty range after appending leaves");
		}
		return root;
	}
}

/** @internal newNodeCache creates a new nodeCache instance for a given log size. */
export function newNodeCache(f: TileFetcherFunc, logSize: bigint): nodeCache {
	return new nodeCache(f, logSize);
}

/** nodeIDKey renders a NodeID as a Map key, standing in for Go's struct-keyed ephemeral map. */
function nodeIDKey(id: NodeID): string {
	return `${id.level}:${id.index}`;
}
