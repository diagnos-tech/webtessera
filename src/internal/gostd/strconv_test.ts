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
import { errorIs } from "./errors.ts";
import { ErrRange, ErrSyntax, maxQuotedNum, NumError, parseUint, quote } from "./strconv.ts";

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
				const err = thrown(() => parseUint(s, base, bitSize));
				expect(err).toBeInstanceOf(NumError);
				expect(errorIs(err, ErrSyntax)).toBe(true);
				expect(errorIs(err, ErrRange)).toBe(false);
				expect((err as Error).message).toBe(`strconv.ParseUint: parsing ${quote(s)}: invalid syntax`);
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
				const err = thrown(() => parseUint(s, base, bitSize));
				expect(err).toBeInstanceOf(NumError);
				expect(errorIs(err, ErrRange)).toBe(true);
				expect(errorIs(err, ErrSyntax)).toBe(false);
				expect((err as Error).message).toBe(`strconv.ParseUint: parsing ${quote(s)}: value out of range`);
			});
		}

		it("reports the Go error text and NumError fields", () => {
			const err = thrown(() => parseUint("bananas", 10, 64)) as NumError;
			expect(err.message).toBe('strconv.ParseUint: parsing "bananas": invalid syntax');
			expect(err.func).toBe("ParseUint");
			expect(err.num).toBe("bananas");
			expect(err.err).toBe(ErrSyntax);
			expect(err.cause).toBe(ErrSyntax);
			expect(messageOf(() => parseUint("18446744073709551616", 10, 64))).toBe(
				'strconv.ParseUint: parsing "18446744073709551616": value out of range',
			);
		});

		// The tables below are Go's own, from strconv/atoi_test.go (parseUint64Tests,
		// parseUint64BaseTests, parseUint32Tests), with nil/ErrSyntax/ErrRange as
		// undefined/"syntax"/"range".
		type Want = bigint | "syntax" | "range";
		const check = (s: string, base: number, bitSize: number, want: Want): void => {
			if (typeof want === "bigint") {
				expect(parseUint(s, base, bitSize)).toBe(want);
				return;
			}
			const err = thrown(() => parseUint(s, base, bitSize));
			expect(errorIs(err, want === "syntax" ? ErrSyntax : ErrRange)).toBe(true);
		};

		const parseUint64Tests: Array<[string, Want]> = [
			["", "syntax"],
			["0", 0n],
			["1", 1n],
			["12345", 12345n],
			["012345", 12345n],
			["12345x", "syntax"],
			["98765432100", 98765432100n],
			["18446744073709551615", (1n << 64n) - 1n],
			["18446744073709551616", "range"],
			["18446744073709551620", "range"],
			["1_2_3_4_5", "syntax"], // base=10 so no underscores allowed
			["_12345", "syntax"],
			["1__2345", "syntax"],
			["12345_", "syntax"],
			["-0", "syntax"],
			["-1", "syntax"],
			["+1", "syntax"],
		];
		it("TestParseUint64", () => {
			for (const [s, want] of parseUint64Tests) {
				check(s, 10, 64, want);
			}
		});

		const parseUint64BaseTests: Array<[string, number, Want]> = [
			["", 0, "syntax"],
			["0", 0, 0n],
			["0x", 0, "syntax"],
			["0X", 0, "syntax"],
			["1", 0, 1n],
			["12345", 0, 12345n],
			["012345", 0, 0o12345n],
			["0x12345", 0, 0x12345n],
			["0X12345", 0, 0x12345n],
			["12345x", 0, "syntax"],
			["0xabcdefg123", 0, "syntax"],
			["123456789abc", 0, "syntax"],
			["98765432100", 0, 98765432100n],
			["18446744073709551615", 0, (1n << 64n) - 1n],
			["18446744073709551616", 0, "range"],
			["18446744073709551620", 0, "range"],
			["0xFFFFFFFFFFFFFFFF", 0, (1n << 64n) - 1n],
			["0x10000000000000000", 0, "range"],
			["01777777777777777777777", 0, (1n << 64n) - 1n],
			["01777777777777777777778", 0, "syntax"],
			["02000000000000000000000", 0, "range"],
			["0200000000000000000000", 0, 1n << 61n],
			["0b", 0, "syntax"],
			["0B", 0, "syntax"],
			["0b101", 0, 5n],
			["0B101", 0, 5n],
			["0o", 0, "syntax"],
			["0O", 0, "syntax"],
			["0o377", 0, 255n],
			["0O377", 0, 255n],

			// underscores allowed with base == 0 only
			["1_2_3_4_5", 0, 12345n], // base 0 => 10
			["_12345", 0, "syntax"],
			["1__2345", 0, "syntax"],
			["12345_", 0, "syntax"],

			["1_2_3_4_5", 10, "syntax"], // base 10
			["_12345", 10, "syntax"],
			["1__2345", 10, "syntax"],
			["12345_", 10, "syntax"],

			["0x_1_2_3_4_5", 0, 0x12345n], // base 0 => 16
			["_0x12345", 0, "syntax"],
			["0x__12345", 0, "syntax"],
			["0x1__2345", 0, "syntax"],
			["0x1234__5", 0, "syntax"],
			["0x12345_", 0, "syntax"],

			["1_2_3_4_5", 16, "syntax"], // base 16
			["_12345", 16, "syntax"],
			["1__2345", 16, "syntax"],
			["1234__5", 16, "syntax"],
			["12345_", 16, "syntax"],

			["0_1_2_3_4_5", 0, 0o12345n], // base 0 => 8 (0377)
			["_012345", 0, "syntax"],
			["0__12345", 0, "syntax"],
			["01234__5", 0, "syntax"],
			["012345_", 0, "syntax"],

			["0o_1_2_3_4_5", 0, 0o12345n], // base 0 => 8 (0o377)
			["_0o12345", 0, "syntax"],
			["0o__12345", 0, "syntax"],
			["0o1234__5", 0, "syntax"],
			["0o12345_", 0, "syntax"],

			["0_1_2_3_4_5", 8, "syntax"], // base 8
			["_012345", 8, "syntax"],
			["0__12345", 8, "syntax"],
			["01234__5", 8, "syntax"],
			["012345_", 8, "syntax"],

			["0b_1_0_1", 0, 5n], // base 0 => 2 (0b101)
			["_0b101", 0, "syntax"],
			["0b__101", 0, "syntax"],
			["0b1__01", 0, "syntax"],
			["0b10__1", 0, "syntax"],
			["0b101_", 0, "syntax"],

			["1_0_1", 2, "syntax"], // base 2
			["_101", 2, "syntax"],
			["1_01", 2, "syntax"],
			["10_1", 2, "syntax"],
			["101_", 2, "syntax"],
		];
		it("TestParseUint64Base", () => {
			for (const [s, base, want] of parseUint64BaseTests) {
				check(s, base, 64, want);
			}
		});

		const parseUint32Tests: Array<[string, Want]> = [
			["", "syntax"],
			["0", 0n],
			["1", 1n],
			["12345", 12345n],
			["012345", 12345n],
			["12345x", "syntax"],
			["987654321", 987654321n],
			["4294967295", (1n << 32n) - 1n],
			["4294967296", "range"],
			["1_2_3_4_5", "syntax"], // base=10 so no underscores allowed
			["_12345", "syntax"],
			["_12345", "syntax"],
			["1__2345", "syntax"],
			["12345_", "syntax"],
		];
		it("TestParseUint32", () => {
			for (const [s, want] of parseUint32Tests) {
				check(s, 10, 32, want);
			}
		});

		// Go checks for the empty string before it looks at the base, and treats a bit
		// size of 0 as IntSize (64 on every platform Tessera targets).
		it("follows Go's precedence for empty input, bad base and bad bit size", () => {
			expect(messageOf(() => parseUint("", 1, 64))).toBe('strconv.ParseUint: parsing "": invalid syntax');
			expect(messageOf(() => parseUint("12", 1, 64))).toBe('strconv.ParseUint: parsing "12": invalid base 1');
			expect(messageOf(() => parseUint("12", 37, 64))).toBe('strconv.ParseUint: parsing "12": invalid base 37');
			expect(messageOf(() => parseUint("12", 10, 65))).toBe('strconv.ParseUint: parsing "12": invalid bit size 65');
			expect(messageOf(() => parseUint("12", 10, -1))).toBe('strconv.ParseUint: parsing "12": invalid bit size -1');
			expect(messageOf(() => parseUint("x", 1, 65))).toBe('strconv.ParseUint: parsing "x": invalid base 1');
			expect(parseUint("18446744073709551615", 10, 0)).toBe((1n << 64n) - 1n);
			expect(
				errorIs(
					thrown(() => parseUint("18446744073709551616", 10, 0)),
					ErrRange,
				),
			).toBe(true);
		});

		// Go returns ErrRange at the digit that overflows and never looks at the rest,
		// so a trailing non-digit after an overflow is a range error, not a syntax error.
		it("reports overflow at the overflowing digit, before later syntax errors", () => {
			expect(
				errorIs(
					thrown(() => parseUint("99999999999999999999x", 10, 64)),
					ErrRange,
				),
			).toBe(true);
			expect(
				errorIs(
					thrown(() => parseUint("ffffffffffffffffx", 16, 32)),
					ErrRange,
				),
			).toBe(true);
			expect(
				errorIs(
					thrown(() => parseUint("ffffffffffffffffx", 16, 64)),
					ErrSyntax,
				),
			).toBe(true);
			expect(
				errorIs(
					thrown(() => parseUint("100000000x", 16, 32)),
					ErrRange,
				),
			).toBe(true);
			expect(
				errorIs(
					thrown(() => parseUint("256x", 10, 8)),
					ErrRange,
				),
			).toBe(true);
			expect(
				errorIs(
					thrown(() => parseUint("25x6", 10, 8)),
					ErrSyntax,
				),
			).toBe(true);
			expect(parseUint("255", 10, 8)).toBe(255n);
			expect(parseUint("9007199254740993", 10, 64)).toBe(9007199254740993n);
			expect(parseUint("zzzzzzzzzzzz", 36, 64)).toBe(4738381338321616895n);
			expect(
				errorIs(
					thrown(() => parseUint("zzzzzzzzzzzzz", 36, 64)),
					ErrRange,
				),
			).toBe(true);
		});

		it("rejects non-ASCII digits as invalid syntax", () => {
			for (const s of ["١٢٣", "12\u00b2", "\uff11"]) {
				expect(
					errorIs(
						thrown(() => parseUint(s, 10, 64)),
						ErrSyntax,
					),
				).toBe(true);
			}
		});

		// The loop is linear in the input length: overflow is detected at the 20th digit,
		// and leading zeros never leave the fast path. Before the transcription a
		// 400,000-digit input took seconds.
		it("is linear-time on very long inputs", () => {
			const big = 4_000_000;
			const t0 = performance.now();
			expect(
				errorIs(
					thrown(() => parseUint("9".repeat(big), 10, 64)),
					ErrRange,
				),
			).toBe(true);
			expect(parseUint(`${"0".repeat(big)}1`, 10, 64)).toBe(1n);
			expect(
				errorIs(
					thrown(() => parseUint(`${"0".repeat(big)}x`, 10, 64)),
					ErrSyntax,
				),
			).toBe(true);
			expect(
				errorIs(
					thrown(() => parseUint(`${"1".repeat(big)}x`, 16, 64)),
					ErrRange,
				),
			).toBe(true);
			expect(performance.now() - t0).toBeLessThan(5_000);
		});

		it("quotes at most maxQuotedNum characters of the input in the message", () => {
			const exact = "9".repeat(maxQuotedNum);
			expect(messageOf(() => parseUint(exact, 10, 64))).toBe(
				`strconv.ParseUint: parsing "${exact}": value out of range`,
			);
			const long = `${"9".repeat(maxQuotedNum)}99999`;
			const err = thrown(() => parseUint(long, 10, 64)) as NumError;
			expect(err.message).toBe(`strconv.ParseUint: parsing "${"9".repeat(maxQuotedNum)}"...: value out of range`);
			expect(err.num).toBe(long);
			const huge = thrown(() => parseUint("x".repeat(1_000_000), 10, 64)) as NumError;
			expect(huge.message.length).toBeLessThan(200);
			// A surrogate pair is never split.
			const astral = `${"\u{1f600}".repeat(maxQuotedNum + 1)}`;
			expect((thrown(() => parseUint(astral, 10, 64)) as Error).message).toBe(
				`strconv.ParseUint: parsing "${"\u{1f600}".repeat(maxQuotedNum)}"...: invalid syntax`,
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
			// Go escapes non-printable runes (not in categories L, M, N, P, S): C1
			// controls, non-ASCII spaces, format characters, private use, unassigned.
			["a\u0080b", '"a\\u0080b"'],
			["a\u009fb", '"a\\u009fb"'],
			["a\u00a0b", '"a\\u00a0b"'],
			["a\u00adb", '"a\\u00adb"'],
			["a\u2028b", '"a\\u2028b"'],
			["a\u200bb", '"a\\u200bb"'],
			["a\u3000b", '"a\\u3000b"'],
			["a\ufeffb", '"a\\ufeffb"'],
			["a\uffffb", '"a\\uffffb"'],
			["a\ue000b", '"a\\ue000b"'],
			["a\u{10ffff}b", '"a\\U0010ffffb"'],
			["a\u{1f600}b", '"a\u{1f600}b"'],
			["a\ufffdb", '"a\ufffdb"'],
			["a\ud800b", '"a\\ufffdb"'],
			// Assigned in Unicode 16, unassigned in Go 1.25's Unicode 15.0.0 tables: Go escapes
			// them whatever the JavaScript engine's Unicode version is, and so does quote.
			["a\u2ffcb", '"a\\u2ffcb"'],
			["a\u31efb", '"a\\u31efb"'],
			["a\u{2ebf0}b", '"a\\U0002ebf0b"'],
		];
		for (const [s, want] of tests) {
			it(`quotes ${JSON.stringify(s)}`, () => {
				expect(quote(s)).toBe(want);
			});
		}
	});
});

// thrown returns what fn throws, failing the test if it returns normally.
function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error("expected a throw");
}

// messageOf returns the message of what fn throws.
function messageOf(fn: () => unknown): string {
	return (thrown(fn) as Error).message;
}
