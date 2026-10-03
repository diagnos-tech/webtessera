// Copyright 2017 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// This file has mixed provenance. The doc sentences of trailingZeros64, len64 and
// onesCount64 are quoted from Go's standard library package `math/bits`, and
// onesCount32's parallel-summing shape follows Go's `bits.OnesCount64` (each marked
// below); those portions are a derivative work of the Go project and remain subject to
// its BSD-style licence, which is reproduced further down and in
// LICENSES/BSD-3-Clause-Go.txt. Everything else in this file is original to this
// project and is licensed under the Apache License, Version 2.0:
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
// The following terms apply to the portions of this file derived from Go:
//
// Copyright 2017 The Go Authors.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google LLC nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Doc sentences and the OnesCount64 shape from math/bits/bits.go (Go standard library) @ Go 1.25.5

// This file is not a port of a Tessera file. It stands in for Go's `math/bits`
// package, restricted to the uint64 intrinsics that `merkle/compact` and
// `merkle/proof` are built on.
//
// Go's uint64 wraps at 2^64 and its shifts saturate to zero past 64 bits; a
// TypeScript `bigint` is unbounded and throws on a negative shift count. Every
// place the Merkle port performs uint64 arithmetic that can leave the 64-bit
// range goes through the helpers here, so the wrapping is written out rather
// than assumed. See docs/decisions/0003-uint64-as-bigint.md and
// docs/decisions/0014-uint64-wrapping-made-explicit.md.

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
 * assertUint64 throws unless value is a bigint in Go's uint64 domain [0, MaxUint64].
 * name is the parameter name the error message reports.
 *
 * Port note: Go's type system makes a negative or over-wide uint64 unrepresentable; a
 * `bigint` parameter accepts both, and the Merkle algorithms would then compute
 * nonsense (or loop) instead of failing. The exported uint64 entry points of
 * `merkle/compact`, `merkle/proof` and `formats/log` call this first, so every value Go
 * could have received behaves exactly as before and every other value is refused.
 * See docs/decisions/0207-uint64-domain-guards.md.
 */
export function assertUint64(value: bigint, name: string): void {
	if (typeof value !== "bigint") {
		throw new TypeError(`${name} must be a bigint uint64, got ${typeof value}`);
	}
	if (value < 0n || value > MaxUint64) {
		throw new RangeError(`${name} = ${value} is outside the uint64 range [0, 2^64-1]`);
	}
}

/**
 * trailingZeros64 returns the number of trailing zero bits in x; the result is
 * 64 for x == 0. Mirrors `bits.TrailingZeros64` (doc sentence derived from Go).
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
 * is 0 for x == 0. Mirrors `bits.Len64` (doc sentence derived from Go).
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
 * Mirrors `bits.OnesCount64` (doc sentence derived from Go).
 */
export function onesCount64(x: bigint): number {
	const v = asUint64(x);
	return onesCount32(Number(v & MASK32)) + onesCount32(Number(v >> 32n));
}

/**
 * shiftLeft64 evaluates Go's `x << uint(n)` for a uint64 x and an `int` n.
 *
 * Every shift upstream computes the count of is written with that explicit
 * `uint(...)` conversion (`uint64(1)<<uint(d)` in Decompose, `index>>uint(i)` in
 * the proof verifier), and the conversion is what this models: a negative `int`
 * converts to a `uint` of at least 2^63, and any count of 64 or more yields zero
 * for a uint64 operand. (A negative count *without* the conversion is a run-time
 * panic in Go, "negative shift amount"; upstream never writes one.) TypeScript's
 * `<<` on bigint neither truncates nor accepts a negative count, so both cases are
 * handled explicitly.
 */
export function shiftLeft64(x: bigint, n: number): bigint {
	if (n < 0 || n >= 64) {
		return 0n;
	}
	return asUint64(x << BigInt(n));
}

/**
 * shiftRight64 evaluates Go's `x >> uint(n)` for a uint64 x and an `int` n. As
 * with shiftLeft64, a count of 64 or more — including a negative `int`, which the
 * explicit conversion turns into a huge `uint` — yields zero.
 */
export function shiftRight64(x: bigint, n: number): bigint {
	if (n < 0 || n >= 64) {
		return 0n;
	}
	return asUint64(x) >> BigInt(n);
}

/**
 * onesCount32 is the SWAR population count for a 32-bit value: parallel summing of
 * adjacent bits ("Hacker's Delight", Chap. 5), folded the way Go's
 * `bits.OnesCount64` folds its partial sums (derived from Go).
 */
function onesCount32(x: number): number {
	let v = x | 0;
	v = v - ((v >>> 1) & 0x55555555);
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	v = (v + (v >>> 4)) & 0x0f0f0f0f;
	v = v + (v >>> 8);
	v = v + (v >>> 16);
	return v & 0x3f;
}
