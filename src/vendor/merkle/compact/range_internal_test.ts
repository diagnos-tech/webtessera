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
// Ported from merkle/compact/range_internal_test.go @ v0.0.2
//
// This mirrors Go's in-package test: it reaches for the members that are
// unexported upstream (Range's fields, getMergePath). They are `@internal` here
// and are deliberately not re-exported by ./index.ts.

import { describe, expect, it } from "vitest";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { getMergePath, Range, RangeFactory } from "./range.ts";

const factory = new RangeFactory(() => toUTF8("fake-hash"));

describe("TestAppendRangeErrors", () => {
	const anotherFactory = new RangeFactory(factory.hash);

	const nonEmpty1 = factory.newRange(7n, 8n, [toUTF8("hash")]);
	const nonEmpty2 = factory.newRange(0n, 6n, [toUTF8("hash0"), toUTF8("hash1")]);
	const nonEmpty3 = factory.newRange(6n, 7n, [toUTF8("hash")]);
	const corrupt = (rng: Range, dBegin: bigint, dEnd: bigint): Range => {
		rng._begin = rng._begin + dBegin;
		rng._end = rng._end + dEnd;
		return rng;
	};
	const tests: { desc: string; l: Range; r: Range; wantErr: string }[] = [
		{
			desc: "ok",
			l: factory.newEmptyRange(0n),
			r: factory.newEmptyRange(0n),
			wantErr: "",
		},
		{
			desc: "incompatible",
			l: factory.newEmptyRange(0n),
			r: anotherFactory.newEmptyRange(0n),
			wantErr: "incompatible ranges",
		},
		{
			desc: "disjoint",
			l: factory.newEmptyRange(0n),
			r: factory.newEmptyRange(1n),
			wantErr: "ranges are disjoint",
		},
		{
			desc: "left_corrupted",
			l: corrupt(factory.newEmptyRange(7n), -7n, 0n),
			r: nonEmpty1,
			wantErr: "corrupted lhs range",
		},
		{
			desc: "right_corrupted",
			l: nonEmpty2,
			r: corrupt(nonEmpty3, 0n, 20n),
			wantErr: "corrupted rhs range",
		},
	];

	for (const tc of tests) {
		it(tc.desc, () => {
			const err = catchError(() => tc.l.appendRange(tc.r, null));
			if (tc.wantErr === "") {
				expect(err).toBeNull();
			} else {
				expect(err).not.toBeNull();
				expect((err as Error).message.startsWith(tc.wantErr)).toBe(true);
			}
		});
	}
});

describe("TestEqual", () => {
	const tests: { desc: string; lhs: Range; rhs: Range; wantEqual: boolean }[] = [
		{
			desc: "incompatible trees",
			lhs: new Range(factory, 17n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			rhs: new Range(new RangeFactory(factory.hash), 17n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			wantEqual: false,
		},

		{
			desc: "unequal begin",
			lhs: new Range(factory, 17n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			rhs: new Range(factory, 18n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			wantEqual: false,
		},

		{
			desc: "unequal end",
			lhs: new Range(factory, 17n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			rhs: new Range(factory, 17n, 24n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			wantEqual: false,
		},

		{
			desc: "unequal number of hashes",
			lhs: new Range(factory, 17n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			rhs: new Range(factory, 17n, 23n, [toUTF8("hash 1")]),
			wantEqual: false,
		},

		{
			desc: "mismatched hash",
			lhs: new Range(factory, 17n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			rhs: new Range(factory, 17n, 23n, [toUTF8("hash 1"), toUTF8("not hash 2")]),
			wantEqual: false,
		},

		{
			desc: "equal ranges",
			lhs: new Range(factory, 17n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			rhs: new Range(factory, 17n, 23n, [toUTF8("hash 1"), toUTF8("hash 2")]),
			wantEqual: true,
		},
	];

	for (const test of tests) {
		it(test.desc, () => {
			expect(test.lhs.equal(test.rhs)).toBe(test.wantEqual);
		});
	}
});

describe("TestGetMergePath", () => {
	const tests: {
		begin: bigint;
		mid: bigint;
		end: bigint;
		wantLow: number;
		wantHigh: number;
		wantEmpty: boolean;
	}[] = [
		{ begin: 0n, mid: 0n, end: 0n, wantLow: 0, wantHigh: 0, wantEmpty: true },
		{ begin: 0n, mid: 0n, end: 1n, wantLow: 0, wantHigh: 0, wantEmpty: true },
		{ begin: 0n, mid: 0n, end: 1n << 63n, wantLow: 0, wantHigh: 0, wantEmpty: true },
		{ begin: 0n, mid: 1n, end: 1n, wantLow: 0, wantHigh: 0, wantEmpty: true },
		{ begin: 0n, mid: 1n, end: 2n, wantLow: 0, wantHigh: 1, wantEmpty: false },
		{ begin: 0n, mid: 16n, end: 32n, wantLow: 4, wantHigh: 5, wantEmpty: false },
		{ begin: 0n, mid: 1n << 63n, end: MaxUint64, wantLow: 0, wantHigh: 0, wantEmpty: true },
		{ begin: 0n, mid: 1n << 63n, end: (1n << 63n) + 100500n, wantLow: 0, wantHigh: 0, wantEmpty: true },
		{ begin: 2n, mid: 9n, end: 13n, wantLow: 0, wantHigh: 2, wantEmpty: false },
		{ begin: 6n, mid: 13n, end: 17n, wantLow: 0, wantHigh: 3, wantEmpty: false },
		{ begin: 4n, mid: 8n, end: 16n, wantLow: 0, wantHigh: 0, wantEmpty: true },
		{ begin: 8n, mid: 12n, end: 16n, wantLow: 2, wantHigh: 3, wantEmpty: false },
		{ begin: 4n, mid: 6n, end: 12n, wantLow: 1, wantHigh: 2, wantEmpty: false },
		{ begin: 8n, mid: 10n, end: 16n, wantLow: 1, wantHigh: 3, wantEmpty: false },
		{ begin: 11n, mid: 17n, end: 27n, wantLow: 0, wantHigh: 3, wantEmpty: false },
		{ begin: 11n, mid: 16n, end: 27n, wantLow: 0, wantHigh: 0, wantEmpty: true },
	];

	for (const tc of tests) {
		it(`${tc.begin}:${tc.mid}:${tc.end}`, () => {
			const [low, high] = getMergePath(tc.begin, tc.mid, tc.end);
			if (tc.wantEmpty) {
				expect(low < high, `getMergePath(${tc.begin},${tc.mid},${tc.end})=${low},${high}; want empty`).toBe(false);
			} else {
				expect([low, high]).toEqual([tc.wantLow, tc.wantHigh]);
			}
		});
	}
});

const MaxUint64 = 0xffffffffffffffffn;

// catchError runs fn and returns the error it threw, or null. It stands in for
// Go's `err := f()` when porting tests that assert on error values.
function catchError(fn: () => void): Error | null {
	try {
		fn();
	} catch (e) {
		return e as Error;
	}
	return null;
}
