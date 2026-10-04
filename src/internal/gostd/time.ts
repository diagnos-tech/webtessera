// Copyright 2009 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// This file has mixed provenance. durationString, fmtFrac and fmtInt (each marked below) are
// a transcription of time.Duration's String method and its helpers in Go's standard library
// package `time`, and remain subject to the Go project's BSD-style licence, which is
// reproduced further down and in LICENSES/BSD-3-Clause-Go.txt. Everything else in this file
// is original to this project and is licensed under the Apache License, Version 2.0:
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
// Copyright 2009 The Go Authors.
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
// Ported from time/time.go (Go standard library) @ Go 1.25.5 (Duration.String only)

// This file is not a port of a Tessera file. It stands in for the part of Go's `time`
// package the port needs to reproduce error messages that format a time.Duration.
//
// AGENTS.md §3.5 maps time.Duration to a number of milliseconds. A Go Duration is an int64
// count of nanoseconds, so a message that prints one prints that integer, in whichever form
// the verb asks for: `%d` the count itself, `%v` and `%s` Duration.String's "1.5ms" form.
// durationFromMs is the one conversion every such message shares.

/**
 * durationFromMs converts a duration of ms milliseconds, as this port's APIs take one, to
 * the int64 count of nanoseconds a Go time.Duration holds, rounding to the nearest
 * nanosecond. ms must be finite.
 */
export function durationFromMs(ms: number): bigint {
	if (Number.isInteger(ms)) {
		return BigInt(ms) * 1_000_000n;
	}
	return BigInt(Math.round(ms * 1_000_000));
}

const nanosecond = 1n;
const microsecond = 1000n * nanosecond;
const millisecond = 1000n * microsecond;
const second = 1000n * millisecond;

/**
 * durationString returns a string representing the duration in the form "72h3m0.5s".
 * Leading zero units are omitted. As a special case, durations less than one
 * second format use a smaller unit (milli-, micro-, or nanoseconds) to ensure
 * that the leading digit is non-zero. The zero duration formats as 0s.
 *
 * Derived from time (time.go): this is `(Duration).String` together with `format`, for a
 * duration of d nanoseconds.
 *
 * Port note: Go writes the digits backwards into a fixed [32]byte buffer; this prepends to
 * a string instead, which produces the same text. Go's `u := uint64(d); if neg { u = -u }`
 * is the magnitude of d, which a bigint holds without the uint64 wrap.
 */
export function durationString(d: bigint): string {
	let u = d < 0n ? -d : d;
	const neg = d < 0n;
	let buf: string;

	if (u < second) {
		// Special case: if duration is smaller than a second,
		// use smaller units, like 1.2ms
		let prec: number;
		let unit: string;
		if (u === 0n) {
			return "0s";
		} else if (u < microsecond) {
			// print nanoseconds
			prec = 0;
			unit = "ns";
		} else if (u < millisecond) {
			// print microseconds
			prec = 3;
			// U+00B5 'µ' micro sign == 0xC2 0xB5
			unit = "µs";
		} else {
			// print milliseconds
			prec = 6;
			unit = "ms";
		}
		let frac: string;
		[frac, u] = fmtFrac(u, prec);
		buf = fmtInt(u) + frac + unit;
	} else {
		let frac: string;
		[frac, u] = fmtFrac(u, 9);

		// u is now integer seconds
		buf = `${fmtInt(u % 60n)}${frac}s`;
		u /= 60n;

		// u is now integer minutes
		if (u > 0n) {
			buf = `${fmtInt(u % 60n)}m${buf}`;
			u /= 60n;

			// u is now integer hours
			// Stop at hours because days can be different lengths.
			if (u > 0n) {
				buf = `${fmtInt(u)}h${buf}`;
			}
		}
	}

	if (neg) {
		buf = `-${buf}`;
	}

	return buf;
}

/**
 * fmtFrac formats the fraction of v/10**prec (e.g., ".12345"), omitting trailing zeros. It
 * omits the decimal point too when the fraction is 0. It returns the formatted fraction and
 * the value v/10**prec.
 *
 * Derived from time (time.go).
 */
function fmtFrac(v: bigint, prec: number): [frac: string, v: bigint] {
	// Omit trailing zeros up to and including decimal point.
	let buf = "";
	let print = false;
	for (let i = 0; i < prec; i++) {
		const digit = v % 10n;
		print = print || digit !== 0n;
		if (print) {
			buf = `${digit}${buf}`;
		}
		v /= 10n;
	}
	if (print) {
		buf = `.${buf}`;
	}
	return [buf, v];
}

/**
 * fmtInt formats v in decimal.
 *
 * Derived from time (time.go).
 */
function fmtInt(v: bigint): string {
	return v.toString();
}
