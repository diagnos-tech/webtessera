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
// Golden-fixture coverage for storage/internal/integrate.ts. See the header of
// api/layout/paths_fixtures_test.ts for why these live outside the Go-mirrored test file.
//
// This is the strongest evidence in this package: log_<N>.json is a complete tlog-tiles
// log built end to end by the real Tessera POSIX driver (fixtures/gen/log.go) — every
// tile, every entry bundle, and the signed checkpoint, read back off disk. Feeding the
// same entries through this port's integrate() and asserting the resulting tiles and root
// hash are byte-identical proves this port builds the same tree Tessera does, not just
// that its isolated functions behave. Previously unclaimed by any test (docs/PORTING-MAP.md).

import { describe, expect, it } from "vitest";
import { HashTile } from "../../api/state.ts";
import { newEntry } from "../../entry.ts";
import { bytesToHex, hexToBytes, loadFixture } from "../../testonly/fixtures.ts";
import { type GetTilesFunc, integrate } from "./integrate.ts";
import { TileID, tileIDKey } from "./tileid.ts";

interface LogFixtureTile {
	readonly path: string;
	readonly raw: string;
	readonly level: string;
	readonly index: string;
	readonly partial: number;
	readonly nodes: number;
}

interface LogFixture {
	readonly origin: string;
	readonly logVkey: string;
	readonly entryScheme: string;
	readonly size: string;
	readonly checkpoint: string;
	readonly checkpointText: string;
	readonly checkpointOrigin: string;
	readonly checkpointSize: string;
	readonly checkpointHash: string;
	readonly tiles: readonly LogFixtureTile[];
	readonly entryBundles: readonly { path: string; raw: string; index: string; partial: number; entries: number }[];
}

const textEncoder = new TextEncoder();

/** entryData reproduces fixtures/gen/log.go's entryScheme: `entry-<i>` as UTF-8 bytes. */
function entryData(i: number): Uint8Array {
	return textEncoder.encode(`entry-${i}`);
}

/** leafHashesFor computes the RFC6962 leaf hashes for entries [from, to) the same way tessera.NewEntry does. */
function leafHashesFor(from: number, to: number): Uint8Array[] {
	const hashes: Uint8Array[] = [];
	for (let i = from; i < to; i++) {
		hashes.push(newEntry(entryData(i)).leafHash());
	}
	return hashes;
}

/** tilesByAddress indexes a fixture's tiles by "level/index" for building a GetTilesFunc. */
function tilesByAddress(fx: LogFixture): Map<string, HashTile> {
	const m = new Map<string, HashTile>();
	for (const t of fx.tiles) {
		const tile = new HashTile();
		tile.unmarshalText(hexToBytes(t.raw));
		m.set(tileIDKey(new TileID(BigInt(t.level), BigInt(t.index))), tile);
	}
	return m;
}

/** getTilesFrom builds a GetTilesFunc backed by a fixture's already-persisted tiles. */
function getTilesFrom(byAddress: Map<string, HashTile>): GetTilesFunc {
	return async (tileIDs) => tileIDs.map((id) => byAddress.get(tileIDKey(id)));
}

/** assertMatchesFixture asserts an integrate() result reproduces a log_<N>.json fixture exactly. */
function assertMatchesFixture(
	fx: LogFixture,
	result: { newSize: bigint; rootHash: Uint8Array; tiles: ReadonlyMap<string, { id: TileID; tile: HashTile }> },
): void {
	expect(result.newSize, fx.size).toBe(BigInt(fx.size));
	expect(bytesToHex(result.rootHash), fx.size).toBe(fx.checkpointHash);

	const gotKeys = new Set(result.tiles.keys());
	expect(gotKeys.size, `size ${fx.size}: tile count`).toBe(fx.tiles.length);
	for (const want of fx.tiles) {
		const key = tileIDKey(new TileID(BigInt(want.level), BigInt(want.index)));
		const got = result.tiles.get(key);
		expect(got, `size ${fx.size}: missing tile ${want.path}`).toBeDefined();
		expect(bytesToHex((got as { tile: HashTile }).tile.marshalText()), `size ${fx.size}: tile ${want.path}`).toBe(
			want.raw,
		);
		gotKeys.delete(key);
	}
	expect([...gotKeys], `size ${fx.size}: unexpected extra tiles`).toEqual([]);
}

describe("golden fixtures: log_<N> (build from scratch)", () => {
	const sizes = [0, 1, 2, 255, 256, 257, 1000, 5000];

	for (const size of sizes) {
		it(`log_${size}: integrate(0, all leaves) reproduces the fixture byte-for-byte`, async () => {
			const fx = await loadFixture<LogFixture>(`log_${size}`);
			expect(fx.size).toBe(String(size));

			const leafHashes = leafHashesFor(0, size);
			const getTiles: GetTilesFunc = async (tileIDs) => tileIDs.map(() => undefined);

			const result = await integrate(getTiles, 0n, leafHashes);

			assertMatchesFixture(fx, result);
		});
	}
});

describe("golden fixtures: log_<N> (resume an existing tree)", () => {
	// The interesting boundary crossings: 255 (one leaf short of a full bottom tile),
	// 256 (exactly a full tile, first level-1 tile appears), 257 (one leaf into a second
	// bottom tile). Resuming across these exercises tileWriteCache's fallback path that
	// fetches an existing partial tile to extend it — see the treeBuilder Port note in
	// integrate.ts for why that fetch is safe to make synchronous.
	const crossings: readonly [number, number][] = [
		[255, 256],
		[256, 257],
	];

	for (const [fromSizeNum, toSizeNum] of crossings) {
		it(`resuming from log_${fromSizeNum} to log_${toSizeNum} reproduces the fixture byte-for-byte`, async () => {
			const fromFx = await loadFixture<LogFixture>(`log_${fromSizeNum}`);
			const toFx = await loadFixture<LogFixture>(`log_${toSizeNum}`);

			const byAddress = tilesByAddress(fromFx);
			const getTiles = getTilesFrom(byAddress);
			const leafHashes = leafHashesFor(fromSizeNum, toSizeNum);

			const result = await integrate(getTiles, BigInt(fromSizeNum), leafHashes);

			// integrate() returns only the tiles it actually touched (Go's "dirty tiles
			// which need to be flushed", storage/internal/integrate.go's tileWriteCache
			// doc comment) — e.g. resuming 256->257 with one new leaf only dirties the
			// brand-new tile{0,1}, not the untouched tile{0,0}/tile{1,0} that log_257.json
			// still lists in full. A real storage driver persists dirty tiles on top of
			// what is already on disk, so the fixture comparison does the same: merge the
			// delta onto the "from" snapshot before comparing against the "to" fixture.
			for (const { id, tile } of result.tiles.values()) {
				byAddress.set(tileIDKey(id), tile);
			}

			assertMatchesFixture(toFx, {
				newSize: result.newSize,
				rootHash: result.rootHash,
				tiles: new Map([...byAddress].map(([k, tile]) => [k, { id: keyToTileID(k), tile }])),
			});
		});
	}

	it("resuming 0 -> 255 -> 256 -> 257 one entry at a time still reproduces log_257", async () => {
		// A stronger version of the pairwise crossings above: integrate one entry at a
		// time from an empty tree all the way through both boundaries, carrying the
		// growing tile set forward as the "existing storage" for each next call — this is
		// exactly how a real storage driver would call integrate() repeatedly. Each call's
		// own result.tiles already reflects that tile's full content after the update
		// (not a delta), so accumulating them by key keeps byAddress correct throughout,
		// and the final call's result is the size-257 state the fixture describes.
		const toFx = await loadFixture<LogFixture>("log_257");

		let size = 0n;
		const byAddress = new Map<string, HashTile>();
		let last:
			| { newSize: bigint; rootHash: Uint8Array; tiles: ReadonlyMap<string, { id: TileID; tile: HashTile }> }
			| undefined;
		for (let i = 0; i < 257; i++) {
			const getTiles = getTilesFrom(byAddress);
			const result = await integrate(getTiles, size, [newEntry(entryData(i)).leafHash()]);
			expect(result.newSize).toBe(size + 1n);
			for (const { id, tile } of result.tiles.values()) {
				byAddress.set(tileIDKey(id), tile);
			}
			size = result.newSize;
			last = result;
		}

		// The last call only reports the tiles it touched, but log_257.json lists every
		// tile in the log; assemble the full picture from the accumulated cache before
		// comparing size/root (from the last call) against every tile (accumulated).
		assertMatchesFixture(toFx, {
			newSize: (last as NonNullable<typeof last>).newSize,
			rootHash: (last as NonNullable<typeof last>).rootHash,
			tiles: new Map([...byAddress].map(([k, tile]) => [k, { id: keyToTileID(k), tile }])),
		});
	});
});

/** keyToTileID inverts tileIDKey for the final assertion's tiles map. */
function keyToTileID(key: string): TileID {
	const [level, index] = key.split("/");
	return new TileID(BigInt(level as string), BigInt(index as string));
}
