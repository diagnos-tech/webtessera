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
import { bytesEqual } from "../../internal/gostd/bytes.ts";
import type { NodeID } from "../../vendor/merkle/compact/index.ts";
import { newNodeID, RangeFactory } from "../../vendor/merkle/compact/index.ts";
import { DefaultHasher } from "../../vendor/merkle/rfc6962/rfc6962.ts";
import { integrate, newTileWriteCache, newTreeBuilder, type populatedTile } from "./integrate.ts";
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

		for (const test of tests) {
			const twc = newTileWriteCache(treeSize, m.getTile);
			const v = twc.visitor();
			for (const [id, hash] of test.visits) {
				v(id, hash);
			}
			expect(twc.err(), test.name).toBeUndefined();

			const gotTiles = twc.tiles();
			for (const [id, wantTile] of test.wantTiles) {
				const gotEntry = gotTiles.get(tileIDKey(id));
				expect(gotEntry, `${test.name}: missing tile ${tileIDKey(id)}`).toBeDefined();
				expect(gotEntry?.tile.nodes, test.name).toEqual(wantTile.nodes);
				gotTiles.delete(tileIDKey(id));
			}
			expect(gotTiles.size, `${test.name}: unexpected tiles: ${[...gotTiles.keys()]}`).toBe(0);
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

	// Below this line are port additions with no direct upstream case: Go's
	// `fmt.Errorf("failed to create range covering existing log: %w", err)` (integrate.go:110)
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
});

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
