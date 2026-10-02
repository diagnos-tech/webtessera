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
// Ported from tessera/api/layout/example_test.go @ 4a6d9f9
//
// Port note: Go's testable examples run under `go test` and are verified against
// their trailing `// Output:` comment. TypeScript has no equivalent mechanism, so
// each example is a test which formats the same string and asserts it equals the
// output Go declares. The formatted string is kept character-for-character
// identical so the two files still diff cleanly.
// See docs/decisions/0033-go-examples-as-assertion-tests.md.
//
// Like upstream's `package layout_test`, this file imports the package from
// outside, through the barrel, so it exercises the public surface.

import { describe, expect, it } from "vitest";
import { entriesPath, nodeCoordsToTileAddress, parseTileLevelIndexPartial, tilePath } from "./index.ts";

describe("layout examples", () => {
	it("ExampleNodeCoordsToTileAddress", () => {
		const treeLevel = 8n;
		const treeIndex = 123456789n;
		const { tileLevel, tileIndex, nodeLevel, nodeIndex } = nodeCoordsToTileAddress(treeLevel, treeIndex);
		const out = `tile level: ${tileLevel}, tile index: ${tileIndex}, node level: ${nodeLevel}, node index: ${nodeIndex}`;
		// Output: tile level: 1, tile index: 482253, node level: 0, node index: 21
		expect(out).toBe("tile level: 1, tile index: 482253, node level: 0, node index: 21");
	});

	it("ExampleTilePath", () => {
		const path = tilePath(0n, 1234067n, 8);
		const out = `tile path: ${path}`;
		// Output: tile path: tile/0/x001/x234/067.p/8
		expect(out).toBe("tile path: tile/0/x001/x234/067.p/8");
	});

	it("ExampleEntriesPath", () => {
		const path = entriesPath(1234067n, 8);
		const out = `entries path: ${path}`;
		// Output: entries path: tile/entries/x001/x234/067.p/8
		expect(out).toBe("entries path: tile/entries/x001/x234/067.p/8");
	});

	it("ExampleParseTileLevelIndexPartial", () => {
		const { level, index, width } = parseTileLevelIndexPartial("0", "x001/x234/067.p/8");
		const out = `level: ${level}, index: ${index}, width: ${width}`;
		// Output: level: 0, index: 1234067, width: 8
		expect(out).toBe("level: 0, index: 1234067, width: 8");
	});
});
