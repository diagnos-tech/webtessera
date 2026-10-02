// Copyright 2026 MedDeck. All Rights Reserved.
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
import { parseUint, quote } from "./strconv.ts";

describe("gostd/strconv", () => {
	describe("parseUint", () => {
		const good: Array<[string, number, number, bigint]> = [
			["0", 10, 64, 0n],
			["123", 10, 64, 123n],
			["9944", 10, 64, 9944n],
			["6476701", 10, 64, 6476701n],
			["18446744073709551615", 10, 64, 18446744073709551615n],
			["c74f20a3", 16, 32, 0xc74f20a3n],
			["ffffffff", 16, 32, 0xffffffffn],
			["FFFFFFFF", 16, 32, 0xffffffffn],
			["6086d1a9", 16, 64, 0x6086d1a9n],
			["00000000", 16, 32, 0n],
		];
		for (const [s, base, bitSize, want] of good) {
			it(`parses ${JSON.stringify(s)} base ${base}`, () => {
				expect(parseUint(s, base, bitSize)).toBe(want);
			});
		}

		// Go's ParseUint permits no sign, no "0x" prefix when the base is explicit,
		// and no underscores outside base 0.
		const badSyntax: Array<[string, number, number]> = [
			["", 10, 64],
			["-34", 10, 64],
			["+34", 10, 64],
			["bananas", 10, 64],
			["12a", 10, 64],
			["0x12", 16, 32],
			["1_0", 10, 64],
			[" 12", 10, 64],
			["12 ", 10, 64],
			["g", 16, 32],
		];
		for (const [s, base, bitSize] of badSyntax) {
			it(`rejects ${JSON.stringify(s)} base ${base} as invalid syntax`, () => {
				expect(() => parseUint(s, base, bitSize)).toThrow("invalid syntax");
			});
		}

		const outOfRange: Array<[string, number, number]> = [
			["3438945738945739845734895735", 10, 64],
			["18446744073709551616", 10, 64],
			["100000000", 16, 32],
			["4294967296", 10, 32],
		];
		for (const [s, base, bitSize] of outOfRange) {
			it(`rejects ${JSON.stringify(s)} base ${base} bitSize ${bitSize} as out of range`, () => {
				expect(() => parseUint(s, base, bitSize)).toThrow("value out of range");
			});
		}

		it("reports the Go error text", () => {
			expect(() => parseUint("bananas", 10, 64)).toThrow('strconv.ParseUint: parsing "bananas": invalid syntax');
			expect(() => parseUint("18446744073709551616", 10, 64)).toThrow(
				'strconv.ParseUint: parsing "18446744073709551616": value out of range',
			);
		});
	});

	describe("quote", () => {
		const tests: Array<[string, string]> = [
			["", '""'],
			["TestParseCheckpoint", '"TestParseCheckpoint"'],
			["go.sum database tree", '"go.sum database tree"'],
			['a"b', '"a\\"b"'],
			["a\\b", '"a\\\\b"'],
			["a\nb", '"a\\nb"'],
			["a\tb", '"a\\tb"'],
			["\x07\b\f\v\r", '"\\a\\b\\f\\v\\r"'],
			["\x01", '"\\x01"'],
			["\x7f", '"\\x7f"'],
			["日本語", '"日本語"'],
		];
		for (const [s, want] of tests) {
			it(`quotes ${JSON.stringify(s)}`, () => {
				expect(quote(s)).toBe(want);
			});
		}
	});
});
