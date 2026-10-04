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
// Ported from tessera/storage/internal/integrate_test.go @ 4a6d9f9
//
// Port note: BenchmarkIntegrate is not ported — see docs/decisions/0034-go-benchmarks-not-ported.md.

import { describe, expect, it } from "vitest";
import { partialTileSize, TileWidth, tilePath } from "../../api/layout/index.ts";
import { HashTile } from "../../api/state.ts";
import { newEntry } from "../../entry.ts";
import { bytesEqual, toHex } from "../../internal/gostd/bytes.ts";
import type { NodeID } from "../../vendor/merkle/compact/index.ts";
import { newNodeID, RangeFactory } from "../../vendor/merkle/compact/index.ts";
import { DefaultHasher } from "../../vendor/merkle/rfc6962/rfc6962.ts";
import { integrate, minImpliedTreeSize, newTileWriteCache, newTreeBuilder, type populatedTile } from "./integrate.ts";
import { TileID, tileIDKey } from "./tileid.ts";

describe("storage/internal/integrate", () => {
	it("TestNewRangeFetchesTiles", async () => {
		const m = newMemTileStore<HashTile>();
		const tb = newTreeBuilder(m.getTiles);

		const treeSize = 0x102030n;
		const wantIDs = [new TileID(0n, 0x1020n), new TileID(1n, 0x10n), new TileID(2n, 0x0n)];

		for (const id of wantIDs) {
			m.setTile(id, treeSize, zeroTile(TileWidth));
		}

		await tb.newRange(treeSize);
	});

	it("TestTileVisit", () => {
		const m = newMemTileStore<populatedTile>();
		const treeSize = 0x102030n;

		const tests: readonly {
			name: string;
			visits: readonly [NodeID, Uint8Array][];
			wantTiles: readonly [TileID, HashTile][];
		}[] = [
			{
				name: "ok - single tile",
				visits: [
					[newNodeID(0, 0n), Uint8Array.of(0)],
					[newNodeID(0, 1n), Uint8Array.of(1)],
					[newNodeID(1, 1n), Uint8Array.of(2)],
				],
				wantTiles: [[new TileID(0n, 0n), new HashTile([Uint8Array.of(0), Uint8Array.of(1)])]],
			},
			{
				name: "ok - multiple tiles",
				visits: [
					[newNodeID(0, 0n), Uint8Array.of(0)],
					[newNodeID(0, 1n * BigInt(TileWidth)), Uint8Array.of(1)],
					[newNodeID(8, 2n * BigInt(TileWidth)), Uint8Array.of(2)],
				],
				wantTiles: [
					[new TileID(0n, 0n), new HashTile([Uint8Array.of(0)])],
					[new TileID(0n, 1n), new HashTile([Uint8Array.of(1)])],
					[new TileID(1n, 2n), new HashTile([Uint8Array.of(2)])],
				],
			},
		];

		// Port note: Go ranges over `test.visits`, a map, so each run visits the nodes in an
		// unspecified order and the test must hold for every one of them. Every permutation is
		// run here instead of whichever order an array literal happens to fix.
		for (const test of tests) {
			for (const visits of permutations(test.visits)) {
				const order = visits.map(([id]) => `${id.level}/${id.index}`).join(" ");
				const twc = newTileWriteCache(treeSize, m.getTile);
				const v = twc.visitor();
				for (const [id, hash] of visits) {
					v(id, hash);
				}
				expect(twc.err(), `${test.name} [${order}]`).toBeUndefined();

				const gotTiles = twc.tiles();
				for (const [id, wantTile] of test.wantTiles) {
					const gotEntry = gotTiles.get(tileIDKey(id));
					expect(gotEntry, `${test.name} [${order}]: missing tile ${tileIDKey(id)}`).toBeDefined();
					expect(gotEntry?.tile.nodes, `${test.name} [${order}]`).toEqual(wantTile.nodes);
					gotTiles.delete(tileIDKey(id));
				}
				expect(gotTiles.size, `${test.name} [${order}]: unexpected tiles: ${[...gotTiles.keys()]}`).toBe(0);
			}
		}
	});

	// Port note: 1000 chunks of 200 entries (200,000 total) matches upstream exactly, but
	// each chunk round-trips through async tile fetches (integrate()/newTreeBuilder()
	// build a fresh, cold read cache every call, exactly as Go's Integrate does) plus
	// bigint arithmetic throughout (ADR-0003). Native Go completes this near-instantly;
	// this port takes on the order of ten seconds, so the test gets an explicit longer
	// timeout rather than a smaller, unfaithful chunk/numChunks.
	//
	// 120s rather than 60s: under heavy CPU contention (several suites running in
	// parallel on a shared CI runner) this case has been measured at 64s. The comment
	// above already accepts running well beyond Go's native ~10s; this only widens
	// the same margin.
	const integrateTimeoutMs = 120_000;
	it(
		"TestIntegrate",
		async () => {
			const m = newMemTileStore<HashTile>();

			const cr = new RangeFactory((l, r) => DefaultHasher.hashChildren(l, r)).newEmptyRange(0n);

			const chunkSize = 200;
			const numChunks = 1000;
			let seq = 0n;
			for (let chunk = 0; chunk < numChunks; chunk++) {
				const oldSeq = seq;
				const c: Uint8Array[] = new Array(chunkSize);
				for (let i = 0; i < chunkSize; i++) {
					const leaf = Uint8Array.of(Number(seq % 256n));
					const entry = newEntry(leaf);
					c[i] = entry.leafHash();
					cr.append(DefaultHasher.hashLeaf(leaf), null);
					seq++;
				}
				const wantRoot = cr.getRootHash(null);

				const { newSize: gotSize, rootHash: gotRoot, tiles: gotTiles } = await integrate(m.getTiles, oldSeq, c);
				expect(gotSize, `[${chunk}]`).toBe(seq);
				expect(bytesEqual(gotRoot, wantRoot as Uint8Array), `[${chunk}] got root ${gotRoot} want ${wantRoot}`).toBe(
					true,
				);

				for (const [, { id, tile }] of gotTiles) {
					m.setTile(id, seq, tile);
				}
			}
		},
		integrateTimeoutMs,
	);

	// Below this line are port additions with no direct upstream case.
	//
	// The tileWriteCache visitor reads existing tiles through tileReadCache.get exactly when
	// and as often as Go's synchronous visitor does (docs/decisions/0190). These pin the
	// getTiles call sequence, and its consequences, to what the real Go code produced for
	// the same inputs (recorded by running storage/internal's Integrate with a logging
	// getTiles at the pinned commit).
	describe("port additions: Go's tile reads", () => {
		it("makes the same getTiles calls as Go for 0 -> 255 -> 256 -> 257 -> 557", async () => {
			const m = newMemTileStore<HashTile>();
			const calls: string[] = [];
			const getTiles = async (ids: readonly TileID[], treeSize: bigint): Promise<(HashTile | undefined)[]> => {
				calls.push(`getTiles([${ids.map((id) => `{${id.level} ${id.index}}`).join(" ")}] @${treeSize})`);
				return m.getTiles(ids, treeSize);
			};

			const got: string[] = [];
			let size = 0n;
			for (const step of [255, 1, 1, 300]) {
				calls.length = 0;
				const r = await integrate(getTiles, size, leafHashes(Number(size), step));
				got.push(`${size} -> ${r.newSize}: ${calls.join(" ; ")}`);
				for (const [, { id, tile }] of r.tiles) {
					m.setTile(id, r.newSize, tile);
				}
				size = r.newSize;
			}

			expect(got).toEqual([
				"0 -> 255: getTiles([] @0) ; getTiles([{0 0}] @0)",
				"255 -> 256: getTiles([{0 0}] @255) ; getTiles([{1 0}] @255)",
				"256 -> 257: getTiles([{1 0}] @256) ; getTiles([{0 1}] @256)",
				"257 -> 557: getTiles([{1 0} {0 1}] @257)",
			]);
		});

		it("extends a tile left behind by a crashed integration, as Go does", async () => {
			// A log of size 256, plus an integration of 256 more entries that crashed after
			// writing the full tile/0/001 but before the tree size moved on.
			const m = newMemTileStore<HashTile>();
			for (const [, { id, tile }] of (await integrate(m.getTiles, 0n, leafHashes(0, 256))).tiles) {
				m.setTile(id, 256n, tile);
			}
			const crashed = (await integrate(m.getTiles, 256n, leafHashes(1000, 256))).tiles.get(
				tileIDKey(new TileID(0n, 1n)),
			);
			if (crashed === undefined) {
				throw new Error("crashed integration produced no tile/0/001");
			}
			m.setTile(crashed.id, 512n, crashed.tile);

			const calls: string[] = [];
			const getTiles = async (ids: readonly TileID[], treeSize: bigint): Promise<(HashTile | undefined)[]> => {
				calls.push(`[${ids.map((id) => `{${id.level} ${id.index}}`).join(" ")}]@${treeSize}`);
				return m.getTiles(ids, treeSize);
			};
			const newLeaves = leafHashes(256, 3);
			const r = await integrate(getTiles, 256n, newLeaves);

			// Go: log=[[{1 0}]@256 [{0 1}]@256] size=259
			// root=e2f77598d9aeedbed14c5893410c621fdf9facaed62d5c291110fc7bc91fe36b, and the only
			// tile is {0 1} with 256 nodes: the three new leaves over the crashed tile's rest.
			expect(calls).toEqual(["[{1 0}]@256", "[{0 1}]@256"]);
			expect(r.newSize).toBe(259n);
			expect(toHex(r.rootHash)).toBe("e2f77598d9aeedbed14c5893410c621fdf9facaed62d5c291110fc7bc91fe36b");
			expect([...r.tiles.keys()]).toEqual([tileIDKey(new TileID(0n, 1n))]);
			const tile = r.tiles.get(tileIDKey(new TileID(0n, 1n)))?.tile as HashTile;
			expect(tile.nodes).toEqual([...newLeaves, ...crashed.tile.nodes.slice(3)]);
		});

		it("retries a failing read on every visit and joins every error, as Go does", async () => {
			const m = newMemTileStore<HashTile>();
			for (const [, { id, tile }] of (await integrate(m.getTiles, 0n, leafHashes(0, 256))).tiles) {
				m.setTile(id, 256n, tile);
			}
			let calls = 0;
			const getTiles = async (ids: readonly TileID[], treeSize: bigint): Promise<(HashTile | undefined)[]> => {
				calls++;
				if (ids.some((id) => id.level === 0n && id.index === 1n)) {
					throw new Error("boom");
				}
				return m.getTiles(ids, treeSize);
			};

			// Go: one Prewarm call, then one failing read for each of the 510 visits to tile
			// {0 1}, whose errors errors.Join reports one per line.
			const err = await integrate(getTiles, 256n, leafHashes(256, 300)).catch((e: unknown) => e);
			expect(calls).toBe(511);
			expect((err as Error).message).toBe(new Array<string>(510).fill("boom").join("\n"));
		});

		it("lets a panic escape unwrapped: a stored tile with more than 256 leaves", async () => {
			// Go's populatedTile.Set panics on a 257th leaf; none of the error-wrapping sites
			// between it and Integrate's caller ever see it as an error.
			const big = zeroTile(TileWidth + 1);
			const getTiles = async (ids: readonly TileID[]): Promise<(HashTile | undefined)[]> => ids.map(() => big);
			await expect(integrate(getTiles, 255n, [Uint8Array.of(1)])).rejects.toThrow(/^Weird node ID: \{0 256\}$/);
		});

		it("panics if getTiles returns no tile for a single read", async () => {
			// Go reads `t[0]` unguarded in tileReadCache.Get.
			const getTiles = async (ids: readonly TileID[]): Promise<(HashTile | undefined)[]> =>
				ids.length === 1 ? [] : ids.map(() => undefined);
			await expect(integrate(getTiles, 0n, [Uint8Array.of(1)])).rejects.toThrow(
				/^runtime error: index out of range \[0\] with length 0$/,
			);
		});

		it("panics if getTiles returns more tiles than asked for in Prewarm", async () => {
			// Go indexes `tileIDs[i]` unguarded in tileReadCache.Prewarm.
			const getTiles = async (ids: readonly TileID[]): Promise<(HashTile | undefined)[]> => [
				...ids.map(() => undefined),
				undefined,
			];
			await expect(integrate(getTiles, 0n, [Uint8Array.of(1)])).rejects.toThrow(
				/^runtime error: index out of range \[0\] with length 0$/,
			);
		});
	});

	// Go's `fmt.Errorf("failed to create range covering existing log: %w", err)` (integrate.go:110)
	// wraps with %w, unlike most of this file's other error sites (`Prewarm: %v`,
	// `newRange.Append(): %v`, ...) which deliberately do not. This pins that the port
	// preserves the distinction — `wrapError` (cause set) here, plain message-only errors
	// elsewhere.
	describe("port additions: error wrapping", () => {
		it("wraps a getTiles failure with cause set, matching Go's %w", async () => {
			// getTiles fails inside newRange's Prewarm, which reports it with %v (not
			// wrapped: "Prewarm: <message>", no cause) — integrate() then wraps *that*
			// with %w ("failed to create range covering existing log: %w"), so the cause
			// one level up is the "Prewarm: boom" error, not `boom` itself.
			const boom = new Error("boom");
			const getTiles = async (): Promise<(HashTile | undefined)[]> => {
				throw boom;
			};

			await expect(integrate(getTiles, 255n, [Uint8Array.of(1)])).rejects.toMatchObject({
				message: "failed to create range covering existing log: Prewarm: boom",
				cause: expect.objectContaining({ message: "Prewarm: boom" }),
			});
		});
	});

	// minImpliedTreeSize is `(id.Index * layout.TileWidth) << (id.Level * 8)` on uint64s:
	// the product wraps, the shift count wraps, and a count of 64 or more yields 0
	// (docs/decisions/0014-uint64-wrapping-made-explicit.md). The expected values were
	// printed by storage/internal's minImpliedTreeSize at the pinned commit under Go 1.25.5.
	describe("port additions: minImpliedTreeSize wraps as Go's uint64 does", () => {
		const tests = [
			{ level: 0n, index: 1n, want: 256n },
			{ level: 1n, index: 1n, want: 65536n },
			{ level: 7n, index: 1n, want: 0n },
			{ level: 8n, index: 1n, want: 0n },
			{ level: 0n, index: 72057594037927936n, want: 0n },
			{ level: 0n, index: 18446744073709551615n, want: 18446744073709551360n },
			{ level: 2305843009213693952n, index: 3n, want: 768n },
			{ level: 2305843009213693953n, index: 3n, want: 196608n },
			{ level: 2305843009213693953n, index: 81985529216486895n, want: 5001117282205630464n },
			{ level: 18446744073709551615n, index: 1n, want: 0n },
		];
		for (const tc of tests) {
			it(`{${tc.level} ${tc.index}}`, () => {
				expect(minImpliedTreeSize(new TileID(tc.level, tc.index))).toBe(tc.want);
			});
		}
	});
});

/** permutations returns every ordering of xs. */
function permutations<T>(xs: readonly T[]): T[][] {
	if (xs.length <= 1) {
		return [[...xs]];
	}
	const out: T[][] = [];
	xs.forEach((x, i) => {
		for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) {
			out.push([x, ...rest]);
		}
	});
	return out;
}

/** leafHashes returns the RFC 6962 leaf hashes of the two-byte little-endian encodings of [from, from+n). */
function leafHashes(from: number, n: number): Uint8Array[] {
	return Array.from({ length: n }, (_, k) => DefaultHasher.hashLeaf(Uint8Array.of((from + k) & 0xff, (from + k) >> 8)));
}

/** zeroTile creates a new api.HashTile of the provided size, whose leaves are all a single zero byte. */
function zeroTile(size: number): HashTile {
	const nodes: Uint8Array[] = new Array(size);
	for (let i = 0; i < size; i++) {
		nodes[i] = Uint8Array.of(0);
	}
	return new HashTile(nodes);
}

/**
 * memTileStore is a minimal in-memory store used only by these tests, mirroring Go's
 * generic `memTileStore[T]`. TypeScript generics are erased at runtime, so the two
 * instantiations (`memTileStore<HashTile>`, `memTileStore<populatedTile>`) needed here are
 * expressed the same way Go's would be: one generic class, parameterised per call site.
 */
class memTileStore<T> {
	private readonly mem = new Map<string, T>();

	getTile = (id: TileID, treeSize: bigint): T | undefined => {
		const k = tilePath(id.level, id.index, partialTileSize(id.level, id.index, treeSize));
		return this.mem.get(k);
	};

	getTiles = async (ids: readonly TileID[], treeSize: bigint): Promise<(T | undefined)[]> => {
		return ids.map((id) => {
			const k = tilePath(id.level, id.index, partialTileSize(id.level, id.index, treeSize));
			return this.mem.get(k);
		});
	};

	setTile(id: TileID, treeSize: bigint, t: T): void {
		const k = tilePath(id.level, id.index, partialTileSize(id.level, id.index, treeSize));
		if (this.mem.has(k)) {
			throw new Error(`${k} is already present`);
		}
		this.mem.set(k, t);
	}
}

function newMemTileStore<T>(): memTileStore<T> {
	return new memTileStore<T>();
}
