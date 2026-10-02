// Copyright 2024 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/storage/internal/tileid.go @ 4a6d9f9

// TileID represents a tile address in tile-space.
export class TileID {
	readonly level: bigint;
	readonly index: bigint;

	constructor(level: bigint, index: bigint) {
		this.level = level;
		this.index = index;
	}
}

/**
 * tileIDKey returns a canonical string encoding of id, suitable for use as a JavaScript
 * Map key.
 *
 * Port note: Go's `TileID` is a plain struct with comparable (uint64) fields, so it is used
 * directly as a map key throughout storage/internal/integrate.go (`map[TileID]struct{}`,
 * `map[TileID]*populatedTile`, `map[TileID]*api.HashTile`). JavaScript's Map compares object
 * keys by identity, not by value, so two `new TileID(0n, 0n)` instances would be distinct
 * keys even though Go's `TileID{0, 0}` would collide as intended. This package uses
 * tileIDKey wherever Go relies on TileID's comparability. See
 * docs/decisions/0050-storage-internal-map-keys-and-callback-types.md.
 *
 * The two fields are unsigned decimal digits separated by "/", which cannot appear in
 * either field's rendering, so distinct (level, index) pairs never collide.
 */
export function tileIDKey(id: TileID): string {
	return `${id.level}/${id.index}`;
}
