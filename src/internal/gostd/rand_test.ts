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

import { describe, expect, it } from "vitest";
import { MaxUint64 } from "./bits.ts";
import { newRand } from "./rand.ts";

// rand.ts claims to be splitmix64 (ADR-0012). These pin it to the reference
// implementation's published outputs, so a "harmless" edit to the mixing constants or
// the shifts cannot silently change every randomised cross-check's inputs.
describe("gostd/rand", () => {
	it("matches the splitmix64 reference outputs for seed 0", () => {
		const r = newRand(0n);
		expect([r.uint64(), r.uint64(), r.uint64(), r.uint64(), r.uint64()]).toEqual([
			0xe220a8397b1dcdafn,
			0x6e789e6aa1b965f4n,
			0x06c45d188009454fn,
			0xf88bb8a8724c81ecn,
			0x1b39896a51a8749bn,
		]);
	});

	it("matches the splitmix64 reference outputs for seed 1234567", () => {
		const r = newRand(1234567n);
		expect([r.uint64(), r.uint64(), r.uint64()]).toEqual([
			6457827717110365317n,
			3203168211198807973n,
			9817491932198370423n,
		]);
	});

	it("truncates the seed to 64 bits and wraps the state", () => {
		const a = newRand(MaxUint64);
		const b = newRand(-1n);
		const want = [0xe4d971771b652c20n, 0xe99ff867dbf682c9n];
		expect([a.uint64(), a.uint64()]).toEqual(want);
		expect([b.uint64(), b.uint64()]).toEqual(want);
	});

	it("int63n stays in [0, n) and throws for n <= 0, as Go's panics", () => {
		const r = newRand(5n);
		for (let i = 0; i < 1000; i++) {
			const v = r.int63n(10n);
			expect(v >= 0n && v < 10n).toBe(true);
		}
		expect(() => r.int63n(0n)).toThrow(new Error("invalid argument to int63n"));
		expect(() => r.int63n(-1n)).toThrow(new Error("invalid argument to int63n"));
	});
});
