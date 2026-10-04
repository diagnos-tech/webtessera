// Copyright 2009 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// This file has mixed provenance. The cutTests, trimSpaceTests and fieldsTests tables
// (each marked below) are taken from Go's standard library `strings/strings_test.go`, so
// they are a derivative work of it and remain subject to the Go project's BSD-style
// licence, which is reproduced further down and in LICENSES/BSD-3-Clause-Go.txt.
// Everything else in this file is original to this project and is licensed under the
// Apache License, Version 2.0:
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
// Test tables taken from strings/strings_test.go (Go standard library) @ Go 1.25.5

import { describe, expect, it } from "vitest";
import { cut, fields, trimSpace } from "./strings.ts";

describe("gostd/strings", () => {
	describe("cut", () => {
		// cutTests: lifted from Go's strings.TestCut.
		const tests: Array<[string, string, string, string, boolean]> = [
			["abc", "b", "a", "c", true],
			["abc", "a", "", "bc", true],
			["abc", "c", "ab", "", true],
			["abc", "abc", "", "", true],
			["abc", "", "", "abc", true],
			["abc", "d", "abc", "", false],
			["", "d", "", "", false],
			["", "", "", "", true],
		];
		for (const [s, sep, before, after, found] of tests) {
			it(`cut(${JSON.stringify(s)}, ${JSON.stringify(sep)})`, () => {
				expect(cut(s, sep)).toEqual([before, after, found]);
			});
		}

		it("splits a note signature line the way Open does", () => {
			expect(cut("PeterNeumann x08go/ZJ=", " ")).toEqual(["PeterNeumann", "x08go/ZJ=", true]);
			// A name containing a space means everything after the first space is
			// treated as the base64 blob, which then fails to decode.
			expect(cut("Bad Name x08go/ZJ=", " ")).toEqual(["Bad", "Name x08go/ZJ=", true]);
		});
	});

	// space is Go's strings_test.go `space` constant.
	const space = "\t\v\r\f\n\u0085  　";

	describe("trimSpace", () => {
		// trimSpaceTests: lifted from Go's strings.TestTrimSpace. Go's cases that put invalid
		// UTF-8 bytes (\x80, \xc0) into a string have no JavaScript-string counterpart and are
		// not carried.
		const tests: Array<[string, string]> = [
			["", ""],
			["abc", "abc"],
			[`${space}abc${space}`, "abc"],
			[" ", ""],
			[" \t\r\n \t\t\r\r\n\n ", ""],
			[" \t\r\n x\t\t\r\r\n\n ", "x"],
			["  \t\r\n x\t\t\r\r\ny\n 　", "x\t\t\r\r\ny"],
			["1 \t\r\n2", "1 \t\r\n2"],
			["x ☺ ", "x ☺"],
		];
		for (const [input, want] of tests) {
			it(`trimSpace(${JSON.stringify(input)})`, () => {
				expect(trimSpace(input)).toBe(want);
			});
		}

		// Port additions: the code points where JavaScript's String.prototype.trim and Go's
		// unicode.IsSpace disagree, plus the other White_Space characters a policy file could
		// realistically carry.
		it("keeps U+FEFF, which String.prototype.trim would strip", () => {
			expect(trimSpace("﻿log﻿")).toBe("﻿log﻿");
		});

		it("strips U+0085 NEXT LINE, which String.prototype.trim would keep", () => {
			expect(trimSpace("\u0085log\u0085")).toBe("log");
		});

		it("strips U+00A0 NO-BREAK SPACE and U+2028 LINE SEPARATOR", () => {
			expect(trimSpace("  log  ")).toBe("log");
		});

		it("does not split a surrogate pair", () => {
			expect(trimSpace(" \u{1f600} ")).toBe("\u{1f600}");
		});
	});

	describe("fields", () => {
		// fieldsTests: lifted from Go's strings.TestFields. Go's case with invalid UTF-8
		// bytes (\xFF) has no JavaScript-string counterpart and is not carried.
		const faces = "☺☻☹";
		const tests: Array<[string, string[]]> = [
			["", []],
			[" ", []],
			[" \t ", []],
			[" ", []],
			["  abc  ", ["abc"]],
			["1 2 3 4", ["1", "2", "3", "4"]],
			["1  2  3  4", ["1", "2", "3", "4"]],
			["1\t\t2\t\t3\t4", ["1", "2", "3", "4"]],
			["1 2 3 4", ["1", "2", "3", "4"]],
			["   ", []],
			["\n™\t™\n", ["™", "™"]],
			["\n 1™2    ™", ["1™2", "™"]],
			["\n1� �2 3�4", ["1�", "�2", "3�4"]],
			[faces, [faces]],
		];
		for (const [input, want] of tests) {
			it(`fields(${JSON.stringify(input)})`, () => {
				expect(fields(input)).toEqual(want);
			});
		}

		// Port additions, as for trimSpace.
		it("does not split on U+FEFF, which /\\s/ would", () => {
			expect(fields("﻿log quorum")).toEqual(["﻿log", "quorum"]);
		});

		it("splits on U+0085, U+00A0 and U+2028, which a /\\s/ split only partly would", () => {
			expect(fields("a\u0085b c d")).toEqual(["a", "b", "c", "d"]);
		});

		it("keeps a surrogate pair inside its field", () => {
			expect(fields("a\u{1f600}b c")).toEqual(["a\u{1f600}b", "c"]);
		});
	});
});
