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

// Boundary cases for IndexedDBObjectStore.deletePrefix, shared by the fake-indexeddb
// and Chromium suites so that both are held to the same key ordering. Test-only.

/** PrefixCase is one deletePrefix call and the keys it must and must not remove. */
export interface PrefixCase {
	readonly name: string;
	readonly prefix: string;
	readonly drop: readonly string[];
	readonly keep: readonly string[];
}

/**
 * prefixCases probe the edges of the key range deletePrefix derives from a prefix:
 * IndexedDB orders string keys by UTF-16 code unit, so U+FFFF code units and
 * surrogate halves are where a naive `prefix + "￿"` upper bound goes wrong.
 */
export const prefixCases: readonly PrefixCase[] = [
	{
		name: "ASCII prefix",
		prefix: "a",
		drop: ["a", "a\u0000", "ab", "a￾", "a￿", "a￿￿", "a\u{1f600}"],
		keep: ["", "`", "A", "b", "b\u0000", "á"],
	},
	{
		name: "prefix ending in U+FFFF",
		prefix: "a￿",
		drop: ["a￿", "a￿\u0000", "a￿￿", "a￿z"],
		keep: ["a", "a￾", "a￾￿", "b", "b\u0000"],
	},
	{
		name: "prefix of only U+FFFF",
		prefix: "￿￿",
		drop: ["￿￿", "￿￿\u0000", "￿￿￿"],
		keep: ["￿", "￿￾", "￾￿￿", "z"],
	},
	{
		name: "prefix ending in a high surrogate",
		prefix: "x\ud83d",
		drop: ["x\ud83d", "x\u{1f600}", "x\u{1f64f}y"],
		keep: ["x", "x🏿", "x\ud83e", "x\u{1f900}"],
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
		drop: ["", "a", "￿", "tile/0/000", "\u{10ffff}"],
		keep: [],
	},
];
