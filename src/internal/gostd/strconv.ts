// Copyright 2009 The Go Authors. All rights reserved.
// Copyright 2013 The Go Authors. All rights reserved. (isprint.go)
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// This file has mixed provenance. parseUint, underscoreOK, lower, NumError, ErrSyntax and
// ErrRange (from atoi.go), and quote, quoteBytes, escapedRune, isPrint, bsearch and the
// IS_PRINT/IS_NOT_PRINT tables (from quote.go and isprint.go), each marked below,
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
// Ported from strconv/atoi.go, strconv/quote.go and strconv/isprint.go (Go standard library)
// @ Go 1.25.5 (ParseUint and Quote only)

// This file is not a port of a Tessera file. It stands in for the parts of Go's
// `strconv` package that the port relies on.
//
// `Number.parseInt` is not a substitute: it accepts a leading sign, accepts a "0x"
// prefix even when a base is given, stops silently at the first character it cannot
// use ("12a" parses as 12), and loses precision above 2^53. Every one of those would
// let a malformed checkpoint size or a malformed verifier key hash through.

import { SentinelError } from "./errors.ts";
import { decodeRune, RuneError } from "./unicode.ts";

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
 * Port note: printability is decided by {@link isPrint}, a transcription of Go's
 * IsPrint over Go's own Unicode 15.0.0 tables, so the result does not depend on the
 * Unicode version of the JavaScript engine. A lone UTF-16 surrogate, which no Go string
 * can hold, is escaped as \ufffd — the rune Go substitutes for an invalid one.
 */
export function quote(s: string): string {
	let out = '"';
	for (const ch of s) {
		out += escapedRune(ch.codePointAt(0) ?? 0, ch);
	}
	return `${out}"`;
}

/**
 * quoteBytes returns a double-quoted Go string literal representing the bytes b, as
 * `strconv.Quote(string(b))` does: like {@link quote}, but each byte that does not start a
 * valid UTF-8 encoding is spelled \xNN, the escape Go uses for it. Derived from strconv
 * (quote.go, appendQuotedWith).
 *
 * Port note: quote takes a JavaScript string, which cannot hold such bytes; this is for the
 * messages that quote a slice of input bytes as Go does, possibly cut inside a character.
 */
export function quoteBytes(b: Uint8Array): string {
	let out = '"';
	for (let i = 0, width = 0; i < b.length; i += width) {
		let r: number;
		[r, width] = decodeRune(b, i);
		if (width === 1 && r === RuneError) {
			out += `\\x${(b[i] as number).toString(16).padStart(2, "0")}`;
			continue;
		}
		out += escapedRune(r, String.fromCodePoint(r));
	}
	return `${out}"`;
}

/**
 * escapedRune spells the rune r (whose string form is ch) inside a double-quoted Go string
 * literal. Derived from strconv (quote.go, appendEscapedRune).
 */
function escapedRune(r: number, ch: string): string {
	if (ch === '"' || ch === "\\") {
		return `\\${ch}`;
	}
	if (isPrint(r)) {
		return ch;
	}
	switch (r) {
		case 0x07:
			return "\\a";
		case 0x08:
			return "\\b";
		case 0x0c:
			return "\\f";
		case 0x0a:
			return "\\n";
		case 0x0d:
			return "\\r";
		case 0x09:
			return "\\t";
		case 0x0b:
			return "\\v";
		default:
			break;
	}
	if (r < 0x20 || r === 0x7f) {
		return `\\x${r.toString(16).padStart(2, "0")}`;
	}
	if (r >= 0xd800 && r <= 0xdfff) {
		return "\\ufffd";
	}
	if (r < 0x10000) {
		return `\\u${r.toString(16).padStart(4, "0")}`;
	}
	return `\\U${r.toString(16).padStart(8, "0")}`;
}

/**
 * isPrint reports whether the rune is defined as printable by Go: letters, marks,
 * numbers, punctuation, symbols and the ASCII space character, from categories L, M,
 * N, P, S and the ASCII space character. Derived from strconv (quote.go, `IsPrint`).
 */
function isPrint(r: number): boolean {
	// Fast check for Latin-1
	if (r <= 0xff) {
		if (0x20 <= r && r <= 0x7e) {
			// All the ASCII is printable from space through DEL-1.
			return true;
		}
		if (0xa1 <= r && r <= 0xff) {
			// Similarly for ¡ through ÿ...
			return r !== 0xad; // ...except for the bizarre soft hyphen.
		}
		return false;
	}

	// Same algorithm, either on uint16 or uint32 value.
	// First, find first i such that isPrint[i] >= x.
	// This is the index of either the start or end of a pair that might span x.
	// The start is even (isPrint[i&^1]) and the end is odd (isPrint[i|1]).
	// If we find x in a range, make sure x is not in isNotPrint list.

	if (0 <= r && r < 1 << 16) {
		const i = bsearch(IS_PRINT16, r);
		if (i >= IS_PRINT16.length || r < (IS_PRINT16[i & ~1] as number) || (IS_PRINT16[i | 1] as number) < r) {
			return false;
		}
		return !found(IS_NOT_PRINT16, r);
	}

	const i = bsearch(IS_PRINT32, r);
	if (i >= IS_PRINT32.length || r < (IS_PRINT32[i & ~1] as number) || (IS_PRINT32[i | 1] as number) < r) {
		return false;
	}
	if (r >= 0x20000) {
		return true;
	}
	return !found(IS_NOT_PRINT32, r - 0x10000);
}

/** bsearch returns the smallest index i in sorted s such that s[i] >= v (Go's `bsearch`). */
function bsearch(s: readonly number[], v: number): number {
	let i = 0;
	let j = s.length;
	while (i < j) {
		const h = i + ((j - i) >> 1);
		if ((s[h] as number) < v) {
			i = h + 1;
		} else {
			j = h;
		}
	}
	return i;
}

/** found reports whether sorted s contains v. */
function found(s: readonly number[], v: number): boolean {
	const i = bsearch(s, v);
	return i < s.length && s[i] === v;
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

// The tables below are Go's `strconv` isPrint16, isNotPrint16, isPrint32 and isNotPrint32
// (strconv/isprint.go, generated by makeisprint.go from Unicode 15.0.0), transcribed from
// Go 1.25.5. Derived from strconv; see the file header.

/** IS_PRINT16 is Go's isPrint16: pairs of inclusive [lo, hi] ranges of printable runes below U+10000. */
const IS_PRINT16: readonly number[] = [
	0x20, 0x7e, 0xa1, 0x377, 0x37a, 0x37f, 0x384, 0x556, 0x559, 0x58a, 0x58d, 0x5c7, 0x5d0, 0x5ea, 0x5ef, 0x5f4, 0x606,
	0x70d, 0x710, 0x74a, 0x74d, 0x7b1, 0x7c0, 0x7fa, 0x7fd, 0x82d, 0x830, 0x85b, 0x85e, 0x86a, 0x870, 0x88e, 0x898, 0x98c,
	0x98f, 0x990, 0x993, 0x9b2, 0x9b6, 0x9b9, 0x9bc, 0x9c4, 0x9c7, 0x9c8, 0x9cb, 0x9ce, 0x9d7, 0x9d7, 0x9dc, 0x9e3, 0x9e6,
	0x9fe, 0xa01, 0xa0a, 0xa0f, 0xa10, 0xa13, 0xa39, 0xa3c, 0xa42, 0xa47, 0xa48, 0xa4b, 0xa4d, 0xa51, 0xa51, 0xa59, 0xa5e,
	0xa66, 0xa76, 0xa81, 0xab9, 0xabc, 0xacd, 0xad0, 0xad0, 0xae0, 0xae3, 0xae6, 0xaf1, 0xaf9, 0xb0c, 0xb0f, 0xb10, 0xb13,
	0xb39, 0xb3c, 0xb44, 0xb47, 0xb48, 0xb4b, 0xb4d, 0xb55, 0xb57, 0xb5c, 0xb63, 0xb66, 0xb77, 0xb82, 0xb8a, 0xb8e, 0xb95,
	0xb99, 0xb9f, 0xba3, 0xba4, 0xba8, 0xbaa, 0xbae, 0xbb9, 0xbbe, 0xbc2, 0xbc6, 0xbcd, 0xbd0, 0xbd0, 0xbd7, 0xbd7, 0xbe6,
	0xbfa, 0xc00, 0xc39, 0xc3c, 0xc4d, 0xc55, 0xc5a, 0xc5d, 0xc5d, 0xc60, 0xc63, 0xc66, 0xc6f, 0xc77, 0xcb9, 0xcbc, 0xccd,
	0xcd5, 0xcd6, 0xcdd, 0xce3, 0xce6, 0xcf3, 0xd00, 0xd4f, 0xd54, 0xd63, 0xd66, 0xd96, 0xd9a, 0xdbd, 0xdc0, 0xdc6, 0xdca,
	0xdca, 0xdcf, 0xddf, 0xde6, 0xdef, 0xdf2, 0xdf4, 0xe01, 0xe3a, 0xe3f, 0xe5b, 0xe81, 0xebd, 0xec0, 0xed9, 0xedc, 0xedf,
	0xf00, 0xf6c, 0xf71, 0xfda, 0x1000, 0x10c7, 0x10cd, 0x10cd, 0x10d0, 0x124d, 0x1250, 0x125d, 0x1260, 0x128d, 0x1290,
	0x12b5, 0x12b8, 0x12c5, 0x12c8, 0x1315, 0x1318, 0x135a, 0x135d, 0x137c, 0x1380, 0x1399, 0x13a0, 0x13f5, 0x13f8,
	0x13fd, 0x1400, 0x169c, 0x16a0, 0x16f8, 0x1700, 0x1715, 0x171f, 0x1736, 0x1740, 0x1753, 0x1760, 0x1773, 0x1780,
	0x17dd, 0x17e0, 0x17e9, 0x17f0, 0x17f9, 0x1800, 0x1819, 0x1820, 0x1878, 0x1880, 0x18aa, 0x18b0, 0x18f5, 0x1900,
	0x192b, 0x1930, 0x193b, 0x1940, 0x1940, 0x1944, 0x196d, 0x1970, 0x1974, 0x1980, 0x19ab, 0x19b0, 0x19c9, 0x19d0,
	0x19da, 0x19de, 0x1a1b, 0x1a1e, 0x1a7c, 0x1a7f, 0x1a89, 0x1a90, 0x1a99, 0x1aa0, 0x1aad, 0x1ab0, 0x1ace, 0x1b00,
	0x1b4c, 0x1b50, 0x1bf3, 0x1bfc, 0x1c37, 0x1c3b, 0x1c49, 0x1c4d, 0x1c88, 0x1c90, 0x1cba, 0x1cbd, 0x1cc7, 0x1cd0,
	0x1cfa, 0x1d00, 0x1f15, 0x1f18, 0x1f1d, 0x1f20, 0x1f45, 0x1f48, 0x1f4d, 0x1f50, 0x1f7d, 0x1f80, 0x1fd3, 0x1fd6,
	0x1fef, 0x1ff2, 0x1ffe, 0x2010, 0x2027, 0x2030, 0x205e, 0x2070, 0x2071, 0x2074, 0x209c, 0x20a0, 0x20c0, 0x20d0,
	0x20f0, 0x2100, 0x218b, 0x2190, 0x2426, 0x2440, 0x244a, 0x2460, 0x2b73, 0x2b76, 0x2cf3, 0x2cf9, 0x2d27, 0x2d2d,
	0x2d2d, 0x2d30, 0x2d67, 0x2d6f, 0x2d70, 0x2d7f, 0x2d96, 0x2da0, 0x2e5d, 0x2e80, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0,
	0x2ffb, 0x3001, 0x3096, 0x3099, 0x30ff, 0x3105, 0x31e3, 0x31f0, 0xa48c, 0xa490, 0xa4c6, 0xa4d0, 0xa62b, 0xa640,
	0xa6f7, 0xa700, 0xa7ca, 0xa7d0, 0xa7d9, 0xa7f2, 0xa82c, 0xa830, 0xa839, 0xa840, 0xa877, 0xa880, 0xa8c5, 0xa8ce,
	0xa8d9, 0xa8e0, 0xa953, 0xa95f, 0xa97c, 0xa980, 0xa9d9, 0xa9de, 0xaa36, 0xaa40, 0xaa4d, 0xaa50, 0xaa59, 0xaa5c,
	0xaac2, 0xaadb, 0xaaf6, 0xab01, 0xab06, 0xab09, 0xab0e, 0xab11, 0xab16, 0xab20, 0xab6b, 0xab70, 0xabed, 0xabf0,
	0xabf9, 0xac00, 0xd7a3, 0xd7b0, 0xd7c6, 0xd7cb, 0xd7fb, 0xf900, 0xfa6d, 0xfa70, 0xfad9, 0xfb00, 0xfb06, 0xfb13,
	0xfb17, 0xfb1d, 0xfbc2, 0xfbd3, 0xfd8f, 0xfd92, 0xfdc7, 0xfdcf, 0xfdcf, 0xfdf0, 0xfe19, 0xfe20, 0xfe6b, 0xfe70,
	0xfefc, 0xff01, 0xffbe, 0xffc2, 0xffc7, 0xffca, 0xffcf, 0xffd2, 0xffd7, 0xffda, 0xffdc, 0xffe0, 0xffee, 0xfffc,
	0xfffd,
];

/** IS_NOT_PRINT16 is Go's isNotPrint16: the non-printable runes inside IS_PRINT16's ranges. */
const IS_NOT_PRINT16: readonly number[] = [
	0xad, 0x38b, 0x38d, 0x3a2, 0x530, 0x590, 0x61c, 0x6dd, 0x83f, 0x85f, 0x8e2, 0x984, 0x9a9, 0x9b1, 0x9de, 0xa04, 0xa29,
	0xa31, 0xa34, 0xa37, 0xa3d, 0xa5d, 0xa84, 0xa8e, 0xa92, 0xaa9, 0xab1, 0xab4, 0xac6, 0xaca, 0xb00, 0xb04, 0xb29, 0xb31,
	0xb34, 0xb5e, 0xb84, 0xb91, 0xb9b, 0xb9d, 0xbc9, 0xc0d, 0xc11, 0xc29, 0xc45, 0xc49, 0xc57, 0xc8d, 0xc91, 0xca9, 0xcb4,
	0xcc5, 0xcc9, 0xcdf, 0xcf0, 0xd0d, 0xd11, 0xd45, 0xd49, 0xd80, 0xd84, 0xdb2, 0xdbc, 0xdd5, 0xdd7, 0xe83, 0xe85, 0xe8b,
	0xea4, 0xea6, 0xec5, 0xec7, 0xecf, 0xf48, 0xf98, 0xfbd, 0xfcd, 0x10c6, 0x1249, 0x1257, 0x1259, 0x1289, 0x12b1, 0x12bf,
	0x12c1, 0x12d7, 0x1311, 0x1680, 0x176d, 0x1771, 0x180e, 0x191f, 0x1a5f, 0x1b7f, 0x1f58, 0x1f5a, 0x1f5c, 0x1f5e,
	0x1fb5, 0x1fc5, 0x1fdc, 0x1ff5, 0x208f, 0x2b96, 0x2d26, 0x2da7, 0x2daf, 0x2db7, 0x2dbf, 0x2dc7, 0x2dcf, 0x2dd7,
	0x2ddf, 0x2e9a, 0x3040, 0x3130, 0x318f, 0x321f, 0xa7d2, 0xa7d4, 0xa9ce, 0xa9ff, 0xab27, 0xab2f, 0xfb37, 0xfb3d,
	0xfb3f, 0xfb42, 0xfb45, 0xfe53, 0xfe67, 0xfe75, 0xffe7,
];

/** IS_PRINT32 is Go's isPrint32: pairs of inclusive [lo, hi] ranges of printable runes from U+10000. */
const IS_PRINT32: readonly number[] = [
	0x10000, 0x1004d, 0x10050, 0x1005d, 0x10080, 0x100fa, 0x10100, 0x10102, 0x10107, 0x10133, 0x10137, 0x1019c, 0x101a0,
	0x101a0, 0x101d0, 0x101fd, 0x10280, 0x1029c, 0x102a0, 0x102d0, 0x102e0, 0x102fb, 0x10300, 0x10323, 0x1032d, 0x1034a,
	0x10350, 0x1037a, 0x10380, 0x103c3, 0x103c8, 0x103d5, 0x10400, 0x1049d, 0x104a0, 0x104a9, 0x104b0, 0x104d3, 0x104d8,
	0x104fb, 0x10500, 0x10527, 0x10530, 0x10563, 0x1056f, 0x105bc, 0x10600, 0x10736, 0x10740, 0x10755, 0x10760, 0x10767,
	0x10780, 0x107ba, 0x10800, 0x10805, 0x10808, 0x10838, 0x1083c, 0x1083c, 0x1083f, 0x1089e, 0x108a7, 0x108af, 0x108e0,
	0x108f5, 0x108fb, 0x1091b, 0x1091f, 0x10939, 0x1093f, 0x1093f, 0x10980, 0x109b7, 0x109bc, 0x109cf, 0x109d2, 0x10a06,
	0x10a0c, 0x10a35, 0x10a38, 0x10a3a, 0x10a3f, 0x10a48, 0x10a50, 0x10a58, 0x10a60, 0x10a9f, 0x10ac0, 0x10ae6, 0x10aeb,
	0x10af6, 0x10b00, 0x10b35, 0x10b39, 0x10b55, 0x10b58, 0x10b72, 0x10b78, 0x10b91, 0x10b99, 0x10b9c, 0x10ba9, 0x10baf,
	0x10c00, 0x10c48, 0x10c80, 0x10cb2, 0x10cc0, 0x10cf2, 0x10cfa, 0x10d27, 0x10d30, 0x10d39, 0x10e60, 0x10ead, 0x10eb0,
	0x10eb1, 0x10efd, 0x10f27, 0x10f30, 0x10f59, 0x10f70, 0x10f89, 0x10fb0, 0x10fcb, 0x10fe0, 0x10ff6, 0x11000, 0x1104d,
	0x11052, 0x11075, 0x1107f, 0x110c2, 0x110d0, 0x110e8, 0x110f0, 0x110f9, 0x11100, 0x11147, 0x11150, 0x11176, 0x11180,
	0x111f4, 0x11200, 0x11241, 0x11280, 0x112a9, 0x112b0, 0x112ea, 0x112f0, 0x112f9, 0x11300, 0x1130c, 0x1130f, 0x11310,
	0x11313, 0x11344, 0x11347, 0x11348, 0x1134b, 0x1134d, 0x11350, 0x11350, 0x11357, 0x11357, 0x1135d, 0x11363, 0x11366,
	0x1136c, 0x11370, 0x11374, 0x11400, 0x11461, 0x11480, 0x114c7, 0x114d0, 0x114d9, 0x11580, 0x115b5, 0x115b8, 0x115dd,
	0x11600, 0x11644, 0x11650, 0x11659, 0x11660, 0x1166c, 0x11680, 0x116b9, 0x116c0, 0x116c9, 0x11700, 0x1171a, 0x1171d,
	0x1172b, 0x11730, 0x11746, 0x11800, 0x1183b, 0x118a0, 0x118f2, 0x118ff, 0x11906, 0x11909, 0x11909, 0x1190c, 0x11938,
	0x1193b, 0x11946, 0x11950, 0x11959, 0x119a0, 0x119a7, 0x119aa, 0x119d7, 0x119da, 0x119e4, 0x11a00, 0x11a47, 0x11a50,
	0x11aa2, 0x11ab0, 0x11af8, 0x11b00, 0x11b09, 0x11c00, 0x11c45, 0x11c50, 0x11c6c, 0x11c70, 0x11c8f, 0x11c92, 0x11cb6,
	0x11d00, 0x11d36, 0x11d3a, 0x11d47, 0x11d50, 0x11d59, 0x11d60, 0x11d98, 0x11da0, 0x11da9, 0x11ee0, 0x11ef8, 0x11f00,
	0x11f3a, 0x11f3e, 0x11f59, 0x11fb0, 0x11fb0, 0x11fc0, 0x11ff1, 0x11fff, 0x12399, 0x12400, 0x12474, 0x12480, 0x12543,
	0x12f90, 0x12ff2, 0x13000, 0x1342f, 0x13440, 0x13455, 0x14400, 0x14646, 0x16800, 0x16a38, 0x16a40, 0x16a69, 0x16a6e,
	0x16ac9, 0x16ad0, 0x16aed, 0x16af0, 0x16af5, 0x16b00, 0x16b45, 0x16b50, 0x16b77, 0x16b7d, 0x16b8f, 0x16e40, 0x16e9a,
	0x16f00, 0x16f4a, 0x16f4f, 0x16f87, 0x16f8f, 0x16f9f, 0x16fe0, 0x16fe4, 0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800,
	0x18cd5, 0x18d00, 0x18d08, 0x1aff0, 0x1b122, 0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155, 0x1b164, 0x1b167,
	0x1b170, 0x1b2fb, 0x1bc00, 0x1bc6a, 0x1bc70, 0x1bc7c, 0x1bc80, 0x1bc88, 0x1bc90, 0x1bc99, 0x1bc9c, 0x1bc9f, 0x1cf00,
	0x1cf2d, 0x1cf30, 0x1cf46, 0x1cf50, 0x1cfc3, 0x1d000, 0x1d0f5, 0x1d100, 0x1d126, 0x1d129, 0x1d172, 0x1d17b, 0x1d1ea,
	0x1d200, 0x1d245, 0x1d2c0, 0x1d2d3, 0x1d2e0, 0x1d2f3, 0x1d300, 0x1d356, 0x1d360, 0x1d378, 0x1d400, 0x1d49f, 0x1d4a2,
	0x1d4a2, 0x1d4a5, 0x1d4a6, 0x1d4a9, 0x1d50a, 0x1d50d, 0x1d546, 0x1d54a, 0x1d6a5, 0x1d6a8, 0x1d7cb, 0x1d7ce, 0x1da8b,
	0x1da9b, 0x1daaf, 0x1df00, 0x1df1e, 0x1df25, 0x1df2a, 0x1e000, 0x1e018, 0x1e01b, 0x1e02a, 0x1e030, 0x1e06d, 0x1e08f,
	0x1e08f, 0x1e100, 0x1e12c, 0x1e130, 0x1e13d, 0x1e140, 0x1e149, 0x1e14e, 0x1e14f, 0x1e290, 0x1e2ae, 0x1e2c0, 0x1e2f9,
	0x1e2ff, 0x1e2ff, 0x1e4d0, 0x1e4f9, 0x1e7e0, 0x1e8c4, 0x1e8c7, 0x1e8d6, 0x1e900, 0x1e94b, 0x1e950, 0x1e959, 0x1e95e,
	0x1e95f, 0x1ec71, 0x1ecb4, 0x1ed01, 0x1ed3d, 0x1ee00, 0x1ee24, 0x1ee27, 0x1ee3b, 0x1ee42, 0x1ee42, 0x1ee47, 0x1ee54,
	0x1ee57, 0x1ee64, 0x1ee67, 0x1ee9b, 0x1eea1, 0x1eebb, 0x1eef0, 0x1eef1, 0x1f000, 0x1f02b, 0x1f030, 0x1f093, 0x1f0a0,
	0x1f0ae, 0x1f0b1, 0x1f0f5, 0x1f100, 0x1f1ad, 0x1f1e6, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251,
	0x1f260, 0x1f265, 0x1f300, 0x1f6d7, 0x1f6dc, 0x1f6ec, 0x1f6f0, 0x1f6fc, 0x1f700, 0x1f776, 0x1f77b, 0x1f7d9, 0x1f7e0,
	0x1f7eb, 0x1f7f0, 0x1f7f0, 0x1f800, 0x1f80b, 0x1f810, 0x1f847, 0x1f850, 0x1f859, 0x1f860, 0x1f887, 0x1f890, 0x1f8ad,
	0x1f8b0, 0x1f8b1, 0x1f900, 0x1fa53, 0x1fa60, 0x1fa6d, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa88, 0x1fa90, 0x1fac5, 0x1face,
	0x1fadb, 0x1fae0, 0x1fae8, 0x1faf0, 0x1faf8, 0x1fb00, 0x1fbca, 0x1fbf0, 0x1fbf9, 0x20000, 0x2a6df, 0x2a700, 0x2b739,
	0x2b740, 0x2b81d, 0x2b820, 0x2cea1, 0x2ceb0, 0x2ebe0, 0x2f800, 0x2fa1d, 0x30000, 0x3134a, 0x31350, 0x323af, 0xe0100,
	0xe01ef,
];

/** IS_NOT_PRINT32 is Go's isNotPrint32: non-printable runes in IS_PRINT32's ranges, minus 0x10000. */
const IS_NOT_PRINT32: readonly number[] = [
	0xc, 0x27, 0x3b, 0x3e, 0x18f, 0x39e, 0x57b, 0x58b, 0x593, 0x596, 0x5a2, 0x5b2, 0x5ba, 0x786, 0x7b1, 0x809, 0x836,
	0x856, 0x8f3, 0xa04, 0xa14, 0xa18, 0xe7f, 0xeaa, 0x10bd, 0x1135, 0x11e0, 0x1212, 0x1287, 0x1289, 0x128e, 0x129e,
	0x1304, 0x1329, 0x1331, 0x1334, 0x133a, 0x145c, 0x1914, 0x1917, 0x1936, 0x1c09, 0x1c37, 0x1ca8, 0x1d07, 0x1d0a,
	0x1d3b, 0x1d3e, 0x1d66, 0x1d69, 0x1d8f, 0x1d92, 0x1f11, 0x246f, 0x6a5f, 0x6abf, 0x6b5a, 0x6b62, 0xaff4, 0xaffc,
	0xafff, 0xd455, 0xd49d, 0xd4ad, 0xd4ba, 0xd4bc, 0xd4c4, 0xd506, 0xd515, 0xd51d, 0xd53a, 0xd53f, 0xd545, 0xd551,
	0xdaa0, 0xe007, 0xe022, 0xe025, 0xe7e7, 0xe7ec, 0xe7ef, 0xe7ff, 0xee04, 0xee20, 0xee23, 0xee28, 0xee33, 0xee38,
	0xee3a, 0xee48, 0xee4a, 0xee4c, 0xee50, 0xee53, 0xee58, 0xee5a, 0xee5c, 0xee5e, 0xee60, 0xee63, 0xee6b, 0xee73,
	0xee78, 0xee7d, 0xee7f, 0xee8a, 0xeea4, 0xeeaa, 0xf0c0, 0xf0d0, 0xfabe, 0xfb93,
];
