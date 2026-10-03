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

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
	appendUint16BE,
	appendUint32BE,
	appendUint64BE,
	bytesCompare,
	bytesEqual,
	concatBytes,
	fromBase64,
	fromHex,
	fromUTF8,
	hasPrefix,
	indexByte,
	lastIndex,
	readUint16BE,
	readUint32BE,
	readUint64BE,
	splitN,
	toBase64,
	toHex,
	toUTF8,
} from "./bytes.ts";

// Hex and UTF-8 basics: hex round-trips against a known SHA-256 vector, and the UTF-8
// conversions behave like Go's string(b) on a leading byte-order mark and on invalid input.
describe("gostd/bytes", () => {
	it("hex round-trips and matches a known SHA-256 vector", () => {
		const empty = sha256(new Uint8Array());
		expect(toHex(empty)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(bytesEqual(fromHex(toHex(empty)), empty)).toBe(true);
	});

	it("fromUTF8 keeps a leading byte-order mark, like Go's string(b)", () => {
		const withBOM = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
		expect(fromUTF8(withBOM)).toBe("\ufeffa");
		expect(bytesEqual(toUTF8(fromUTF8(withBOM)), withBOM)).toBe(true);
	});

	// Go's string(b) keeps invalid bytes verbatim; a JavaScript string cannot hold them,
	// so the conversion substitutes U+FFFD and is lossy (see the port note on utf8Decoder).
	it("fromUTF8 replaces invalid sequences with U+FFFD, unlike Go's byte-preserving string(b)", () => {
		expect(fromUTF8(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a\ufffdb");
		expect(fromUTF8(new Uint8Array([0xfe]))).toBe(fromUTF8(new Uint8Array([0xff])));
		expect(bytesEqual(toUTF8(fromUTF8(new Uint8Array([0xff]))), new Uint8Array([0xff]))).toBe(false);
	});
});

// fromHex transcribes Go's hex.DecodeString, including its error text and precedence.
// The expected messages were produced by Go 1.24's encoding/hex.
describe("gostd/bytes fromHex against Go", () => {
	const tests: Array<[string, string]> = [
		["1g", "encoding/hex: invalid byte: U+0067 'g'"],
		["g1", "encoding/hex: invalid byte: U+0067 'g'"],
		["0", "encoding/hex: odd length hex string"],
		// An invalid final byte is reported before the odd length.
		["g", "encoding/hex: invalid byte: U+0067 'g'"],
		["\n0", "encoding/hex: invalid byte: U+000A"],
		["00\x7f0", "encoding/hex: invalid byte: U+007F"],
		["0 ", "encoding/hex: invalid byte: U+0020 ' '"],
		["0x", "encoding/hex: invalid byte: U+0078 'x'"],
		// Go decodes bytes, so a non-ASCII character is reported by its first UTF-8 byte.
		["0\u00e9", "encoding/hex: invalid byte: U+00C3 '\u00c3'"],
		["\u0663", "encoding/hex: invalid byte: U+00D9 '\u00d9'"],
		["\u00800", "encoding/hex: invalid byte: U+00C2 '\u00c2'"],
	];
	for (const [input, want] of tests) {
		it(`rejects ${JSON.stringify(input)}`, () => {
			expect(messageOf(() => fromHex(input))).toBe(want);
		});
	}

	it("decodes mixed case and the empty string", () => {
		expect(toHex(fromHex("DEADbeef"))).toBe("deadbeef");
		expect(fromHex("")).toEqual(new Uint8Array(0));
	});

	it("rejects every byte that is not a hex digit, and only those", () => {
		for (let b = 0; b < 256; b++) {
			const c = String.fromCharCode(b);
			const isHex = /^[0-9a-fA-F]$/.test(c);
			if (isHex) {
				expect(fromHex(`0${c}`)[0]).toBe(Number.parseInt(c, 16));
			} else {
				expect(() => fromHex(`0${c}`)).toThrow(/^encoding\/hex: invalid byte: U\+00/);
			}
		}
	});
});

// The rest of the helpers have no upstream counterpart to differ from, but everything
// built on them assumes Go's semantics, so they are pinned directly.
describe("gostd/bytes helpers", () => {
	it("bytesCompare orders lexicographically, shorter prefix first", () => {
		const b = (...v: number[]) => new Uint8Array(v);
		expect(bytesCompare(b(), b())).toBe(0);
		expect(bytesCompare(b(1, 2), b(1, 2))).toBe(0);
		expect(bytesCompare(b(1), b(1, 0))).toBe(-1);
		expect(bytesCompare(b(1, 0), b(1))).toBe(1);
		expect(bytesCompare(b(1, 2), b(1, 3))).toBe(-1);
		expect(bytesCompare(b(0xff), b(0x00, 0xff))).toBe(1);
	});

	it("bytesEqual compares length and content", () => {
		const a = new Uint8Array([1, 2, 3]);
		expect(bytesEqual(a, a)).toBe(true);
		expect(bytesEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
		expect(bytesEqual(a, new Uint8Array([1, 2]))).toBe(false);
		expect(bytesEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
		expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
	});

	it("concatBytes joins in order and copies", () => {
		const a = new Uint8Array([1]);
		const out = concatBytes(a, new Uint8Array(0), new Uint8Array([2, 3]));
		expect(out).toEqual(new Uint8Array([1, 2, 3]));
		out[0] = 9;
		expect(a[0]).toBe(1);
		expect(concatBytes()).toEqual(new Uint8Array(0));
	});

	it("indexByte, lastIndex and hasPrefix match Go", () => {
		const s = toUTF8("a\nb\n\nc");
		expect(indexByte(s, 0x0a)).toBe(1);
		expect(indexByte(s, 0x7a)).toBe(-1);
		expect(lastIndex(s, toUTF8("\n\n"))).toBe(3);
		expect(lastIndex(s, toUTF8("zz"))).toBe(-1);
		// As in Go, an empty separator matches at the end.
		expect(lastIndex(s, new Uint8Array(0))).toBe(s.length);
		expect(lastIndex(new Uint8Array(0), toUTF8("a"))).toBe(-1);
		expect(hasPrefix(s, toUTF8("a\n"))).toBe(true);
		expect(hasPrefix(s, new Uint8Array(0))).toBe(true);
		expect(hasPrefix(toUTF8("a"), toUTF8("ab"))).toBe(false);
	});

	it("splitN rejects an empty separator rather than splitting into runes", () => {
		expect(messageOf(() => splitN(toUTF8("ab"), new Uint8Array(0), -1))).toBe(
			"bytes: splitN with an empty separator is not supported",
		);
	});

	it("big-endian uint16/uint32/uint64 round-trip at the boundaries", () => {
		for (const v of [0, 1, 0xff, 0x100, 0xffff]) {
			const b = appendUint16BE(new Uint8Array([7]), v);
			expect(b.length).toBe(3);
			expect(b[0]).toBe(7);
			expect(readUint16BE(b, 1)).toBe(v);
		}
		for (const v of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
			expect(readUint32BE(appendUint32BE(new Uint8Array(0), v), 0)).toBe(v);
		}
		for (const v of [0n, 1n, (1n << 63n) - 1n, 1n << 63n, (1n << 64n) - 1n]) {
			expect(readUint64BE(appendUint64BE(new Uint8Array(0), v), 0)).toBe(v);
		}
		expect(appendUint16BE(new Uint8Array(0), 0x1234)).toEqual(new Uint8Array([0x12, 0x34]));
		expect(appendUint32BE(new Uint8Array(0), 0x12345678)).toEqual(new Uint8Array([0x12, 0x34, 0x56, 0x78]));
		expect(appendUint64BE(new Uint8Array(0), 0x0102030405060708n)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
	});

	it("reads past the end of the buffer throw", () => {
		expect(messageOf(() => readUint16BE(new Uint8Array(1), 0))).toBe("binary: read past end of buffer");
		expect(messageOf(() => readUint32BE(new Uint8Array(3), 0))).toBe("binary: read past end of buffer");
		expect(messageOf(() => readUint64BE(new Uint8Array(8), 1))).toBe("binary: read past end of buffer");
	});

	// A length prefix that silently kept the low bits of an oversized length would
	// misframe every entry after it. The appenders refuse anything their Go
	// counterparts' parameter types could not hold.
	it("appenders reject values outside their Go parameter type", () => {
		for (const v of [-1, 0x10000, 65536 + 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => appendUint16BE(new Uint8Array(0), v)).toThrow(RangeError);
		}
		expect(messageOf(() => appendUint16BE(new Uint8Array(0), 0x10000))).toBe(
			"binary: 65536 is out of range for uint16",
		);
		for (const v of [-1, 0x100000000, 0.5]) {
			expect(() => appendUint32BE(new Uint8Array(0), v)).toThrow(RangeError);
		}
		for (const v of [-1n, 1n << 64n]) {
			expect(() => appendUint64BE(new Uint8Array(0), v)).toThrow(RangeError);
		}
	});
});

// splitN backs `internal/parse`, which splits a checkpoint on newlines with a cap of
// four parts and relies on the remainder landing in the last element.
describe("gostd/bytes splitN", () => {
	const nl = toUTF8("\n");
	const tests: { desc: string; s: string; n: number; want: string[] }[] = [
		{ desc: "trailing separator produces a final empty part", s: "a\nb\nc\n", n: 4, want: ["a", "b", "c", ""] },
		{ desc: "fewer separators than the cap", s: "a\nb\n", n: 4, want: ["a", "b", ""] },
		{ desc: "remainder is left unsplit in the last part", s: "a\nb\nc\nd\ne", n: 4, want: ["a", "b", "c", "d\ne"] },
		{ desc: "empty input yields one empty part", s: "", n: 4, want: [""] },
		{ desc: "no separator yields the whole input", s: "abc", n: 4, want: ["abc"] },
		{ desc: "n of one yields the whole input", s: "a\nb", n: 1, want: ["a\nb"] },
		{ desc: "negative n splits everything", s: "a\nb\nc\n", n: -1, want: ["a", "b", "c", ""] },
		{ desc: "n of zero yields nothing", s: "a\nb", n: 0, want: [] },
	];

	for (const test of tests) {
		it(test.desc, () => {
			const got = splitN(toUTF8(test.s), nl, test.n);
			expect(got.map((p) => new TextDecoder().decode(p))).toEqual(test.want);
		});
	}
});

// Go's base64.StdEncoding.DecodeString is strict about padding, which is what
// `internal/parse` relies on to reject a malformed checkpoint hash. The platform's
// atob() is not: it accepts unpadded input, so fromBase64 does not delegate to it.
describe("gostd/bytes base64", () => {
	it("round-trips", () => {
		const b = sha256(toUTF8("tessera"));
		expect(bytesEqual(fromBase64(toBase64(b)), b)).toBe(true);
	});

	it("decodes a padded checkpoint hash", () => {
		const got = fromBase64("qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=");
		expect(got.length).toBe(32);
		expect(toBase64(got)).toBe("qINS1GRFhWHwdkUeqLEoP4yEMkTBBzxBkGwGQlVlVcs=");
	});

	it("decodes the empty string", () => {
		expect(fromBase64("").length).toBe(0);
	});

	const bad: string[] = [
		// Length is not a multiple of four: unpadded input Go rejects and atob accepts.
		"thisisnotright",
		"QQ",
		"QQQ",
		// Padding in the wrong place.
		"Q=QQ",
		"=QQQ",
		// Not in the standard alphabet (this is the URL-safe one).
		"a-b_cccc",
		// Whitespace, which the platform's atob() silently strips.
		"QQ ==",
	];

	for (const s of bad) {
		it(`rejects ${JSON.stringify(s)}`, () => {
			expect(messageOf(() => fromBase64(s))).toMatch(/^illegal base64 data at input byte \d+$/);
		});
	}
});

// Go's decoder ignores \r and \n anywhere in the input, and reports a rejection at the
// offset a left-to-right scan reaches — not at the end of the input. The golden
// fixtures pin that exact text, so both behaviours are asserted here against vectors
// taken from `base64.StdEncoding.DecodeString` running under Go 1.25.5.
describe("gostd/bytes base64 against Go", () => {
	const accepted: Array<[string, string]> = [
		["", ""],
		["Zg==", "f"],
		["Zm8=", "fo"],
		["Zm9v", "foo"],
		["Zm9v\nYmFy", "foobar"],
		["Zm9v\r\nYmFy\n", "foobar"],
		["\nZm9v", "foo"],
		["Zm9vYmFy\n\n", "foobar"],
	];
	for (const [encoded, plain] of accepted) {
		it(`accepts ${JSON.stringify(encoded)}`, () => {
			expect(new TextDecoder().decode(fromBase64(encoded))).toBe(plain);
		});
	}

	const rejected: Array<[string, number]> = [
		["Zm9vYmF", 4],
		["Zg", 0],
		["Zm8", 0],
		["Zm 9v", 2],
		["Zm\t9v", 2],
		["ThisIsn'tBase64", 7],
		["Zm9v=YmFy", 4],
		["====", 0],
		["Z===", 1],
		["Zm9vYmFy=", 8],
		["-m9v", 0],
		["Zm9v ", 4],
		["5dyaeacGWamtVZy3Ad7Zoqudu-Oq0klgz_Nw7", 25],
		["not base64!!", 3],
		["thisisnotright", 12],
		["QQ ==", 2],
		["a-b_cccc", 1],
		["Q=QQ", 1],
		["=QQQ", 0],
		["Zm9vYg==x", 8],
	];
	for (const [encoded, offset] of rejected) {
		it(`rejects ${JSON.stringify(encoded)} at byte ${offset}`, () => {
			expect(messageOf(() => fromBase64(encoded))).toBe(`illegal base64 data at input byte ${offset}`);
		});
	}

	it("round-trips every byte value", () => {
		const all = new Uint8Array(256);
		for (let i = 0; i < 256; i++) {
			all[i] = i;
		}
		expect(bytesEqual(fromBase64(toBase64(all)), all)).toBe(true);
	});
});

// messageOf returns the message of what fn throws, failing the test if it returns.
function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error("expected a throw");
}
