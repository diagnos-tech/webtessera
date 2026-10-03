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
import { bytesCompare, toUTF8 } from "../../internal/gostd/bytes.ts";
import { newRand } from "../../internal/gostd/rand.ts";
import { encodeKey, type KeyRange, prefixRange } from "./keys.ts";
import { prefixCases } from "./testing/prefix_cases.ts";

/** inRange reports whether the encoded key lies in r, comparing bytes as SQLite's BINARY collation does. */
function inRange(key: string, r: KeyRange | undefined): boolean {
	if (r === undefined) {
		return false;
	}
	const k = toUTF8(key);
	return bytesCompare(k, r.from) >= 0 && (r.to === undefined || bytesCompare(k, r.to) < 0);
}

// alphabet holds the code units and code points at the edges of UTF-8's and UTF-16's
// encodings, from which random keys and prefixes are drawn.
const alphabet = [
	"\u0000",
	"\u0001",
	"a",
	"\u007f",
	"\u0080",
	"߿",
	"ࠀ",
	"퟿",
	"",
	"￿",
	"\u{10000}",
	"\u{1f600}",
	"\u{10ffff}",
	"\ud83d",
	"\ude00",
	"\udbff",
];

describe("encodeKey", () => {
	it("encodes well-formed keys as UTF-8", () => {
		expect(encodeKey("tile/0/x001/234")).toEqual(toUTF8("tile/0/x001/234"));
		expect(encodeKey("\u0000\u{10ffff}")).toEqual(new Uint8Array([0, 0xf4, 0x8f, 0xbf, 0xbf]));
	});

	it("rejects lone surrogates, which UTF-8 cannot represent", () => {
		for (const key of ["\ud800", "a\udfff", "\ude00\ud83d", "x\ud83d"]) {
			expect(() => encodeKey(key), JSON.stringify(key)).toThrow("lone surrogate");
		}
	});
});

describe("prefixRange", () => {
	for (const c of prefixCases) {
		it(`selects exactly the keys that start with the prefix: ${c.name}`, () => {
			const r = prefixRange(c.prefix);
			for (const k of c.drop) {
				expect(inRange(k, r), `${JSON.stringify(k)} is in range`).toBe(true);
			}
			for (const k of c.keep) {
				expect(inRange(k, r), `${JSON.stringify(k)} is out of range`).toBe(false);
			}
		});
	}

	it("agrees with String.prototype.startsWith on random keys and prefixes", () => {
		const rand = newRand(1n);
		const intn = (n: number): number => Number(rand.int63n(BigInt(n)));
		const pick = (max: number): string => {
			let s = "";
			for (let n = intn(max + 1); n > 0; n--) {
				s += alphabet[intn(alphabet.length)];
			}
			return s;
		};
		let checked = 0;
		for (let i = 0; i < 20_000; i++) {
			const prefix = pick(3);
			const key = prefix.slice(0, intn(prefix.length + 1)) + pick(3);
			try {
				encodeKey(key);
			} catch {
				continue;
			}
			expect(inRange(key, prefixRange(prefix)), `${JSON.stringify(prefix)} / ${JSON.stringify(key)}`).toBe(
				key.startsWith(prefix),
			);
			checked++;
		}
		expect(checked).toBeGreaterThan(5000);
	});
});
