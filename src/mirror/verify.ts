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

// This file has no upstream counterpart. Upstream's mirror "_only copies the data_; no
// self-consistency or correctness checking of the copied tiles/entries/checkpoint is
// undertaken". That is fine for an operator copying their own log, and dangerous for anyone
// mirroring somebody else's into a bucket the world reads: whatever the source serves, the
// bucket would publish. VerifyingSource sits between the two and lets through only bytes it
// has proven to belong to the tree the source's signed checkpoint commits to. See
// docs/decisions/0176-mirror-verification.md.

import { partialTileSize, TileHeight, TileWidth } from "../api/layout/index.ts";
import type { FetchFn } from "../client/fetcher.ts";
import { fetchRangeNodes, newHTTPFetcher, newProofBuilder } from "../client/index.ts";
import { trimToWidth } from "../http/partial.ts";
import { bytesEqual } from "../internal/gostd/bytes.ts";
import { ErrNotExist, errorIs } from "../internal/gostd/errors.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";
import { parseCheckpoint } from "../vendor/formats/log/index.ts";
import { RangeFactory } from "../vendor/merkle/compact/index.ts";
import { verifyConsistency } from "../vendor/merkle/proof/index.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import type { Verifier } from "../vendor/note/note.ts";
import { MaxResourceBytes, newSourceFetch } from "./fetch.ts";
import { Mirror, type Source, type Target } from "./mirror.ts";
import { unrecoverable } from "./retry.ts";
import { newSinkTarget, type Sink } from "./sink.ts";

const hashSize = 32;
const tileWidth64 = BigInt(TileWidth);
const tileHeight64 = BigInt(TileHeight);

/** MaxCheckpointBytes caps the checkpoints a VerifyingSource accepts. */
export const MaxCheckpointBytes = 64 << 10;

/** VerifyingSourceOptions configures newVerifyingSource. */
export interface VerifyingSourceOptions {
	/** origin is the source log's checkpoint origin. */
	readonly origin: string;
	/** verifier checks the source log's signature on its checkpoint. */
	readonly verifier: Verifier;
	/**
	 * target, when given, is the mirror's own copy. Its checkpoint, if it has one, must be
	 * signed by the same log, no larger than the source's, and consistent with it, so that
	 * a source that rewrote or rolled back its history cannot graft a different tree onto
	 * what the mirror already holds.
	 */
	readonly target?: Pick<Target, "readCheckpoint">;
}

/** tree is what a verified checkpoint commits to. */
interface tree {
	readonly size: bigint;
	readonly root: Uint8Array;
	/** tiles holds verified tiles above level 0, and every verified partial tile, by key. */
	readonly tiles: Map<string, Promise<Uint8Array>>;
	/** leafTiles holds verified full level-0 tiles until their entry bundle is checked. */
	readonly leafTiles: Map<string, Promise<Uint8Array>>;
}

/**
 * newVerifyingSource wraps a mirror Source so that it returns only verified resources:
 *
 *   - readCheckpoint returns the source's checkpoint once it carries a valid signature from
 *     verifier for origin, the source's partial tiles hash to its root, and (with a target)
 *     it is consistent with the mirror's current checkpoint;
 *   - readTile returns a tile once it is proven part of that tree: a partial tile by the
 *     root itself, a full one by its hash in the verified tile above it;
 *   - readEntryBundle returns an entry bundle once its entries hash to the verified level-0
 *     tile.
 *
 * Resources must be read for the size of the latest checkpoint read, which is how the
 * mirror reads them. Anything else, including a resource that does not verify, is an error,
 * so a mirror built on this source writes nothing it has not verified, and writes its
 * checkpoint only once every resource under it has been.
 */
export function newVerifyingSource(source: Source, options: VerifyingSourceOptions): VerifyingSource {
	return new VerifyingSource(source, options);
}

/** VerifyingSource is a Source that verifies. Construct it with {@link newVerifyingSource}. */
export class VerifyingSource implements Source {
	readonly #source: Source;
	readonly #options: VerifyingSourceOptions;
	#tree: tree | undefined;

	/** @internal Construct via {@link newVerifyingSource}. */
	constructor(source: Source, options: VerifyingSourceOptions) {
		this.#source = source;
		this.#options = options;
	}

	async readCheckpoint(signal?: AbortSignal): Promise<Uint8Array> {
		this.#tree = undefined;
		const raw = await this.#source.readCheckpoint(signal);
		const { size, root } = this.#verifyCheckpoint(raw, "source");

		const t: tree = { size, root, tiles: new Map(), leafTiles: new Map() };
		if (size === 0n) {
			if (!bytesEqual(root, DefaultHasher.emptyRoot())) {
				throw verificationFailed("source checkpoint of size 0 does not have the empty tree's root");
			}
		} else {
			// The partial tiles at every level are exactly what the compact range of the
			// tree is computed from, so checking that range against the root verifies each
			// of their hashes. They are kept, trimmed to their width, as verified.
			const fetched = new Map<string, Uint8Array>();
			const nodes = await fetchRangeNodes(
				size,
				async (l, i, p, s) => {
					const tile = trimTile(await this.#source.readTile(l, i, p, s), p);
					fetched.set(tileKey(l, i, p), tile);
					return tile;
				},
				signal,
			);
			const got = new RangeFactory((l, r) => DefaultHasher.hashChildren(l, r))
				.newRange(0n, size, nodes)
				.getRootHash(null);
			if (got === null || !bytesEqual(got, root)) {
				throw verificationFailed(`source tiles for size ${size} do not hash to the source checkpoint's root`);
			}
			for (const [k, v] of fetched) {
				t.tiles.set(k, Promise.resolve(v));
			}
		}

		if (this.#options.target !== undefined) {
			await this.#checkTarget(this.#options.target, size, root, signal);
		}
		this.#tree = t;
		return raw;
	}

	async readTile(l: bigint, i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		const t = this.#current();
		checkImplied(t, l, i, p);
		const tile = await this.#verifiedTile(t, l, i, p, signal);
		if (l === 0n && p === 0) {
			// Kept for readEntryBundle, which the mirror calls next for the same index.
			t.leafTiles.set(tileKey(l, i, p), Promise.resolve(tile));
		}
		return tile;
	}

	async readEntryBundle(i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		const t = this.#current();
		checkImplied(t, 0n, i, p);
		const raw = await this.#source.readEntryBundle(i, p, signal);
		if (raw.length > MaxResourceBytes) {
			throw verificationFailed(`entry bundle ${i} exceeds ${MaxResourceBytes} bytes`);
		}
		const width = p === 0 ? TileWidth : p;
		const bundle = trimToWidth({ kind: "entries", index: i, width: p }, raw);
		let leaves: Uint8Array[];
		try {
			leaves = defaultMerkleLeafHasher(bundle);
		} catch (err) {
			throw verificationFailed(`entry bundle ${i}: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (leaves.length !== width) {
			throw verificationFailed(`entry bundle ${i} has ${leaves.length} entries, want ${width}`);
		}
		const key = tileKey(0n, i, p);
		const tile = await (t.leafTiles.get(key) ?? this.#verifiedTile(t, 0n, i, p, signal));
		t.leafTiles.delete(key);
		for (let k = 0; k < width; k++) {
			if (!bytesEqual(leaves[k] as Uint8Array, tile.subarray(k * hashSize, (k + 1) * hashSize))) {
				throw verificationFailed(`entry ${BigInt(k) + i * tileWidth64} does not hash to its leaf in the verified tile`);
			}
		}
		return bundle;
	}

	#current(): tree {
		if (this.#tree === undefined) {
			throw verificationFailed("readCheckpoint must succeed before resources can be verified");
		}
		return this.#tree;
	}

	#verifyCheckpoint(raw: Uint8Array, which: string): { size: bigint; root: Uint8Array } {
		if (raw.length > MaxCheckpointBytes) {
			throw verificationFailed(`${which} checkpoint exceeds ${MaxCheckpointBytes} bytes`);
		}
		const { checkpoint } = parseCheckpoint(raw, this.#options.origin, this.#options.verifier);
		if (checkpoint.hash.length !== hashSize) {
			throw verificationFailed(`${which} checkpoint root hash is ${checkpoint.hash.length} bytes, want ${hashSize}`);
		}
		return { size: checkpoint.size, root: checkpoint.hash };
	}

	async #checkTarget(
		target: Pick<Target, "readCheckpoint">,
		size: bigint,
		root: Uint8Array,
		signal?: AbortSignal,
	): Promise<void> {
		let raw: Uint8Array;
		try {
			raw = await target.readCheckpoint(signal);
		} catch (err) {
			if (errorIs(err, ErrNotExist)) {
				return;
			}
			throw err;
		}
		const mirrored = this.#verifyCheckpoint(raw, "mirrored");
		if (mirrored.size > size) {
			throw verificationFailed(
				`source checkpoint (size ${size}) is older than the mirrored one (size ${mirrored.size})`,
			);
		}
		const pb = await newProofBuilder(size, (l, i, p, s) =>
			this.#source.readTile(l, i, p, s).then((d) => trimTile(d, p)),
		);
		const proof = mirrored.size === size ? [] : await pb.consistencyProof(mirrored.size, size, signal);
		try {
			verifyConsistency(DefaultHasher, mirrored.size, size, proof, mirrored.root, root);
		} catch (err) {
			throw verificationFailed(
				`source checkpoint (size ${size}) is not consistent with the mirrored one (size ${mirrored.size}): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	/**
	 * verifiedTile returns tile (l, i, p) once verified. Partial tiles were verified with the
	 * checkpoint; a full tile is verified by recomputing its root and finding it in the tile
	 * above, which is verified the same way in turn, up to a partial tile. Tiles above level
	 * 0 are kept: there are 256 times fewer of them at each level, and each verifies 256 below.
	 */
	#verifiedTile(t: tree, l: bigint, i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		const key = tileKey(l, i, p);
		const known = t.tiles.get(key);
		if (known !== undefined) {
			return known;
		}
		if (p !== 0) {
			// Every partial tile the checkpoint implies was fetched and verified with it.
			return Promise.reject(verificationFailed(`partial tile ${key} is not implied by the verified checkpoint`));
		}
		const verified = (async () => {
			const raw = await this.#source.readTile(l, i, 0, signal);
			if (raw.length !== TileWidth * hashSize) {
				throw verificationFailed(`full tile ${key} is ${raw.length} bytes, want ${TileWidth * hashSize}`);
			}
			const parentIndex = i >> tileHeight64;
			const parent = await this.#verifiedTile(
				t,
				l + 1n,
				parentIndex,
				partialTileSize(l + 1n, parentIndex, t.size),
				signal,
			);
			const k = Number(i % tileWidth64);
			const want = parent.subarray(k * hashSize, (k + 1) * hashSize);
			if (want.length !== hashSize || !bytesEqual(tileRoot(raw), want)) {
				throw verificationFailed(`full tile ${key} does not hash to its entry in the verified tile above`);
			}
			return raw;
		})();
		if (l > 0n) {
			t.tiles.set(key, verified);
			// A failed verification must not be remembered as one.
			verified.catch(() => t.tiles.delete(key));
		}
		return verified;
	}
}

/** VerifiedMirrorOptions configures newVerifiedMirror. */
export interface VerifiedMirrorOptions {
	/**
	 * source is the log to mirror: its tlog-tiles URL prefix, or any Source (an HTTPFetcher,
	 * a LogReader). A URL is fetched through {@link newSourceFetch}: no redirects, bounded
	 * responses.
	 */
	readonly source: URL | string | Source;
	/** target is where the log is copied to: a Target, or any Sink (see {@link newSinkTarget}). */
	readonly target: Target | Sink;
	/** origin is the source log's checkpoint origin. */
	readonly origin: string;
	/** verifier checks the source log's signature. */
	readonly verifier: Verifier;
	/** numWorkers is how many resources are copied at once. Defaults to 30. */
	readonly numWorkers?: number;
	/** fetch makes the requests for a URL source. Defaults to the global fetch. */
	readonly fetch?: FetchFn;
}

/**
 * newVerifiedMirror returns a Mirror that copies a log only as far as it can verify it:
 * every resource is checked against the source's signed checkpoint, and that checkpoint
 * against the target's, before anything is written, and the checkpoint is written last.
 * This is the way to mirror a log you do not operate.
 *
 * ```ts
 * const m = newVerifiedMirror({
 *   source: "https://log.example/",
 *   target: newS3Sink({ endpoint, bucket, region, accessKeyId, secretAccessKey }),
 *   origin: "log.example",
 *   verifier: newVerifier(logVkey),
 * });
 * await m.run(signal);
 * ```
 *
 * Running it again later copies only what the source has added since, after checking that
 * the source still extends what was copied.
 */
export function newVerifiedMirror(options: VerifiedMirrorOptions): Mirror {
	const target = isTarget(options.target) ? options.target : newSinkTarget(options.target);
	const raw =
		typeof options.source === "string" || options.source instanceof URL
			? newHTTPFetcher(
					new URL(options.source),
					newSourceFetch(options.fetch === undefined ? {} : { fetch: options.fetch }),
				)
			: options.source;
	const source = newVerifyingSource(raw, { origin: options.origin, verifier: options.verifier, target });
	return new Mirror(
		options.numWorkers === undefined ? { source, target } : { source, target, numWorkers: options.numWorkers },
	);
}

function isTarget(t: Target | Sink): t is Target {
	return "writeTile" in t && typeof t.writeTile === "function";
}

/**
 * checkImplied refuses a request for a resource the verified checkpoint does not imply:
 * a full tile beyond its last full one, or a partial tile of any other width.
 */
function checkImplied(t: tree, l: bigint, i: bigint, p: number): void {
	const want = partialTileSize(l, i, t.size);
	const fullTiles = t.size >> ((l + 1n) * tileHeight64);
	if (p === 0 ? i >= fullTiles : p !== want || i !== fullTiles) {
		throw verificationFailed(`tile ${tileKey(l, i, p)} is not implied by the verified checkpoint of size ${t.size}`);
	}
}

/**
 * trimTile cuts a tile served for a partial request down to the partial width. A source may
 * substitute the full tile for a garbage-collected partial one (as HTTPFetcher's fallback
 * does), and only the first p hashes are what the partial tile is; anything shorter is
 * refused.
 */
function trimTile(raw: Uint8Array, p: number): Uint8Array {
	if (raw.length > TileWidth * hashSize || raw.length % hashSize !== 0) {
		throw verificationFailed(`tile of ${raw.length} bytes is not a whole number of hashes up to a full tile`);
	}
	if (p === 0) {
		return raw;
	}
	if (raw.length < p * hashSize) {
		throw verificationFailed(`partial tile of width ${p} has only ${raw.length / hashSize} hashes`);
	}
	return raw.subarray(0, p * hashSize);
}

/** tileRoot returns the Merkle root of a full tile's 256 hashes. */
function tileRoot(tile: Uint8Array): Uint8Array {
	const r = new RangeFactory((l, rr) => DefaultHasher.hashChildren(l, rr)).newEmptyRange(0n);
	for (let k = 0; k < TileWidth; k++) {
		r.append(tile.subarray(k * hashSize, (k + 1) * hashSize), null);
	}
	const root = r.getRootHash(null);
	if (root === null) {
		throw verificationFailed("empty tile");
	}
	return root;
}

/**
 * verificationFailed is the error for a resource that does not verify. It is marked
 * unrecoverable, so that the mirror's retries, meant for transient fetch and store failures,
 * stop at once instead of fetching the same bad bytes ten times.
 */
function verificationFailed(message: string): Error {
	return unrecoverable(new Error(message));
}

function tileKey(l: bigint, i: bigint, p: number): string {
	return `${l}/${i}/${p}`;
}
