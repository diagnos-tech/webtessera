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
// Ported from tessera/api/layout/tile.go @ 4a6d9f9

// TileHeight is the maximum number of levels Merkle tree levels a tile represents.
// This is fixed at 8 by tlog-tile spec.
export const TileHeight = 8;
// TileWidth is the maximum number of hashes which can be present in the bottom row of a tile.
export const TileWidth = 1 << TileHeight;
// EntryBundleWidth is the maximum number of entries which can be present in an EntryBundle.
// This is defined to be the same as the width of the node tiles by tlog-tile spec.
export const EntryBundleWidth = TileWidth;

// Port note: the constants above are untyped in Go, so each use site adopts whichever
// integer type it needs. TypeScript has no such thing, so they are exported as `number`
// — which is what a caller comparing them against a slice length wants — and the
// arithmetic that Go performs in uint64 uses the bigint companions below.
// See docs/decisions/0030-untyped-go-constants.md.
const tileHeight64 = BigInt(TileHeight);
const tileWidth64 = BigInt(TileWidth);

/**
 * TileAddress is the address of a tree node in tile space.
 *
 * Port note: Go returns the four values positionally from NodeCoordsToTileAddress.
 * TypeScript has no positional-return convention, so they are named here.
 * See docs/decisions/0031-multi-value-returns.md.
 */
export interface TileAddress {
	/** tileLevel is the level of the tile within the tree, in tile space. */
	readonly tileLevel: bigint;
	/** tileIndex is the index of the tile at that level, in tile space. */
	readonly tileIndex: bigint;
	/** nodeLevel is the level of the node within the tile. */
	readonly nodeLevel: number;
	/** nodeIndex is the index of the node at that level within the tile. */
	readonly nodeIndex: bigint;
}

// PartialTileSize returns the expected number of leaves in a tile at the given tile level and index
// within a tree of the specified logSize, or 0 if the tile is expected to be fully populated.
export function partialTileSize(level: bigint, index: bigint, logSize: bigint): number {
	const sizeAtLevel = logSize >> (level * tileHeight64);
	const fullTiles = sizeAtLevel / tileWidth64;
	if (index < fullTiles) {
		return 0;
	}
	return Number(sizeAtLevel % tileWidth64);
}

// NodeCoordsToTileAddress returns the (TileLevel, TileIndex) in tile-space, and the
// (NodeLevel, NodeIndex) address within that tile of the specified tree node co-ordinates.
export function nodeCoordsToTileAddress(treeLevel: bigint, treeIndex: bigint): TileAddress {
	const tileRowWidth = 1n << (tileHeight64 - (treeLevel % tileHeight64));
	const tileLevel = treeLevel / tileHeight64;
	const tileIndex = treeIndex / tileRowWidth;
	const nodeLevel = Number(treeLevel % tileHeight64);
	const nodeIndex = treeIndex % tileRowWidth;

	return { tileLevel, tileIndex, nodeLevel, nodeIndex };
}
