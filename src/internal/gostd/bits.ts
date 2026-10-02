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

// This file is not a port of a Tessera file. It stands in for Go's `math/bits`
// package, restricted to the uint64 intrinsics that `merkle/compact` and
// `merkle/proof` are built on.
//
// Go's uint64 wraps at 2^64 and its shifts saturate to zero past 64 bits; a
// TypeScript `bigint` is unbounded and throws on a negative shift count. Every
// place the Merkle port performs uint64 arithmetic that can leave the 64-bit
// range goes through the helpers here, so the wrapping is written out rather
// than assumed. See docs/decisions/0003-uint64-as-bigint.md.

/** MaxUint64 is Go's `math.MaxUint64`, the largest value a uint64 can hold. */
export const MaxUint64 = 0xffffffffffffffffn;

const MASK32 = 0xffffffffn;

/**
 * asUint64 truncates x to its low 64 bits, the way Go's uint64 arithmetic
 * wraps. It is also how Go's `^x` complement is spelled here: `asUint64(~x)`.
 */
export function asUint64(x: bigint): bigint {
	return BigInt.asUintN(64, x);
}

/**
 * trailingZeros64 returns the number of trailing zero bits in x; the result is
 * 64 for x == 0. Mirrors `bits.TrailingZeros64`.
 */
export function trailingZeros64(x: bigint): number {
	const v = asUint64(x);
	if (v === 0n) {
		return 64;
	}
	const lo = Number(v & MASK32);
	if (lo !== 0) {
		// `lo & -lo` isolates the lowest set bit; Math.clz32 then locates it.
		return 31 - Math.clz32(lo & -lo);
	}
	const hi = Number(v >> 32n);
	return 63 - Math.clz32(hi & -hi);
}

/**
 * len64 returns the minimum number of bits required to represent x; the result
 * is 0 for x == 0. Mirrors `bits.Len64`.
 */
export function len64(x: bigint): number {
	const v = asUint64(x);
	const hi = Number(v >> 32n);
	if (hi !== 0) {
		return 64 - Math.clz32(hi);
	}
	return 32 - Math.clz32(Number(v & MASK32));
}

/**
 * onesCount64 returns the number of one bits ("population count") in x.
 * Mirrors `bits.OnesCount64`.
 */
export function onesCount64(x: bigint): number {
	const v = asUint64(x);
	return onesCount32(Number(v & MASK32)) + onesCount32(Number(v >> 32n));
}

/**
 * shiftLeft64 evaluates Go's `x << n` for a uint64 x and an `int` shift count.
 *
 * Go shift counts are unsigned: a negative `int` converts to a `uint` far
 * beyond 64, and any count of 64 or more yields zero for a uint64 operand.
 * TypeScript's `<<` on bigint neither truncates nor accepts a negative count,
 * so both cases are handled explicitly.
 */
export function shiftLeft64(x: bigint, n: number): bigint {
	if (n < 0 || n >= 64) {
		return 0n;
	}
	return asUint64(x << BigInt(n));
}

/**
 * shiftRight64 evaluates Go's `x >> n` for a uint64 x and an `int` shift count.
 * As with shiftLeft64, a count of 64 or more — including a negative `int` that
 * Go would convert to a huge `uint` — yields zero.
 */
export function shiftRight64(x: bigint, n: number): bigint {
	if (n < 0 || n >= 64) {
		return 0n;
	}
	return asUint64(x) >> BigInt(n);
}

/** onesCount32 is the SWAR population count for a 32-bit value. */
function onesCount32(x: number): number {
	let v = x | 0;
	v = v - ((v >>> 1) & 0x55555555);
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	v = (v + (v >>> 4)) & 0x0f0f0f0f;
	v = v + (v >>> 8);
	v = v + (v >>> 16);
	return v & 0x3f;
}
