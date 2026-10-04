// Copyright 2009 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// This file has mixed provenance. The durationTests table (marked below) is taken from Go's
// standard library package `time` (time_test.go), so it is a derivative work of it and
// remains subject to the Go project's BSD-style licence in LICENSES/BSD-3-Clause-Go.txt.
// Everything else in this file is original to this project and is licensed under the Apache
// License, Version 2.0:
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
// durationTests taken from time/time_test.go (Go standard library) @ Go 1.25.5

import { describe, expect, it } from "vitest";
import { durationFromMs, durationString } from "./time.ts";

const nanosecond = 1n;
const microsecond = 1000n * nanosecond;
const millisecond = 1000n * microsecond;
const second = 1000n * millisecond;
const minute = 60n * second;
const hour = 60n * minute;

// durationTests is Go's table (time_test.go), with each Duration as a bigint of nanoseconds.
// Derived from time (time_test.go).
const durationTests: readonly (readonly [str: string, d: bigint])[] = [
	["0s", 0n],
	["1ns", 1n * nanosecond],
	["1.1µs", 1100n * nanosecond],
	["2.2ms", 2200n * microsecond],
	["3.3s", 3300n * millisecond],
	["4m5s", 4n * minute + 5n * second],
	["4m5.001s", 4n * minute + 5001n * millisecond],
	["5h6m7.001s", 5n * hour + 6n * minute + 7001n * millisecond],
	["8m0.000000001s", 8n * minute + 1n * nanosecond],
	["2562047h47m16.854775807s", (1n << 63n) - 1n],
	["-2562047h47m16.854775808s", -(1n << 63n)],
];

describe("TestDurationString", () => {
	for (const [str, d] of durationTests) {
		it(str, () => {
			expect(durationString(d)).toBe(str);
			if (d > 0n) {
				expect(durationString(-d)).toBe(`-${str}`);
			}
		});
	}
});

// Port addition: the port's APIs take milliseconds; durationFromMs is the conversion every
// Duration-formatting message shares.
describe("durationFromMs converts milliseconds to a Go Duration's nanoseconds", () => {
	for (const [ms, want] of [
		[0, 0n],
		[100, 100_000_000n],
		[0.5, 500_000n],
		[0.001, 1000n],
		[1e-6, 1n],
		[-5, -5_000_000n],
		[99.999999, 99_999_999n],
	] as const) {
		it(`${ms} ms`, () => {
			expect(durationFromMs(ms)).toBe(want);
		});
	}
});
