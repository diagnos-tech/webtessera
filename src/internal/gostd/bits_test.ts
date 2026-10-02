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
import { asUint64, len64, MaxUint64, onesCount64, shiftLeft64, shiftRight64, trailingZeros64 } from "./bits.ts";

// These functions carry the whole compact-range and proof layer: a wrong
// TrailingZeros64 produces a tree that looks fine and hashes wrong. The tests
// below therefore pin the exact Go semantics for the degenerate inputs
// (zero, MaxUint64, out-of-range shift counts) as well as every power of two.

describe("gostd/bits", () => {
	describe("asUint64", () => {
		it("wraps the way Go's uint64 arithmetic wraps", () => {
			expect(asUint64(0n)).toBe(0n);
			expect(asUint64(-1n)).toBe(MaxUint64);
			expect(asUint64(MaxUint64)).toBe(MaxUint64);
			expect(asUint64(1n << 64n)).toBe(0n);
			expect(asUint64((1n << 64n) + 5n)).toBe(5n);
			// ^x, i.e. Go's bitwise complement, over uint64.
			expect(asUint64(~0n)).toBe(MaxUint64);
			expect(asUint64(~5n)).toBe(MaxUint64 - 5n);
		});
	});

	describe("trailingZeros64", () => {
		it("returns 64 for zero", () => {
			expect(trailingZeros64(0n)).toBe(64);
		});

		it("returns 0 for one and for MaxUint64", () => {
			expect(trailingZeros64(1n)).toBe(0);
			expect(trailingZeros64(MaxUint64)).toBe(0);
		});

		it("returns the exponent for every power of two", () => {
			for (let p = 0; p < 64; p++) {
				expect(trailingZeros64(1n << BigInt(p))).toBe(p);
			}
		});

		it("ignores higher set bits", () => {
			for (let p = 0; p < 64; p++) {
				// The lowest set bit is at p; everything above p is also set.
				const x = asUint64(MaxUint64 << BigInt(p));
				expect(trailingZeros64(x)).toBe(p);
			}
		});

		it("matches a naive reference over a dense range", () => {
			for (let i = 1; i < 1024; i++) {
				expect(trailingZeros64(BigInt(i))).toBe(refTrailingZeros64(BigInt(i)));
			}
		});
	});

	describe("len64", () => {
		it("returns 0 for zero", () => {
			expect(len64(0n)).toBe(0);
		});

		it("returns 1 for one and 64 for MaxUint64", () => {
			expect(len64(1n)).toBe(1);
			expect(len64(MaxUint64)).toBe(64);
		});

		it("returns exponent+1 for every power of two", () => {
			for (let p = 0; p < 64; p++) {
				expect(len64(1n << BigInt(p))).toBe(p + 1);
			}
		});

		it("returns the exponent for every power of two minus one", () => {
			for (let p = 0; p < 64; p++) {
				expect(len64((1n << BigInt(p)) - 1n)).toBe(p);
			}
		});

		it("matches a naive reference over a dense range", () => {
			for (let i = 0; i < 1024; i++) {
				expect(len64(BigInt(i))).toBe(refLen64(BigInt(i)));
			}
		});
	});

	describe("onesCount64", () => {
		it("returns 0 for zero and 64 for MaxUint64", () => {
			expect(onesCount64(0n)).toBe(0);
			expect(onesCount64(MaxUint64)).toBe(64);
		});

		it("returns 1 for every power of two", () => {
			for (let p = 0; p < 64; p++) {
				expect(onesCount64(1n << BigInt(p))).toBe(1);
			}
		});

		it("returns the exponent for every power of two minus one", () => {
			for (let p = 0; p <= 64; p++) {
				expect(onesCount64((1n << BigInt(p)) - 1n)).toBe(p);
			}
		});

		it("counts the halves independently", () => {
			expect(onesCount64(0xffffffffn)).toBe(32);
			expect(onesCount64(0xffffffff00000000n)).toBe(32);
			expect(onesCount64(0x8000000000000001n)).toBe(2);
			expect(onesCount64(0xaaaaaaaaaaaaaaaan)).toBe(32);
			expect(onesCount64(0x5555555555555555n)).toBe(32);
		});

		it("matches a naive reference over a dense range", () => {
			for (let i = 0; i < 1024; i++) {
				expect(onesCount64(BigInt(i))).toBe(refOnesCount64(BigInt(i)));
			}
		});
	});

	describe("shiftLeft64", () => {
		it("truncates to 64 bits", () => {
			expect(shiftLeft64(1n, 63)).toBe(1n << 63n);
			expect(shiftLeft64(3n, 63)).toBe(1n << 63n);
			expect(shiftLeft64(MaxUint64, 1)).toBe(MaxUint64 - 1n);
		});

		it("yields zero for shift counts of 64 or more, as Go does", () => {
			expect(shiftLeft64(1n, 64)).toBe(0n);
			expect(shiftLeft64(MaxUint64, 64)).toBe(0n);
			expect(shiftLeft64(MaxUint64, 1000)).toBe(0n);
		});

		it("yields zero for a negative count, matching Go's int-to-uint conversion", () => {
			expect(shiftLeft64(1n, -1)).toBe(0n);
		});
	});

	describe("shiftRight64", () => {
		it("shifts in zeros", () => {
			expect(shiftRight64(MaxUint64, 63)).toBe(1n);
			expect(shiftRight64(1n << 63n, 63)).toBe(1n);
			expect(shiftRight64(1n, 1)).toBe(0n);
		});

		it("yields zero for shift counts of 64 or more, as Go does", () => {
			expect(shiftRight64(MaxUint64, 64)).toBe(0n);
			expect(shiftRight64(MaxUint64, 1000)).toBe(0n);
		});

		it("yields zero for a negative count, matching Go's int-to-uint conversion", () => {
			expect(shiftRight64(MaxUint64, -1)).toBe(0n);
		});
	});
});

// refTrailingZeros64 is a naive bit-by-bit reference implementation.
function refTrailingZeros64(x: bigint): number {
	if (x === 0n) {
		return 64;
	}
	let n = 0;
	let v = x;
	while ((v & 1n) === 0n) {
		v >>= 1n;
		n++;
	}
	return n;
}

// refLen64 is a naive bit-by-bit reference implementation.
function refLen64(x: bigint): number {
	let n = 0;
	let v = x;
	while (v !== 0n) {
		v >>= 1n;
		n++;
	}
	return n;
}

// refOnesCount64 is a naive bit-by-bit reference implementation.
function refOnesCount64(x: bigint): number {
	let n = 0;
	let v = x;
	while (v !== 0n) {
		n += Number(v & 1n);
		v >>= 1n;
	}
	return n;
}
