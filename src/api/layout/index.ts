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

// Package layout contains routines for specifying the path layout of Tessera logs,
// which is really to say that it provides functions to calculate paths used by the
// [tlog-tiles API].
//
// [tlog-tiles API]: https://c2sp.org/tlog-tiles
//
// This barrel is the TypeScript stand-in for Go's package clause: a Go consumer writes
// `layout.TilePath(...)` after importing the directory, so the directory needs a single
// entry point. It re-exports paths.ts and tile.ts and adds nothing of its own.

export {
	CheckpointPath,
	entriesPath,
	entriesPathForLogIndex,
	nWithSuffix,
	parseTileIndexPartial,
	parseTileLevel,
	parseTileLevelIndexPartial,
	type RangeInfo,
	range,
	type TileIndexPartial,
	type TileLevelIndexPartial,
	tilePath,
} from "./paths.ts";
export {
	EntryBundleWidth,
	nodeCoordsToTileAddress,
	partialTileSize,
	type TileAddress,
	TileHeight,
	TileWidth,
} from "./tile.ts";
