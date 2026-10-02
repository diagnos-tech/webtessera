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
// Ported from tessera/api/layout/tile_test.go @ 4a6d9f9

import { describe, expect, it } from "vitest";
import { nodeCoordsToTileAddress } from "./tile.ts";

describe("TestNodeCoordsToTileAddress", () => {
	const tests: {
		treeLevel: bigint;
		treeIndex: bigint;
		wantTileLevel: bigint;
		wantTileIndex: bigint;
		wantNodeLevel: number;
		wantNodeIndex: bigint;
	}[] = [
		{
			treeLevel: 0n,
			treeIndex: 0n,
			wantTileLevel: 0n,
			wantTileIndex: 0n,
			wantNodeLevel: 0,
			wantNodeIndex: 0n,
		},
		{
			treeLevel: 0n,
			treeIndex: 255n,
			wantTileLevel: 0n,
			wantTileIndex: 0n,
			wantNodeLevel: 0,
			wantNodeIndex: 255n,
		},
		{
			treeLevel: 0n,
			treeIndex: 256n,
			wantTileLevel: 0n,
			wantTileIndex: 1n,
			wantNodeLevel: 0,
			wantNodeIndex: 0n,
		},
		{
			treeLevel: 1n,
			treeIndex: 0n,
			wantTileLevel: 0n,
			wantTileIndex: 0n,
			wantNodeLevel: 1,
			wantNodeIndex: 0n,
		},
		{
			treeLevel: 8n,
			treeIndex: 0n,
			wantTileLevel: 1n,
			wantTileIndex: 0n,
			wantNodeLevel: 0,
			wantNodeIndex: 0n,
		},
	];

	for (const test of tests) {
		it(`${test.treeLevel}-${test.treeIndex}`, () => {
			const { tileLevel, tileIndex, nodeLevel, nodeIndex } = nodeCoordsToTileAddress(test.treeLevel, test.treeIndex);
			expect(tileLevel).toBe(test.wantTileLevel);
			expect(tileIndex).toBe(test.wantTileIndex);
			expect(nodeLevel).toBe(test.wantNodeLevel);
			expect(nodeIndex).toBe(test.wantNodeIndex);
		});
	}
});
