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
// There is no tileid_test.go upstream (tileid.go is a two-field value type with no
// behaviour of its own), but its fidelity matters a lot: every tile persisted by this
// package is addressed by a TileID, so these tests exist specifically to pin
// tileIDKey's collision-freedom, which the rest of this package's Map-keyed caches rely
// on. See PORTING.md's mission brief for storage/internal.

import { describe, expect, it } from "vitest";
import { TileID, tileIDKey } from "./tileid.ts";

describe("storage/internal/TileID", () => {
	it("stores the level and index it was constructed with", () => {
		const id = new TileID(3n, 4096n);
		expect(id.level).toBe(3n);
		expect(id.index).toBe(4096n);
	});

	it("accepts a zero-valued TileID, mirroring Go's TileID{} zero value", () => {
		const id = new TileID(0n, 0n);
		expect(id.level).toBe(0n);
		expect(id.index).toBe(0n);
	});
});

describe("storage/internal/tileIDKey", () => {
	it("produces equal keys for equal (level, index) pairs", () => {
		expect(tileIDKey(new TileID(1n, 2n))).toBe(tileIDKey(new TileID(1n, 2n)));
	});

	it("produces distinct keys for distinct levels", () => {
		expect(tileIDKey(new TileID(1n, 2n))).not.toBe(tileIDKey(new TileID(2n, 2n)));
	});

	it("produces distinct keys for distinct indices", () => {
		expect(tileIDKey(new TileID(1n, 2n))).not.toBe(tileIDKey(new TileID(1n, 3n)));
	});

	it("does not collide across the level/index boundary", () => {
		// "1/23" vs "12/3": if the separator were ever ambiguous, these would clash.
		expect(tileIDKey(new TileID(1n, 23n))).not.toBe(tileIDKey(new TileID(12n, 3n)));
	});

	it("is usable as a genuine Map key", () => {
		const m = new Map<string, string>();
		m.set(tileIDKey(new TileID(0n, 0n)), "a");
		m.set(tileIDKey(new TileID(0n, 1n)), "b");
		expect(m.get(tileIDKey(new TileID(0n, 0n)))).toBe("a");
		expect(m.get(tileIDKey(new TileID(0n, 1n)))).toBe("b");
		expect(m.size).toBe(2);
	});

	it("handles values near the top of the uint64 range", () => {
		const max = 0xffffffffffffffffn;
		expect(tileIDKey(new TileID(63n, max))).toBe(`63/${max}`);
	});
});
