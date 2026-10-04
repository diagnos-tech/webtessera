// Copyright 2011 The Go Authors. All rights reserved. (graphic.go, tables.go)
// Copyright 2009 The Go Authors. All rights reserved. (utf8.go)
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// This file has mixed provenance. `isSpace` is a derivative work of Go's standard library
// `unicode.IsSpace` (unicode/graphic.go) and of its White_Space range table
// (unicode/tables.go), and `decodeRune` of `utf8.DecodeRune` (unicode/utf8/utf8.go); both
// remain subject to the Go project's BSD-style licence: use of that code is governed by a
// BSD-style license that can be found in LICENSES/BSD-3-Clause-Go.txt. Everything else in
// this file is original to this project and is licensed under the Apache License, Version 2.0:
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
// Ported from unicode/graphic.go and unicode/tables.go (IsSpace) and unicode/utf8/utf8.go
// (DecodeRune) (Go standard library) @ Go 1.25.5

// This file is not a port of a Tessera file. It stands in for the parts of Go's
// `unicode` and `unicode/utf8` packages that the port relies on. `sumdb/note`
// specifies its name syntax in terms of both of them, so getting these exactly
// right is part of getting the note wire format right.

/**
 * isSpace reports whether r is a space character as defined by Unicode's White Space
 * property; in the Latin-1 space this is
 *
 *	'\t', '\n', '\v', '\f', '\r', ' ', U+0085 (NEL), U+00A0 (NBSP).
 *
 * Other definitions of spacing characters are set by category Z and property
 * Pattern_White_Space.
 *
 * Derived from `unicode.IsSpace` in unicode/graphic.go and the White_Space table in
 * unicode/tables.go, Go 1.25.5: the Latin-1 switch and the ranges above it are Go's.
 *
 * Port note: this is deliberately not `/\s/`. JavaScript's whitespace class differs
 * from Unicode's White_Space property in two code points, and both of them matter
 * here because `note.isValidName` rejects any name containing a space:
 *
 *   - U+0085 NEXT LINE is White_Space, so Go rejects a name containing it. `/\s/`
 *     does not match it, so a regex-based port would accept such a name.
 *   - U+FEFF ZERO WIDTH NO-BREAK SPACE is not White_Space, so Go accepts a name
 *     containing it. `/\s/` matches it, so a regex-based port would reject one.
 *
 * Either direction is an interoperability break against every other tlog
 * implementation, so the set is written out.
 */
export function isSpace(r: number): boolean {
	// This property isn't the same as Z; special-case it. (It also contains the controls
	// U+0009-U+000D and U+0085, so the Latin-1 range is enumerated.)
	if (r <= 0xff) {
		switch (r) {
			case 0x09: // '\t'
			case 0x0a: // '\n'
			case 0x0b: // '\v'
			case 0x0c: // '\f'
			case 0x0d: // '\r'
			case 0x20: // ' '
			case 0x85: // NEL
			case 0xa0: // NBSP
				return true;
			default:
				return false;
		}
	}
	return (
		r === 0x1680 ||
		(r >= 0x2000 && r <= 0x200a) ||
		r === 0x2028 ||
		r === 0x2029 ||
		r === 0x202f ||
		r === 0x205f ||
		r === 0x3000
	);
}

const strictUTF8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * validUTF8 reports whether p consists entirely of valid UTF-8-encoded runes
 * (`utf8.Valid`).
 *
 * Port note: this delegates to `TextDecoder` in fatal mode rather than transcribing
 * Go's `acceptRanges` table. Both implement the Unicode 15 well-formed byte sequence
 * table (Table 3-7) — overlong encodings, surrogate halves and code points above
 * U+10FFFF are ill-formed for both — so the accepted sets are identical, and one less
 * hand-written decoder is one less place for a parser bug to hide.
 */
export function validUTF8(p: Uint8Array): boolean {
	try {
		strictUTF8Decoder.decode(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * validUTF8String reports whether s consists entirely of valid UTF-8-encoded runes
 * (`utf8.ValidString`).
 *
 * Port note: a Go string is a byte slice that may hold arbitrary bytes, so
 * `utf8.ValidString` is a real check. A JavaScript string is a sequence of UTF-16
 * code units, and the only way it can fail to be encodable as UTF-8 is by containing
 * an unpaired surrogate — so that is what this looks for.
 */
export function validUTF8String(s: string): boolean {
	for (const ch of s) {
		const r = ch.codePointAt(0);
		if (r !== undefined && r >= 0xd800 && r <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/** RuneError is `utf8.RuneError`, the "error" Rune or "Unicode replacement character". */
export const RuneError = 0xfffd;

/**
 * decodeRune unpacks the first UTF-8 encoding in p[i:] and returns the rune and
 * its width in bytes. If p[i:] is empty it returns (RuneError, 0). Otherwise, if
 * the encoding is invalid, it returns (RuneError, 1). Both are impossible
 * results for correct, non-empty UTF-8.
 *
 * An encoding is invalid if it is incorrect UTF-8, encodes a rune that is
 * out of range, or is not the shortest possible UTF-8 encoding for the
 * value. No other validation is performed.
 *
 * Derived from `utf8.DecodeRune` (unicode/utf8/utf8.go): the first-byte classes and the
 * accepted range of the second byte are those of Go's `first` and `acceptRanges` tables.
 */
export function decodeRune(p: Uint8Array, i = 0): [r: number, size: number] {
	const n = p.length - i;
	if (n < 1) {
		return [RuneError, 0];
	}
	const s0 = p[i] as number;
	if (s0 < 0x80) {
		return [s0, 1];
	}
	let sz: number;
	let lo = 0x80;
	let hi = 0xbf;
	if (s0 >= 0xc2 && s0 <= 0xdf) {
		sz = 2;
	} else if (s0 >= 0xe0 && s0 <= 0xef) {
		sz = 3;
		if (s0 === 0xe0) {
			lo = 0xa0;
		} else if (s0 === 0xed) {
			hi = 0x9f;
		}
	} else if (s0 >= 0xf0 && s0 <= 0xf4) {
		sz = 4;
		if (s0 === 0xf0) {
			lo = 0x90;
		} else if (s0 === 0xf4) {
			hi = 0x8f;
		}
	} else {
		return [RuneError, 1];
	}
	if (n < sz) {
		return [RuneError, 1];
	}
	const s1 = p[i + 1] as number;
	if (s1 < lo || hi < s1) {
		return [RuneError, 1];
	}
	if (sz <= 2) {
		return [((s0 & 0x1f) << 6) | (s1 & 0x3f), 2];
	}
	const s2 = p[i + 2] as number;
	if (s2 < 0x80 || 0xbf < s2) {
		return [RuneError, 1];
	}
	if (sz <= 3) {
		return [((s0 & 0x0f) << 12) | ((s1 & 0x3f) << 6) | (s2 & 0x3f), 3];
	}
	const s3 = p[i + 3] as number;
	if (s3 < 0x80 || 0xbf < s3) {
		return [RuneError, 1];
	}
	return [((s0 & 0x07) << 18) | ((s1 & 0x3f) << 12) | ((s2 & 0x3f) << 6) | (s3 & 0x3f), 4];
}
