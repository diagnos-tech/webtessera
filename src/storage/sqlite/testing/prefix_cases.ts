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

// Boundary cases for the SQLite ObjectStore's deletePrefix, shared by every engine's
// suite so that each is held to the same key ordering. Test-only.

/** PrefixCase is one deletePrefix call and the keys it must and must not remove. */
export interface PrefixCase {
	readonly name: string;
	readonly prefix: string;
	readonly drop: readonly string[];
	readonly keep: readonly string[];
}

/**
 * prefixCases probe the edges of the TEXT range deletePrefix derives from a prefix.
 * SQLite's BINARY collation compares UTF-8 bytes, so the interesting keys sit at the
 * ends of UTF-8's encoding lengths, at the largest code point (whose successor is not
 * UTF-8), beside the surrogate range UTF-8 skips, and after a prefix that ends half-way
 * through a surrogate pair. LIKE metacharacters must mean nothing, and NUL is a byte
 * like any other.
 */
export const prefixCases: readonly PrefixCase[] = [
	{
		name: "ASCII prefix",
		prefix: "a",
		drop: ["a", "a\u0000", "ab", "a\u007f", "a\u0080", "a￿", "a\u{10000}", "a\u{10ffff}"],
		keep: ["", "`", "A", "b", "b\u0000", "á", "\u0000"],
	},
	{
		name: "LIKE metacharacters",
		prefix: "tile/%_",
		drop: ["tile/%_", "tile/%_x", "tile/%_%"],
		keep: ["tile/%", "tile/a_", "tile/%a", "tile/x_x", "tile/_%"],
	},
	{
		name: "prefix ending in U+FFFF",
		prefix: "a￿",
		drop: ["a￿", "a￿\u0000", "a￿￿", "a￿z", "a￿\u{10000}"],
		keep: ["a", "a￾", "a￾￿", "a\u{10000}", "b"],
	},
	{
		name: "prefix ending in U+10FFFF",
		prefix: "a\u{10ffff}",
		drop: ["a\u{10ffff}", "a\u{10ffff}\u{10ffff}", "a\u{10ffff}z"],
		keep: ["a", "a\u{10fffe}", "a\u{10fffe}\u{10ffff}", "a￿", "b"],
	},
	{
		name: "prefix of only U+10FFFF",
		prefix: "\u{10ffff}\u{10ffff}",
		drop: ["\u{10ffff}\u{10ffff}", "\u{10ffff}\u{10ffff}\u0000", "\u{10ffff}\u{10ffff}\u{10ffff}"],
		keep: ["\u{10ffff}", "\u{10ffff}\u{10fffe}", "\u{10fffe}\u{10ffff}\u{10ffff}", "z"],
	},
	{
		name: "prefix ending just below the surrogate range",
		prefix: "x퟿",
		drop: ["x퟿", "x퟿퟿", "x퟿\u{10000}"],
		keep: ["x", "x퟾", "x", "x\u{10000}", "x￿"],
	},
	{
		name: "prefix ending in a high surrogate",
		prefix: "x\ud83d",
		drop: ["x\u{1f400}", "x\u{1f600}", "x\u{1f64f}y", "x\u{1f7ff}", "x\u{1f7ff}\u{10ffff}"],
		keep: ["x", "x\u{1f3ff}", "x\u{1f800}", "x퟿", "x", "x￿", "y"],
	},
	{
		name: "prefix ending in the last high surrogate",
		prefix: "x\udbff",
		drop: ["x\u{10fc00}", "x\u{10ffff}", "x\u{10ffff}z"],
		keep: ["x", "x\u{10fbff}", "x￿", "y"],
	},
	{
		name: "prefix ending in a lone low surrogate",
		prefix: "x\ude00",
		drop: [],
		keep: ["x", "x\u{1f600}", "x", "y"],
	},
	{
		name: "prefix with a lone surrogate inside",
		prefix: "x\ud83dy",
		drop: [],
		keep: ["x", "x\u{1f600}y", "xy"],
	},
	{
		name: "prefix ending in NUL",
		prefix: "a\u0000",
		drop: ["a\u0000", "a\u0000\u0000", "a\u0000b"],
		keep: ["a", "a\u0001", "ab", ""],
	},
	{
		name: "tile path prefix",
		prefix: "tile/0/x001/234.p/",
		drop: ["tile/0/x001/234.p/1", "tile/0/x001/234.p/255"],
		keep: ["tile/0/x001/234", "tile/0/x001/234.p", "tile/0/x001/2345.p/1", "tile/0/x001/234.q/1"],
	},
	{
		name: "empty prefix",
		prefix: "",
		drop: ["", "a", "\u0000", "￿", "tile/0/000", "\u{10ffff}"],
		keep: [],
	},
];
