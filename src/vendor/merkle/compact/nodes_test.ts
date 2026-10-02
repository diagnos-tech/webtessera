// Copyright 2019 Google LLC. All Rights Reserved.
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
// Ported from merkle/compact/nodes_test.go @ v0.0.2

import { describe, expect, it } from "vitest";
import { type NodeID, newNodeID, rangeNodes, rangeSize } from "./nodes.ts";

describe("TestRangeNodesAndSize", () => {
	const n = (level: number, index: bigint): NodeID => {
		return newNodeID(level, index);
	};
	const tests: { begin: bigint; end: bigint; want: NodeID[] }[] = [
		// Empty ranges.
		{ begin: 0n, end: 0n, want: [] },
		{ begin: 10n, end: 10n, want: [] },
		{ begin: 1024n, end: 1024n, want: [] },
		// One entry.
		{ begin: 10n, end: 11n, want: [n(0, 10n)] },
		{ begin: 1024n, end: 1025n, want: [n(0, 1024n)] },
		{ begin: 1025n, end: 1026n, want: [n(0, 1025n)] },
		// Two entries.
		{ begin: 10n, end: 12n, want: [n(1, 5n)] },
		{ begin: 1024n, end: 1026n, want: [n(1, 512n)] },
		{ begin: 1025n, end: 1027n, want: [n(0, 1025n), n(0, 1026n)] },
		// Only right border.
		{ begin: 0n, end: 1n, want: [n(0, 0n)] },
		{ begin: 0n, end: 2n, want: [n(1, 0n)] },
		{ begin: 0n, end: 3n, want: [n(1, 0n), n(0, 2n)] },
		{ begin: 0n, end: 4n, want: [n(2, 0n)] },
		{ begin: 0n, end: 5n, want: [n(2, 0n), n(0, 4n)] },
		{ begin: 0n, end: 15n, want: [n(3, 0n), n(2, 2n), n(1, 6n), n(0, 14n)] },
		{ begin: 0n, end: 100n, want: [n(6, 0n), n(5, 2n), n(2, 24n)] },
		{ begin: 0n, end: 513n, want: [n(9, 0n), n(0, 512n)] },
		{ begin: 0n, end: 1n << 63n, want: [n(63, 0n)] },
		{ begin: 0n, end: (1n << 63n) + (1n << 57n), want: [n(63, 0n), n(57, 64n)] },
		// Only left border.
		{ begin: 0n, end: 16n, want: [n(4, 0n)] },
		{ begin: 1n, end: 16n, want: [n(0, 1n), n(1, 1n), n(2, 1n), n(3, 1n)] },
		{ begin: 2n, end: 16n, want: [n(1, 1n), n(2, 1n), n(3, 1n)] },
		{ begin: 3n, end: 16n, want: [n(0, 3n), n(2, 1n), n(3, 1n)] },
		{ begin: 4n, end: 16n, want: [n(2, 1n), n(3, 1n)] },
		{ begin: 6n, end: 16n, want: [n(1, 3n), n(3, 1n)] },
		{ begin: 8n, end: 16n, want: [n(3, 1n)] },
		{ begin: 11n, end: 16n, want: [n(0, 11n), n(2, 3n)] },
		// Two-sided.
		{
			begin: 1n,
			end: 31n,
			want: [n(0, 1n), n(1, 1n), n(2, 1n), n(3, 1n), n(3, 2n), n(2, 6n), n(1, 14n), n(0, 30n)],
		},
		{ begin: 1n, end: 17n, want: [n(0, 1n), n(1, 1n), n(2, 1n), n(3, 1n), n(0, 16n)] },
	];

	for (const tc of tests) {
		it(`range:${tc.begin}:${tc.end}`, () => {
			const got = rangeNodes(tc.begin, tc.end, []);
			expect(got).toEqual(tc.want);
			expect(rangeSize(tc.begin, tc.end)).toBe(tc.want.length);
		});
	}
});

describe("TestRangeNodesAppend", () => {
	it("appends to the given slice", () => {
		const prefix = [newNodeID(0, 0n), newNodeID(10, 0n), newNodeID(11, 5n)];
		const nodes = rangeNodes(123n, 456n, prefix);

		expect(nodes.length).toBeGreaterThanOrEqual(prefix.length);
		const got = nodes.slice(0, prefix.length);
		expect(got).toEqual(prefix);
	});
});

describe("TestGenRangeNodes", () => {
	it("matches the reference implementation", () => {
		const size = 512n;
		for (let begin = 0n; begin <= size; begin++) {
			for (let end = begin; end <= size; end++) {
				const got = rangeNodes(begin, end, []);
				const want = refRangeNodes(newNodeID(63, 0n), begin, end);
				// Port note: this runs ~131k comparisons; `expect(...).toEqual(...)`
				// on every one of them dominates the runtime, so the equality is
				// computed directly and the assertion only reports the mismatch.
				if (!sameNodes(got, want)) {
					expect(got, `rangeNodes(${begin}, ${end})`).toEqual(want);
				}
			}
		}
	}, 120000);
});

// sameNodes reports whether two node ID lists are identical.
function sameNodes(a: readonly NodeID[], b: readonly NodeID[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as NodeID;
		const y = b[i] as NodeID;
		if (x.level !== y.level || x.index !== y.index) {
			return false;
		}
	}
	return true;
}

// refRangeNodes returns node IDs that comprise the [begin, end) compact range.
// This is a reference implementation for cross-checking.
function refRangeNodes(root: NodeID, begin: bigint, end: bigint): NodeID[] {
	const [b, e] = root.coverage();
	if (end <= b || begin >= e) {
		return [];
	}
	if (b >= begin && e <= end) {
		return [root];
	}
	return [
		...refRangeNodes(newNodeID(root.level - 1, root.index * 2n), begin, end),
		...refRangeNodes(newNodeID(root.level - 1, root.index * 2n + 1n), begin, end),
	];
}
