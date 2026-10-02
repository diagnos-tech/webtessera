// Copyright 2016 Google LLC. All Rights Reserved.
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
// Ported from merkle/rfc6962/rfc6962_test.go @ v0.0.2

import { describe, expect, it } from "vitest";
import { bytesEqual, concatBytes, fromHex, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { DefaultHasher } from "./rfc6962.ts";

describe("TestRFC6962Hasher", () => {
	const hasher = DefaultHasher;

	const leafHash = hasher.hashLeaf(toUTF8("L123456"));
	const emptyLeafHash = hasher.hashLeaf(new Uint8Array());

	const tests: { desc: string; got: Uint8Array; want: string }[] = [
		// echo -n | sha256sum
		{
			desc: "RFC6962 Empty",
			want: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			got: hasher.emptyRoot(),
		},
		// Check that the empty hash is not the same as the hash of an empty leaf.
		// echo -n 00 | xxd -r -p | sha256sum
		{
			desc: "RFC6962 Empty Leaf",
			want: "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
			got: emptyLeafHash,
		},
		// echo -n 004C313233343536 | xxd -r -p | sha256sum
		{
			desc: "RFC6962 Leaf",
			want: "395aa064aa4c29f7010acfe3f25db9485bbd4b91897b6ad7ad547639252b4d56",
			got: leafHash,
		},
		// echo -n 014E3132334E343536 | xxd -r -p | sha256sum
		{
			desc: "RFC6962 Node",
			want: "aa217fe888e47007fa15edab33c2b492a722cb106c64667fc2b044444de66bbb",
			got: hasher.hashChildren(toUTF8("N123"), toUTF8("N456")),
		},
	];

	for (const tc of tests) {
		it(tc.desc, () => {
			const wantBytes = fromHex(tc.want);
			expect(bytesEqual(tc.got, wantBytes)).toBe(true);
		});
	}
});

// TODO(pavelkalinnikov): Apply this test to all LogHasher implementations.
describe("TestRFC6962HasherCollisions", () => {
	it("is collision resistant", () => {
		const hasher = DefaultHasher;

		// Check that different leaves have different hashes.
		const leaf1 = toUTF8("Hello");
		const leaf2 = toUTF8("World");
		const hash1 = hasher.hashLeaf(leaf1);
		const hash2 = hasher.hashLeaf(leaf2);
		expect(bytesEqual(hash1, hash2)).toBe(false);

		// Compute an intermediate subtree hash.
		const subHash1 = hasher.hashChildren(hash1, hash2);
		// Check that this is not the same as a leaf hash of their concatenation.
		const preimage = concatBytes(hash1, hash2);
		const forgedHash = hasher.hashLeaf(preimage);
		expect(bytesEqual(subHash1, forgedHash)).toBe(false);

		// Swap the order of nodes and check that the hash is different.
		const subHash2 = hasher.hashChildren(hash2, hash1);
		expect(bytesEqual(subHash1, subHash2)).toBe(false);
	});
});

describe("Hasher", () => {
	it("reports the digest size", () => {
		expect(DefaultHasher.size()).toBe(32);
	});
});
