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

// This file has no upstream counterpart. It maps ObjectStore keys, which are JavaScript
// strings, onto the TEXT values the SQLite ObjectStore stores them as, and a deletePrefix
// prefix onto the exact range of those values it selects. See
// docs/decisions/0151-sqlite-schema-and-chunking.md.

import { toUTF8 } from "../../internal/gostd/bytes.ts";

/** KeyRange is the half-open range [from, to) of UTF-8 encoded keys; to is undefined when unbounded. */
export interface KeyRange {
	readonly from: Uint8Array;
	readonly to: Uint8Array | undefined;
}

/**
 * encodeKey returns the UTF-8 encoding of key. It throws if key contains a lone
 * surrogate, which UTF-8 cannot represent: encoding it as U+FFFD would make two distinct
 * keys collide.
 */
export function encodeKey(key: string): Uint8Array {
	const bad = firstLoneSurrogate(key);
	if (bad >= 0) {
		throw new Error(
			`sqlite: key ${JSON.stringify(key)} is not well-formed Unicode: it has a lone surrogate at offset ${bad}`,
		);
	}
	return toUTF8(key);
}

/**
 * prefixRange returns the range of encoded keys that start with prefix, in the sense of
 * String.prototype.startsWith, or undefined if no key encodeKey accepts can.
 *
 * Under the BINARY collation SQLite orders TEXT by its UTF-8 bytes, which is code point
 * order, so the keys starting with a well-formed prefix p are exactly those from p up to
 * p's successor: p with its last byte incremented. UTF-8 never contains 0xFF, so the
 * increment never carries, though the successor is generally not valid UTF-8 itself.
 *
 * A prefix may end in a high surrogate whose low surrogate the key supplies: the keys
 * starting with "x\uD83D" are those continuing with one of the 1024 code points
 * U+1F400..U+1F7FF. Those form one contiguous range too, from the encoding of the first
 * up to the successor of the encoding of the last. A lone surrogate anywhere else cannot
 * occur in a well-formed key, so such a prefix selects nothing. The empty prefix selects
 * every key.
 */
export function prefixRange(prefix: string): KeyRange | undefined {
	const bad = firstLoneSurrogate(prefix);
	if (bad < 0) {
		const from = toUTF8(prefix);
		return { from, to: from.length === 0 ? undefined : successor(from) };
	}
	const unit = prefix.charCodeAt(bad);
	if (bad !== prefix.length - 1 || unit > 0xdbff) {
		return undefined;
	}
	const head = prefix.slice(0, bad);
	const first = 0x10000 + ((unit - 0xd800) << 10);
	return {
		from: toUTF8(head + String.fromCodePoint(first)),
		to: successor(toUTF8(head + String.fromCodePoint(first + 0x3ff))),
	};
}

/** successor returns the least byte string greater than every byte string that starts with b. */
function successor(b: Uint8Array): Uint8Array {
	const s = b.slice();
	s[s.length - 1] = (s[s.length - 1] ?? 0) + 1;
	return s;
}

/** firstLoneSurrogate returns the offset of the first unpaired surrogate code unit in s, or -1. */
function firstLoneSurrogate(s: string): number {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0xd800 || c > 0xdfff) {
			continue;
		}
		if (c <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				i++;
				continue;
			}
		}
		return i;
	}
	return -1;
}
