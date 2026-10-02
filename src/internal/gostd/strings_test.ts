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
import { cut } from "./strings.ts";

describe("gostd/strings", () => {
	describe("cut", () => {
		// Cases lifted from Go's strings.TestCut.
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
});
