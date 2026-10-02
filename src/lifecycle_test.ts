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
//
// There is no lifecycle_test.go upstream. These tests pin identityHash (which entry.ts
// and ct_only.ts both depend on) and the default antispam hashers, which have real
// parsing/hashing logic worth verifying directly even though Go never tested them
// in-package either.

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { appendUint16BE, concatBytes, toUTF8 } from "./internal/gostd/bytes.ts";
import { defaultIDHasher, defaultMerkleLeafHasher, identityHash } from "./lifecycle.ts";
import { DefaultHasher } from "./vendor/merkle/rfc6962/rfc6962.ts";

// buildBundle encodes entries the way api.EntryBundle.UnmarshalText expects to decode
// them (a 2-byte big-endian length prefix per entry). EntryBundle has no MarshalText in
// Go (only UnmarshalText), so tests that need bundle bytes build them by hand.
function buildBundle(entries: readonly Uint8Array[]): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const e of entries) {
		parts.push(appendUint16BE(new Uint8Array(0), e.length), e);
	}
	return concatBytes(...parts);
}

describe("lifecycle/identityHash", () => {
	it("is sha256 of the input", () => {
		const data = toUTF8("some entry data");
		expect(identityHash(data)).toEqual(sha256(data));
	});

	it("is deterministic", () => {
		const data = toUTF8("repeatable");
		expect(identityHash(data)).toEqual(identityHash(data));
	});

	it("differs for different inputs", () => {
		expect(identityHash(toUTF8("a"))).not.toEqual(identityHash(toUTF8("b")));
	});
});

describe("lifecycle/defaultIDHasher", () => {
	it("returns sha256 of each entry in the bundle, in order", () => {
		const entries = [toUTF8("entry-0"), toUTF8("entry-1"), toUTF8("entry-2")];
		const bundle = buildBundle(entries);

		const got = defaultIDHasher(bundle);

		expect(got).toEqual(entries.map((e) => sha256(e)));
	});

	it("returns an empty list for an empty bundle", () => {
		const bundle = buildBundle([]);
		expect(defaultIDHasher(bundle)).toEqual([]);
	});

	it("wraps the unmarshal error with 'unmarshal: ', not chained via cause (Go's %v, not %w)", () => {
		const malformed = new Uint8Array([0, 5, 1, 2]); // claims 5 bytes of data, has 2
		expect(() => defaultIDHasher(malformed)).toThrow(/^unmarshal: /);
		try {
			defaultIDHasher(malformed);
			expect.unreachable();
		} catch (err) {
			expect((err as Error).cause).toBeUndefined();
		}
	});
});

describe("lifecycle/defaultMerkleLeafHasher", () => {
	it("returns the RFC6962 leaf hash of each entry in the bundle, in order", () => {
		const entries = [toUTF8("entry-0"), toUTF8("entry-1"), toUTF8("entry-2")];
		const bundle = buildBundle(entries);

		const got = defaultMerkleLeafHasher(bundle);

		expect(got).toEqual(entries.map((e) => DefaultHasher.hashLeaf(e)));
	});

	it("returns an empty list for an empty bundle", () => {
		const bundle = buildBundle([]);
		expect(defaultMerkleLeafHasher(bundle)).toEqual([]);
	});

	it("throws on a malformed bundle", () => {
		const malformed = new Uint8Array([0, 5, 1, 2]);
		expect(() => defaultMerkleLeafHasher(malformed)).toThrow(/^unmarshal: /);
	});
});
