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
import { toUTF8 } from "./bytes.ts";
import { isSpace, validUTF8, validUTF8String } from "./unicode.ts";

describe("gostd/unicode", () => {
	describe("isSpace", () => {
		// Go's unicode.IsSpace is the Unicode White_Space property, in full.
		const spaces = [
			0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
			0x3000,
		];
		for (const r of spaces) {
			it(`reports U+${r.toString(16).toUpperCase().padStart(4, "0")} as space`, () => {
				expect(isSpace(r)).toBe(true);
			});
		}

		// U+FEFF is whitespace to JavaScript's /\s/ but is not in Unicode's
		// White_Space property, so Go's unicode.IsSpace rejects it. U+200B is a
		// zero-width space, which is likewise not White_Space.
		const notSpaces = [0x00, 0x08, 0x0e, 0x1f, 0x21, 0x41, 0x2b, 0x200b, 0x180e, 0xfeff, 0x10000];
		for (const r of notSpaces) {
			it(`reports U+${r.toString(16).toUpperCase().padStart(4, "0")} as not space`, () => {
				expect(isSpace(r)).toBe(false);
			});
		}
	});

	describe("validUTF8", () => {
		it("accepts well-formed sequences", () => {
			expect(validUTF8(new Uint8Array())).toBe(true);
			expect(validUTF8(toUTF8("hello"))).toBe(true);
			expect(validUTF8(toUTF8("日本語"))).toBe(true);
			expect(validUTF8(toUTF8("— PeterNeumann"))).toBe(true);
			expect(validUTF8(toUTF8("🌲"))).toBe(true);
			// The valid encoding of U+FFFD itself is well-formed.
			expect(validUTF8(new Uint8Array([0xef, 0xbf, 0xbd]))).toBe(true);
		});

		it("rejects ill-formed sequences", () => {
			expect(validUTF8(new Uint8Array([0xff]))).toBe(false);
			expect(validUTF8(new Uint8Array([0xfe]))).toBe(false);
			expect(validUTF8(new Uint8Array([0x80]))).toBe(false);
			// Overlong encoding of '/'.
			expect(validUTF8(new Uint8Array([0xc0, 0xaf]))).toBe(false);
			// Surrogate half U+D800.
			expect(validUTF8(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(false);
			// Truncated three-byte sequence.
			expect(validUTF8(new Uint8Array([0xe6, 0x97]))).toBe(false);
			// Beyond U+10FFFF.
			expect(validUTF8(new Uint8Array([0xf5, 0x80, 0x80, 0x80]))).toBe(false);
		});
	});

	describe("validUTF8String", () => {
		it("accepts strings without lone surrogates", () => {
			expect(validUTF8String("")).toBe(true);
			expect(validUTF8String("PeterNeumann")).toBe(true);
			expect(validUTF8String("Señor-0")).toBe(true);
			expect(validUTF8String("🌲")).toBe(true);
		});

		it("rejects lone surrogates", () => {
			expect(validUTF8String("\uD800")).toBe(false);
			expect(validUTF8String("\uDC00")).toBe(false);
			expect(validUTF8String("a\uD800b")).toBe(false);
		});
	});
});
