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

// This file is not a port of a Tessera file. It stands in for the parts of Go's
// `strconv` package that the port relies on.
//
// `Number.parseInt` is not a substitute: it accepts a leading sign, accepts a "0x"
// prefix even when a base is given, stops silently at the first character it cannot
// use ("12a" parses as 12), and loses precision above 2^53. Every one of those would
// let a malformed checkpoint size or a malformed verifier key hash through.

/** ErrSyntax stands in for `strconv.ErrSyntax`. */
export const ErrSyntax = "invalid syntax";

/** ErrRange stands in for `strconv.ErrRange`. */
export const ErrRange = "value out of range";

/**
 * quote returns a double-quoted Go string literal representing s (`strconv.Quote`).
 *
 * Port note: Go decides whether a rune may appear literally with `unicode.IsPrint`,
 * which is backed by the full Unicode tables. Reproducing those tables to render an
 * error message is not worth the bytes, so this treats every non-ASCII rune as
 * printable. The two differ only for non-ASCII control, format and unassigned code
 * points, which no origin or verifier name in this port contains. Nothing asserts on
 * the result; it exists so error text matches upstream's for realistic inputs.
 */
export function quote(s: string): string {
	let out = '"';
	for (const ch of s) {
		if (ch === '"') {
			out += '\\"';
			continue;
		}
		if (ch === "\\") {
			out += "\\\\";
			continue;
		}
		const r = ch.codePointAt(0) ?? 0;
		if (r >= 0x20 && r < 0x7f) {
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
			case 0x09:
				out += "\\t";
				continue;
			case 0x0a:
				out += "\\n";
				continue;
			case 0x0b:
				out += "\\v";
				continue;
			case 0x0c:
				out += "\\f";
				continue;
			case 0x0d:
				out += "\\r";
				continue;
			default:
				break;
		}
		if (r < 0x80) {
			out += `\\x${r.toString(16).padStart(2, "0")}`;
			continue;
		}
		out += ch;
	}
	return `${out}"`;
}

/** numError builds the message `strconv.ParseUint` reports, verbatim. */
function numError(fn: string, num: string, err: string): Error {
	return new Error(`strconv.${fn}: parsing ${quote(num)}: ${err}`);
}

/** digitValue returns the value of the digit c in the widest base, or -1. */
function digitValue(c: number): number {
	if (c >= 0x30 && c <= 0x39) {
		return c - 0x30; // '0'-'9'
	}
	if (c >= 0x61 && c <= 0x7a) {
		return c - 0x61 + 10; // 'a'-'z'
	}
	if (c >= 0x41 && c <= 0x5a) {
		return c - 0x41 + 10; // 'A'-'Z'
	}
	return -1;
}

/**
 * parseUint is the port of `strconv.ParseUint`: it interprets s in the given base and
 * returns the corresponding value, which must fit in an unsigned integer of bitSize
 * bits.
 *
 * A sign prefix is not permitted, an empty string is a syntax error, and every
 * character of s must be a digit in the given base — Go stops at the first one that is
 * not and reports a syntax error, it does not return a prefix.
 *
 * Port note: the result is `bigint` because the port's largest caller is the checkpoint
 * size, which is `uint64` (ADR-0003). Callers that want a `uint32` narrow it themselves.
 *
 * Port note: base 0, which makes Go infer the base from a "0x"/"0o"/"0b" prefix and
 * allows "_" digit separators, is not implemented. No call site in this port uses it,
 * and unused parser branches in a transparency log are a liability, not a feature.
 */
export function parseUint(s: string, base: number, bitSize: number): bigint {
	if (base < 2 || base > 36) {
		throw new Error(`strconv.ParseUint: parsing ${quote(s)}: invalid base ${base}`);
	}
	if (bitSize < 1 || bitSize > 64) {
		throw new Error(`strconv.ParseUint: parsing ${quote(s)}: invalid bit size ${bitSize}`);
	}
	if (s === "") {
		throw numError("ParseUint", s, ErrSyntax);
	}

	const bigBase = BigInt(base);
	let n = 0n;
	for (let i = 0; i < s.length; i++) {
		const d = digitValue(s.charCodeAt(i));
		if (d < 0 || d >= base) {
			throw numError("ParseUint", s, ErrSyntax);
		}
		n = n * bigBase + BigInt(d);
	}

	const maxVal = (1n << BigInt(bitSize)) - 1n;
	if (n > maxVal) {
		throw numError("ParseUint", s, ErrRange);
	}
	return n;
}
