// Copyright 2009 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// This file has mixed provenance. parseUint, underscoreOK, lower, NumError, ErrSyntax and
// ErrRange (from atoi.go), and quote's escaping rules (from quote.go), each marked below,
// are a derivative work of Go's standard library package `strconv` and remain subject to
// the Go project's BSD-style licence, which is reproduced further down and in
// LICENSES/BSD-3-Clause-Go.txt. Everything else in this file is original to this project
// and is licensed under the Apache License, Version 2.0:
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
// Ported from strconv/atoi.go and strconv/quote.go (Go standard library) @ Go 1.25.5
// (ParseUint and Quote only)

// This file is not a port of a Tessera file. It stands in for the parts of Go's
// `strconv` package that the port relies on.
//
// `Number.parseInt` is not a substitute: it accepts a leading sign, accepts a "0x"
// prefix even when a base is given, stops silently at the first character it cannot
// use ("12a" parses as 12), and loses precision above 2^53. Every one of those would
// let a malformed checkpoint size or a malformed verifier key hash through.

import { SentinelError } from "./errors.ts";

/**
 * ErrRange indicates that a value is out of range for the target type.
 * Derived from strconv (atoi.go).
 */
export const ErrRange = new SentinelError("value out of range");

/**
 * ErrSyntax indicates that a value does not have the right syntax for the target type.
 * Derived from strconv (atoi.go).
 */
export const ErrSyntax = new SentinelError("invalid syntax");

/**
 * A NumError records a failed conversion. Derived from strconv (atoi.go).
 *
 * Port note: Go's `Unwrap` becomes `cause`, so `errorIs(err, ErrSyntax)` and
 * `errorIs(err, ErrRange)` work as `errors.Is` does. The message is Go's
 * `"strconv." + Func + ": parsing " + Quote(Num) + ": " + Err.Error()`, except that
 * only the first {@link maxQuotedNum} characters of Num are quoted, followed by
 * `...` when there are more: Go embeds the whole input, and an error message that
 * grows with untrusted input (a witness response body, a checkpoint line) is a
 * memory and log-amplification hazard. `num` itself is the full input, as in Go.
 * See docs/decisions/0204-parseuint-transcribes-go.md.
 */
export class NumError extends Error {
	/** func is the failing function (ParseUint). */
	readonly func: string;
	/** num is the input. */
	readonly num: string;
	/** err is the reason the conversion failed (e.g. ErrRange, ErrSyntax, etc.). */
	readonly err: Error;

	constructor(func: string, num: string, err: Error) {
		super(`strconv.${func}: parsing ${quoteBounded(num)}: ${err.message}`, { cause: err });
		this.name = "NumError";
		this.func = func;
		this.num = num;
		this.err = err;
	}
}

/**
 * maxQuotedNum is how many characters (code points) of the input a NumError message
 * quotes. Every realistic input — a 20-digit uint64, an 8-digit key hash — is far
 * shorter, so for those the message is exactly Go's.
 */
export const maxQuotedNum = 64;

/** quoteBounded quotes at most maxQuotedNum code points of s, marking a truncation with "...". */
function quoteBounded(s: string): string {
	if (s.length <= maxQuotedNum) {
		return quote(s);
	}
	let prefix = "";
	let n = 0;
	for (const ch of s) {
		if (n === maxQuotedNum) {
			return `${quote(prefix)}...`;
		}
		prefix += ch;
		n++;
	}
	return quote(prefix);
}

/**
 * quote returns a double-quoted Go string literal representing s (`strconv.Quote`).
 * The returned string uses Go escape sequences (\t, \n, \xFF, \u0100) for control
 * characters and non-printable characters as defined by IsPrint. Derived from strconv
 * (quote.go, appendQuotedWith/appendEscapedRune).
 *
 * Port note: Go's IsPrint is "categories L, M, N, P, S and the ASCII space character",
 * which is exactly what the Unicode property escapes in {@link isPrint} test, against
 * the JavaScript engine's Unicode tables rather than Go's; the two can disagree only on
 * code points assigned in a Unicode version one of them has not adopted yet. A lone
 * UTF-16 surrogate, which no Go string can hold, is escaped as \ufffd — the rune Go's
 * Quote substitutes for an invalid one.
 */
export function quote(s: string): string {
	let out = '"';
	for (const ch of s) {
		const r = ch.codePointAt(0) ?? 0;
		if (ch === '"' || ch === "\\") {
			out += `\\${ch}`;
			continue;
		}
		if (r < 0x80 ? r >= 0x20 && r < 0x7f : isPrint(ch)) {
			out += ch;
			continue;
		}
		switch (r) {
			case 0x07:
				out += "\\a";
				continue;
			case 0x08:
				out += "\\b";
				continue;
			case 0x0c:
				out += "\\f";
				continue;
			case 0x0a:
				out += "\\n";
				continue;
			case 0x0d:
				out += "\\r";
				continue;
			case 0x09:
				out += "\\t";
				continue;
			case 0x0b:
				out += "\\v";
				continue;
			default:
				break;
		}
		if (r < 0x20 || r === 0x7f) {
			out += `\\x${r.toString(16).padStart(2, "0")}`;
		} else if (r >= 0xd800 && r <= 0xdfff) {
			out += "\\ufffd";
		} else if (r < 0x10000) {
			out += `\\u${r.toString(16).padStart(4, "0")}`;
		} else {
			out += `\\U${r.toString(16).padStart(8, "0")}`;
		}
	}
	return `${out}"`;
}

const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/** isPrint reports whether the single code point ch is printable in Go's sense (non-ASCII only). */
function isPrint(ch: string): boolean {
	return PRINTABLE.test(ch);
}

/** lower is Go's `lower`: it maps an ASCII letter to lower case. Derived from strconv. */
function lower(c: number): number {
	return c | (0x78 - 0x58); // c | ('x' - 'X')
}

/** IntSize is the size in bits of Go's int and uint on the 64-bit platforms Tessera targets. */
const IntSize = 64;

const maxUint64 = (1n << 64n) - 1n;

/**
 * parseUint is like ParseInt but for unsigned numbers.
 *
 * A sign prefix is not permitted.
 *
 * It is the port of `strconv.ParseUint`, transcribed from Go's loop (derived from
 * strconv): ParseUint interprets a string s in the given base (0, 2 to 36) and bit size
 * (0 to 64) and returns the corresponding value. If the base argument is 0, the true
 * base is implied by the string's prefix following the sign (if present): 2 for "0b",
 * 8 for "0" or "0o", 16 for "0x", and 10 otherwise. Also, for argument base 0 only,
 * underscore characters are permitted as defined by the Go syntax for integer literals.
 * The bitSize argument specifies the integer type that the result must fit into; bit
 * sizes 0, 8, 16, 32, and 64 correspond to uint, uint8, uint16, uint32, and uint64.
 *
 * The errors that parseUint throws are {@link NumError}s with func = "ParseUint", in
 * Go's order of precedence: an empty s is ErrSyntax before the base is looked at; a bad
 * base, then a bad bit size; then, digit by digit, a non-digit is ErrSyntax and a value
 * that no longer fits bitSize is ErrRange the moment it overflows — the rest of s is
 * not examined.
 *
 * Port note: the result is `bigint` because the port's largest caller is the checkpoint
 * size, which is `uint64` (ADR-0003); Go returns maxVal alongside ErrRange, which a
 * throw cannot carry. Callers that want a `uint32` narrow it themselves. The digits
 * are accumulated in a `number` while the value is below 2^53 and in a `bigint` after
 * that, which keeps the loop linear in len(s) however long s is.
 * See docs/decisions/0204-parseuint-transcribes-go.md.
 */
export function parseUint(s: string, base: number, bitSize: number): bigint {
	const fnParseUint = "ParseUint";

	if (s === "") {
		throw new NumError(fnParseUint, s, ErrSyntax);
	}

	const base0 = base === 0;

	const s0 = s;
	if (2 <= base && base <= 36) {
		// valid base; nothing to do
	} else if (base === 0) {
		// Look for octal, hex prefix.
		base = 10;
		if (s.charCodeAt(0) === 0x30) {
			if (s.length >= 3 && lower(s.charCodeAt(1)) === 0x62) {
				base = 2;
				s = s.slice(2);
			} else if (s.length >= 3 && lower(s.charCodeAt(1)) === 0x6f) {
				base = 8;
				s = s.slice(2);
			} else if (s.length >= 3 && lower(s.charCodeAt(1)) === 0x78) {
				base = 16;
				s = s.slice(2);
			} else {
				base = 8;
				s = s.slice(1);
			}
		}
	} else {
		throw new NumError(fnParseUint, s0, new Error(`invalid base ${base}`));
	}

	if (bitSize === 0) {
		bitSize = IntSize;
	} else if (bitSize < 0 || bitSize > 64) {
		throw new NumError(fnParseUint, s0, new Error(`invalid bit size ${bitSize}`));
	}

	// Cutoff is the smallest number such that cutoff*base > maxUint64.
	const bigBase = BigInt(base);
	const cutoff = maxUint64 / bigBase + 1n;

	const maxVal = (1n << BigInt(bitSize)) - 1n;
	// Port note: the number fast path below stands in for the uint64 accumulator while
	// the value is exactly representable; cutoff exceeds 2^53 for every base, so only the
	// maxVal check can fire there, and only for bit sizes below 53.
	const maxValSmall = bitSize < 53 ? 2 ** bitSize - 1 : Number.POSITIVE_INFINITY;

	let underscores = false;
	let small = 0;
	let n: bigint | undefined;
	// Port note: Go ranges over the bytes of s. Every character above U+007F starts a
	// UTF-8 sequence whose bytes are all 0x80 or above, none of which is a digit, so
	// ranging over UTF-16 code units reaches the same verdict at the same position.
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		let d: number;
		if (c === 0x5f && base0) {
			underscores = true;
			continue;
		} else if (0x30 <= c && c <= 0x39) {
			d = c - 0x30;
		} else if (0x61 <= lower(c) && lower(c) <= 0x7a) {
			d = lower(c) - 0x61 + 10;
		} else {
			throw new NumError(fnParseUint, s0, ErrSyntax);
		}

		if (d >= base) {
			throw new NumError(fnParseUint, s0, ErrSyntax);
		}

		if (n === undefined) {
			const next = small * base + d;
			if (next <= Number.MAX_SAFE_INTEGER) {
				if (next > maxValSmall) {
					// n+d overflows
					throw new NumError(fnParseUint, s0, ErrRange);
				}
				small = next;
				continue;
			}
			n = BigInt(small);
		}

		if (n >= cutoff) {
			// n*base overflows
			throw new NumError(fnParseUint, s0, ErrRange);
		}
		n *= bigBase;

		const n1 = n + BigInt(d);
		if (n1 < n || n1 > maxVal) {
			// n+d overflows
			throw new NumError(fnParseUint, s0, ErrRange);
		}
		n = n1;
	}

	if (underscores && !underscoreOK(s0)) {
		throw new NumError(fnParseUint, s0, ErrSyntax);
	}

	return n ?? BigInt(small);
}

/**
 * underscoreOK reports whether the underscores in s are allowed.
 * Checking them in this one function lets all the parsers skip over them simply.
 * Underscore must appear only between digits or between a base prefix and a digit.
 * Derived from strconv (atoi.go).
 */
function underscoreOK(s: string): boolean {
	// saw tracks the last character (class) we saw:
	// ^ for beginning of number,
	// 0 for a digit or base prefix,
	// _ for an underscore,
	// ! for none of the above.
	let saw = "^";
	let i = 0;

	// Optional sign.
	if (s.length >= 1 && (s[0] === "-" || s[0] === "+")) {
		s = s.slice(1);
	}

	// Optional base prefix.
	let hex = false;
	if (
		s.length >= 2 &&
		s[0] === "0" &&
		(lower(s.charCodeAt(1)) === 0x62 || lower(s.charCodeAt(1)) === 0x6f || lower(s.charCodeAt(1)) === 0x78)
	) {
		i = 2;
		saw = "0"; // base prefix counts as a digit for "underscore as digit separator"
		hex = lower(s.charCodeAt(1)) === 0x78;
	}

	// Number proper.
	for (; i < s.length; i++) {
		const c = s.charCodeAt(i);
		// Digits are always okay.
		if ((0x30 <= c && c <= 0x39) || (hex && 0x61 <= lower(c) && lower(c) <= 0x66)) {
			saw = "0";
			continue;
		}
		// Underscore must follow digit.
		if (c === 0x5f) {
			if (saw !== "0") {
				return false;
			}
			saw = "_";
			continue;
		}
		// Underscore must also be followed by digit.
		if (saw === "_") {
			return false;
		}
		// Saw non-digit, non-underscore.
		saw = "!";
	}
	return saw !== "_";
}
