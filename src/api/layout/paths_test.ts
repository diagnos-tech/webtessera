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
// Ported from tessera/api/layout/paths_test.go @ 4a6d9f9

import { describe, expect, it } from "vitest";
import {
	entriesPath,
	entriesPathForLogIndex,
	nWithSuffix,
	parseTileLevelIndexPartial,
	type RangeInfo,
	range,
	tilePath,
} from "./paths.ts";

// rangeInfo builds a RangeInfo from the fields a test case cares about, filling the
// rest with zero. It stands in for Go's composite literal, where unmentioned struct
// fields take their zero value.
function rangeInfo(want: Partial<RangeInfo>): RangeInfo {
	return { index: 0n, partial: 0, first: 0, n: 0, ...want };
}

describe("TestEntriesPathForLogIndex", () => {
	const tests: { seq: bigint; logSize: bigint; wantPath: string }[] = [
		{
			seq: 0n,
			logSize: 256n,
			wantPath: "tile/entries/000",
		},
		{
			seq: 255n,
			logSize: 256n,
			wantPath: "tile/entries/000",
		},
		{
			seq: 251n,
			logSize: 255n,
			wantPath: "tile/entries/000.p/255",
		},
		{
			seq: 256n,
			logSize: 512n,
			wantPath: "tile/entries/001",
		},
		{
			seq: 3n,
			logSize: 257n,
			wantPath: "tile/entries/000",
		},
		{
			seq: 256n,
			logSize: 257n,
			wantPath: "tile/entries/001.p/1",
		},
		{
			seq: 123456789n * 256n,
			logSize: 123456790n * 256n,
			wantPath: "tile/entries/x123/x456/789",
		},
	];

	for (const test of tests) {
		it(`seq ${test.seq}`, () => {
			const gotPath = entriesPathForLogIndex(test.seq, test.logSize);
			expect(gotPath).toBe(test.wantPath);
		});
	}
});

describe("TestEntriesPath", () => {
	const tests: { N: bigint; p: number; wantPath: string }[] = [
		{
			N: 0n,
			p: 0,
			wantPath: "tile/entries/000",
		},
		{
			N: 0n,
			p: 8,
			wantPath: "tile/entries/000.p/8",
		},
		{
			N: 255n,
			p: 0,
			wantPath: "tile/entries/255",
		},
		{
			N: 255n,
			p: 253,
			wantPath: "tile/entries/255.p/253",
		},
	];

	for (const test of tests) {
		it(`N ${test.N}`, () => {
			const gotPath = entriesPath(test.N, test.p);
			expect(gotPath).toBe(test.wantPath);
		});
	}
});

describe("TestTilePath", () => {
	const tests: { level: bigint; index: bigint; p: number; wantPath: string }[] = [
		{
			level: 0n,
			index: 0n,
			p: 0,
			wantPath: "tile/0/000",
		},
		{
			level: 0n,
			index: 0n,
			p: 255,
			wantPath: "tile/0/000.p/255",
		},
		{
			level: 1n,
			index: 0n,
			p: 0,
			wantPath: "tile/1/000",
		},
		{
			level: 15n,
			index: 455667n,
			p: 0,
			wantPath: "tile/15/x455/667",
		},
		{
			level: 15n,
			index: 123456789n,
			p: 41,
			wantPath: "tile/15/x123/x456/789.p/41",
		},
	];

	for (const test of tests) {
		it(`level ${test.level.toString(16)} index ${test.index.toString(16)}`, () => {
			const gotPath = tilePath(test.level, test.index, test.p);
			expect(gotPath).toBe(test.wantPath);
		});
	}
});

describe("TestNWithSuffix", () => {
	const tests: { level: bigint; index: bigint; p: number; wantPath: string }[] = [
		{
			level: 0n,
			index: 0n,
			p: 0,
			wantPath: "000",
		},
		{
			level: 0n,
			index: 0n,
			p: 255,
			wantPath: "000.p/255",
		},
		{
			level: 15n,
			index: 455667n,
			p: 0,
			wantPath: "x455/667",
		},
		{
			level: 15n,
			index: 123456789n,
			p: 65,
			wantPath: "x123/x456/789.p/65",
		},
	];

	for (const test of tests) {
		it(`level ${test.level.toString(16)} index ${test.index.toString(16)}`, () => {
			const gotPath = nWithSuffix(test.level, test.index, test.p);
			expect(gotPath).toBe(test.wantPath);
		});
	}
});

describe("TestParseTileLevelIndexPartial", () => {
	const tests: {
		pathLevel: string;
		pathIndex: string;
		wantLevel: bigint;
		wantIndex: bigint;
		wantP: number;
		wantErr: boolean;
	}[] = [
		{
			pathLevel: "0",
			pathIndex: "x001/x234/067",
			wantLevel: 0n,
			wantIndex: 1234067n,
			wantP: 0,
			wantErr: false,
		},
		{
			pathLevel: "0",
			pathIndex: "x001/x234/067.p/89",
			wantLevel: 0n,
			wantIndex: 1234067n,
			wantP: 89,
			wantErr: false,
		},
		{
			pathLevel: "63",
			pathIndex: "x999/x999/x999/x999/x999/999.p/255",
			wantLevel: 63n,
			wantIndex: 999999999999999999n,
			wantP: 255,
			wantErr: false,
		},
		{
			pathLevel: "0",
			pathIndex: "001",
			wantLevel: 0n,
			wantIndex: 1n,
			wantP: 0,
			wantErr: false,
		},
		{
			pathLevel: "0",
			pathIndex: "x001/x234/067.p/",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "0",
			pathIndex: "x001/x234/067.p",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "0",
			pathIndex: "x001/x234/",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "0",
			pathIndex: "x001/x234",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "0",
			pathIndex: "x001/",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "0",
			pathIndex: "x001",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "1",
			pathIndex: "x001/.p/abc",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "64",
			pathIndex: "x001/002",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "-1",
			pathIndex: "x001/002",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "abc",
			pathIndex: "x001/002",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "8",
			pathIndex: "001/002",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "8",
			pathIndex: "x001/0002",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "8",
			pathIndex: "x001/-002",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "8",
			pathIndex: "x001/002.p/256",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
		{
			pathLevel: "63",
			pathIndex: "x999/x999/x999/x999/x999/x999/999.p/255",
			wantLevel: 0n,
			wantIndex: 0n,
			wantP: 0,
			wantErr: true,
		},
	];

	for (const test of tests) {
		it(`pathLevel: ${JSON.stringify(test.pathLevel)}, pathIndex: ${JSON.stringify(test.pathIndex)}`, () => {
			// Port note: Go returns (0, 0, 0, err) on failure and the table asserts against
			// those zero values, so the port keeps the zero-valued defaults rather than
			// branching on wantErr — the assertions stay identical to upstream's.
			let gotLevel = 0n;
			let gotIndex = 0n;
			let gotWidth = 0;
			let gotErr = false;
			try {
				const got = parseTileLevelIndexPartial(test.pathLevel, test.pathIndex);
				gotLevel = got.level;
				gotIndex = got.index;
				gotWidth = got.width;
			} catch {
				gotErr = true;
			}
			expect(gotLevel).toBe(test.wantLevel);
			expect(gotIndex).toBe(test.wantIndex);
			expect(gotWidth).toBe(test.wantP);
			expect(gotErr).toBe(test.wantErr);
		});
	}
});

describe("TestRange", () => {
	const tests: { from: bigint; N: bigint; treeSize: bigint; desc: string; want: RangeInfo[] }[] = [
		{
			desc: "from beyond extent",
			from: 10n,
			N: 1n,
			treeSize: 5n,
			want: [],
		},
		{
			desc: "range end beyond extent",
			from: 3n,
			N: 100n,
			treeSize: 5n,
			want: [rangeInfo({ index: 0n, first: 3, n: 5 - 3, partial: 5 })],
		},
		{
			desc: "empty range",
			from: 1n,
			N: 0n,
			treeSize: 2n,
			want: [],
		},
		{
			desc: "ok: full first bundle",
			from: 0n,
			N: 256n,
			treeSize: 257n,
			want: [rangeInfo({ n: 256 })],
		},
		{
			desc: "ok: entire single (partial) bundle",
			from: 20n,
			N: 90n,
			treeSize: 111n,
			want: [rangeInfo({ index: 0n, partial: 111, first: 20, n: 90 })],
		},
		{
			desc: "ok: slice from single bundle with initial offset",
			from: 20n,
			N: 90n,
			treeSize: 1n << 20n,
			want: [rangeInfo({ index: 0n, partial: 0, first: 20, n: 90 })],
		},
		{
			desc: "ok: multiple bundles, first is full, last is truncated",
			from: 0n,
			N: 4n * 256n + 42n,
			treeSize: 1n << 20n,
			want: [
				rangeInfo({ index: 0n, partial: 0, first: 0, n: 256 }),
				rangeInfo({ index: 1n, partial: 0, first: 0, n: 256 }),
				rangeInfo({ index: 2n, partial: 0, first: 0, n: 256 }),
				rangeInfo({ index: 3n, partial: 0, first: 0, n: 256 }),
				rangeInfo({ index: 4n, partial: 0, first: 0, n: 42 }),
			],
		},
		{
			desc: "ok: multiple bundles, first is offset, last is truncated",
			from: 2n,
			N: 4n * 256n + 4n,
			treeSize: 1n << 20n,
			want: [
				rangeInfo({ index: 0n, partial: 0, first: 2, n: 256 - 2 }),
				rangeInfo({ index: 1n, partial: 0, first: 0, n: 256 }),
				rangeInfo({ index: 2n, partial: 0, first: 0, n: 256 }),
				rangeInfo({ index: 3n, partial: 0, first: 0, n: 256 }),
				rangeInfo({ index: 4n, partial: 0, first: 0, n: 6 }),
			],
		},
		{
			desc: "ok: offset and trucated from single bundle in middle of tree",
			from: 8n * 256n + 66n,
			N: 4n,
			treeSize: 1n << 20n,
			want: [rangeInfo({ index: 8n, partial: 0, first: 66, n: 4 })],
		},
	];

	for (const test of tests) {
		it(test.desc, () => {
			let i = 0;
			for (const gotInfo of range(test.from, test.N, test.treeSize)) {
				// Upstream indexes test.want[i] directly, so a surplus element panics the
				// test. Assert the bound explicitly, since reading past the end of a
				// TypeScript array yields undefined instead of failing.
				expect(i).toBeLessThan(test.want.length);
				expect(gotInfo).toEqual(test.want[i]);
				i++;
			}
			// Port note: upstream's loop cannot detect a short result. Assert the count too;
			// this only strengthens the test.
			expect(i).toBe(test.want.length);
		});
	}
});

// Port addition: Range's uint64 arithmetic wraps exactly as Go's does (ADR-0014). The
// expected values are what api/layout.Range printed at the pinned commit for the same
// arguments, truncated to the first four bundles.
describe("Port addition: Range wraps like Go's uint64 arithmetic", () => {
	const MaxUint64 = 0xffffffffffffffffn;
	const first4 = (from: bigint, N: bigint, treeSize: bigint): RangeInfo[] => {
		const got: RangeInfo[] = [];
		for (const ri of range(from, N, treeSize)) {
			got.push(ri);
			if (got.length === 4) {
				break;
			}
		}
		return got;
	};

	it("Range(1, MaxUint64, 10): from+N wraps, so N is not truncated", () => {
		// Go: {Index:0 Partial:10 First:1 N:255} {Index:1 Partial:0 First:0 N:256} {Index:2 ...} {Index:3 ...}
		expect(first4(1n, MaxUint64, 10n)).toEqual([
			{ index: 0n, partial: 10, first: 1, n: 255 },
			{ index: 1n, partial: 0, first: 0, n: 256 },
			{ index: 2n, partial: 0, first: 0, n: 256 },
			{ index: 3n, partial: 0, first: 0, n: 256 },
		]);
	});

	it("Range(10, MaxUint64-9, 20)", () => {
		// Go: {Index:0 Partial:20 First:10 N:246} {Index:1 Partial:0 First:0 N:256} {Index:2 ...} {Index:3 ...}
		expect(first4(10n, MaxUint64 - 9n, 20n)).toEqual([
			{ index: 0n, partial: 20, first: 10, n: 246 },
			{ index: 1n, partial: 0, first: 0, n: 256 },
			{ index: 2n, partial: 0, first: 0, n: 256 },
			{ index: 3n, partial: 0, first: 0, n: 256 },
		]);
	});

	it("Range(0, MaxUint64, 600): no wrap, truncated at the tree size", () => {
		// Go: {Index:0 Partial:0 First:0 N:256} {Index:1 Partial:0 First:0 N:256} {Index:2 Partial:88 First:0 N:88}
		expect(first4(0n, MaxUint64, 600n)).toEqual([
			{ index: 0n, partial: 0, first: 0, n: 256 },
			{ index: 1n, partial: 0, first: 0, n: 256 },
			{ index: 2n, partial: 88, first: 0, n: 88 },
		]);
	});

	it("Range(5, MaxUint64-2, 10): Go's uint N wraps to 18446744073709551613, which a number cannot hold", () => {
		// Go: {Index:0 Partial:10 First:5 N:18446744073709551613}
		expect(() => first4(5n, MaxUint64 - 2n, 10n)).toThrow(
			new RangeError("RangeInfo count 18446744073709551613 does not fit in a number"),
		);
	});
});
