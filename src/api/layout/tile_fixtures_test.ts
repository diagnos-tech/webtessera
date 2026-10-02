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

// Golden-fixture coverage for api/layout/tile.ts. See the header of
// paths_fixtures_test.ts for why these live outside the Go-mirrored test file.
//
// partialTileSize has no dedicated test upstream — it is only reached through
// EntriesPathForLogIndex and Range — so this fixture is its only direct coverage,
// across 864 (level, index, logSize) combinations.

import { beforeAll, describe, expect, it } from "vitest";
import { type Fixture, loadFixture, u64 } from "../../testonly/fixtures.ts";
import { EntryBundleWidth, nodeCoordsToTileAddress, partialTileSize, TileHeight, TileWidth } from "./tile.ts";

interface LayoutTileFixture {
	readonly tileHeight: number;
	readonly tileWidth: number;
	readonly entryBundleWidth: number;
	readonly partialTileSize: readonly { level: string; index: string; logSize: string; want: number }[];
	readonly nodeCoordsToTileAddress: readonly {
		treeLevel: string;
		treeIndex: string;
		tileLevel: string;
		tileIndex: string;
		nodeLevel: number;
		nodeIndex: string;
	}[];
}

describe("golden fixtures: layout_tile", () => {
	let fx: Fixture<LayoutTileFixture>;

	beforeAll(async () => {
		fx = await loadFixture<LayoutTileFixture>("layout_tile");
	});

	it("spec constants", () => {
		expect(TileHeight).toBe(fx.tileHeight);
		expect(TileWidth).toBe(fx.tileWidth);
		expect(EntryBundleWidth).toBe(fx.entryBundleWidth);
	});

	it("partialTileSize", () => {
		expect(fx.partialTileSize.length).toBeGreaterThan(0);
		for (const c of fx.partialTileSize) {
			const got = partialTileSize(u64(c.level), u64(c.index), u64(c.logSize));
			expect(got, `partialTileSize(${c.level}, ${c.index}, ${c.logSize})`).toBe(c.want);
		}
	});

	it("nodeCoordsToTileAddress", () => {
		expect(fx.nodeCoordsToTileAddress.length).toBeGreaterThan(0);
		for (const c of fx.nodeCoordsToTileAddress) {
			const where = `nodeCoordsToTileAddress(${c.treeLevel}, ${c.treeIndex})`;
			const got = nodeCoordsToTileAddress(u64(c.treeLevel), u64(c.treeIndex));
			expect(got.tileLevel, `${where}.tileLevel`).toBe(u64(c.tileLevel));
			expect(got.tileIndex, `${where}.tileIndex`).toBe(u64(c.tileIndex));
			expect(got.nodeLevel, `${where}.nodeLevel`).toBe(c.nodeLevel);
			expect(got.nodeIndex, `${where}.nodeIndex`).toBe(u64(c.nodeIndex));
		}
	});
});
