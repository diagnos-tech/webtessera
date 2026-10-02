// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/fsck/status_test.go @ 4a6d9f9

import { describe, expect, it } from "vitest";
import { EntryBundleWidth } from "../api/layout/index.ts";
import { newRangeTracker, OK, Range, type State, stateString } from "./status.ts";

const entryBundleWidth64 = BigInt(EntryBundleWidth);

interface Update {
	readonly idx: bigint;
	readonly s: State;
}

describe("TestUpdate", () => {
	const tests: {
		name: string;
		size: bigint;
		updates: Update[];
		wantRanges: Range[];
	}[] = [
		{
			name: "no updates",
			size: 3n * entryBundleWidth64,
			updates: [],
			wantRanges: [new Range(0n, 3n)],
		},
		{
			name: "Split head",
			size: 5n * entryBundleWidth64,
			updates: [{ idx: 0n, s: OK }],
			wantRanges: [new Range(0n, 1n, OK), new Range(1n, 4n)],
		},
		{
			name: "Split middle",
			size: 11n * entryBundleWidth64,
			updates: [{ idx: 3n, s: OK }],
			wantRanges: [new Range(0n, 3n), new Range(3n, 1n, OK), new Range(4n, 7n)],
		},
		{
			name: "Split tail",
			size: 13n * entryBundleWidth64,
			updates: [{ idx: 12n, s: OK }],
			wantRanges: [new Range(0n, 12n), new Range(12n, 1n, OK)],
		},
		{
			name: "Multi-split",
			size: 10n * entryBundleWidth64,
			updates: [
				{ idx: 1n, s: OK },
				{ idx: 5n, s: OK },
				{ idx: 7n, s: OK },
			],
			wantRanges: [
				new Range(0n, 1n),
				new Range(1n, 1n, OK),
				new Range(2n, 3n),
				new Range(5n, 1n, OK),
				new Range(6n, 1n),
				new Range(7n, 1n, OK),
				new Range(8n, 2n),
			],
		},
		{
			name: "Coalesce before",
			size: 500n * entryBundleWidth64,
			updates: [
				{ idx: 1n, s: OK },
				{ idx: 0n, s: OK },
			],
			wantRanges: [new Range(0n, 2n, OK), new Range(2n, 498n)],
		},
		{
			name: "Coalesce after",
			size: 1000n * entryBundleWidth64,
			updates: [
				{ idx: 1n, s: OK },
				{ idx: 2n, s: OK },
			],
			wantRanges: [new Range(0n, 1n), new Range(1n, 2n, OK), new Range(3n, 997n)],
		},
		{
			name: "Coalesce first",
			size: 10n * entryBundleWidth64,
			updates: [
				{ idx: 0n, s: OK },
				{ idx: 1n, s: OK },
			],
			wantRanges: [new Range(0n, 2n, OK), new Range(2n, 8n)],
		},
		{
			name: "Coalesce last",
			size: 10n * entryBundleWidth64,
			updates: [
				{ idx: 9n, s: OK },
				{ idx: 8n, s: OK },
			],
			wantRanges: [new Range(0n, 8n), new Range(8n, 2n, OK)],
		},
		{
			name: "Coalesce degenerate",
			size: 10n * entryBundleWidth64,
			updates: [
				{ idx: 9n, s: OK },
				{ idx: 7n, s: OK },
				{ idx: 5n, s: OK },
				{ idx: 3n, s: OK },
				{ idx: 1n, s: OK },
				{ idx: 8n, s: OK },
				{ idx: 6n, s: OK },
				{ idx: 4n, s: OK },
				{ idx: 2n, s: OK },
				{ idx: 0n, s: OK },
			],
			wantRanges: [new Range(0n, 10n, OK)],
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			const s = newRangeTracker(test.size);
			for (const u of test.updates) {
				s.update(-1, u.idx, u.s);
			}
			let p = s._entries.front();
			for (let i = 0; i < test.wantRanges.length; i++) {
				const want = test.wantRanges[i] as Range;
				if (p === null) {
					expect.fail(`got ${i} entry ranges, want ${test.wantRanges.length}`);
				}
				const got = p.value;
				expect(got, `range ${i}\nDUMP:\n${s.dumpRanges().join("\n")}`).toEqual(want);
				p = p.next();
			}
			expect(p, "got more ranges than expected").toBeNull();
		});
	}
});

// Not part of upstream status_test.go: `State.String`'s default `panic` branch (here,
// `stateString`'s throw) and `rangeTracker.Update`'s "no such tile level" panic have no
// covering case in status_test.go. Both are genuine safety nets worth pinning directly.

it("stateString throws on an unknown state", () => {
	expect(() => stateString(42)).toThrow("unknown state 42");
});

it("rangeTracker.update throws for a tile level beyond what the tracker holds", () => {
	const s = newRangeTracker(3n * entryBundleWidth64);
	expect(() => s.update(5, 0n, OK)).toThrow("no such tile level 5");
});
