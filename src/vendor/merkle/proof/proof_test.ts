// Copyright 2022 Google LLC. All Rights Reserved.
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
// Ported from merkle/proof/proof_test.go @ v0.0.2

import { describe, expect, it } from "vitest";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { type NodeID, newNodeID } from "../compact/nodes.ts";
import { DefaultHasher } from "../rfc6962/rfc6962.ts";
import { consistency, inclusion, Nodes } from "./proof.ts";

const id = newNodeID;

// TestInclusion contains inclusion proof tests. For reference, consider the
// following example of a tree from RFC 6962:
//
//	           hash              <== Level 3
//	          /    \
//	         /      \
//	        /        \
//	       /          \
//	      /            \
//	     k              l        <== Level 2
//	    / \            / \
//	   /   \          /   \
//	  /     \        /     \
//	 g       h      i      [ ]   <== Level 1
//	/ \     / \    / \    /
//	a b     c d    e f    j      <== Level 0
//	| |     | |    | |    |
//	d0 d1   d2 d3  d4 d5  d6
//
// Our storage node layers are always populated from the bottom up, hence the
// gap at level 1, index 3 in the above picture.
describe("TestInclusion", () => {
	const tests: {
		size: bigint; // The requested past tree size.
		index: bigint; // Leaf index in the requested tree.
		want?: Nodes;
		wantErr?: boolean;
	}[] = [
		// Errors.
		{ size: 0n, index: 0n, wantErr: true },
		{ size: 0n, index: 1n, wantErr: true },
		{ size: 1n, index: 2n, wantErr: true },
		{ size: 0n, index: 3n, wantErr: true },
		{ size: 7n, index: 8n, wantErr: true },

		// Small trees.
		{ size: 1n, index: 0n, want: nodes() },
		{ size: 2n, index: 0n, want: nodes(id(0, 1n)) }, // b
		{ size: 2n, index: 1n, want: nodes(id(0, 0n)) }, // a
		{ size: 3n, index: 1n, want: rehash(1, 2, id(0, 0n), id(0, 2n)) }, // a c

		// Tree of size 7.
		// biome-ignore format: keep the upstream row layout
		{ size: 7n, index: 0n, want: rehash(2, 4, // l=hash(i,j)
			id(0, 1n), id(1, 1n), id(0, 6n), id(1, 2n)) }, // b h j i
		// biome-ignore format: keep the upstream row layout
		{ size: 7n, index: 1n, want: rehash(2, 4, // l=hash(i,j)
			id(0, 0n), id(1, 1n), id(0, 6n), id(1, 2n)) }, // a h j i
		// biome-ignore format: keep the upstream row layout
		{ size: 7n, index: 2n, want: rehash(2, 4, // l=hash(i,j)
			id(0, 3n), id(1, 0n), id(0, 6n), id(1, 2n)) }, // d g j i
		// biome-ignore format: keep the upstream row layout
		{ size: 7n, index: 3n, want: rehash(2, 4, // l=hash(i,j)
			id(0, 2n), id(1, 0n), id(0, 6n), id(1, 2n)) }, // c g j i
		{ size: 7n, index: 4n, want: rehash(1, 2, id(0, 5n), id(0, 6n), id(2, 0n)) }, // f j k
		{ size: 7n, index: 5n, want: rehash(1, 2, id(0, 4n), id(0, 6n), id(2, 0n)) }, // e j k
		{ size: 7n, index: 6n, want: nodes(id(1, 2n), id(2, 0n)) }, // i k

		// Smaller trees within a bigger stored tree.
		{ size: 4n, index: 2n, want: nodes(id(0, 3n), id(1, 0n)) }, // d g
		{ size: 5n, index: 3n, want: rehash(2, 3, id(0, 2n), id(1, 0n), id(0, 4n)) }, // c g e
		{ size: 6n, index: 3n, want: rehash(2, 3, id(0, 2n), id(1, 0n), id(1, 2n)) }, // c g i
		{ size: 6n, index: 4n, want: nodes(id(0, 5n), id(2, 0n)) }, // f k
		// biome-ignore format: keep the upstream row layout
		{ size: 7n, index: 1n, want: rehash(2, 4, // l=hash(i,j)
			id(0, 0n), id(1, 1n), id(0, 6n), id(1, 2n)) }, // a h j i
		// biome-ignore format: keep the upstream row layout
		{ size: 7n, index: 3n, want: rehash(2, 4, // l=hash(i,j)
			id(0, 2n), id(1, 0n), id(0, 6n), id(1, 2n)) }, // c g j i

		// Some rehashes in the middle of the returned list.
		{
			size: 15n,
			index: 10n,
			want: rehash(2, 4, id(0, 11n), id(1, 4n), id(0, 14n), id(1, 6n), id(3, 0n)),
		},
		{
			size: 31n,
			index: 24n,
			want: rehash(2, 4, id(0, 25n), id(1, 13n), id(0, 30n), id(1, 14n), id(3, 2n), id(4, 0n)),
		},
		{
			size: 95n,
			index: 81n,
			want: rehash(3, 6, id(0, 80n), id(1, 41n), id(2, 21n), id(0, 94n), id(1, 46n), id(2, 22n), id(4, 4n), id(6, 0n)),
		},
	];

	for (const tc of tests) {
		it(`${tc.size}:${tc.index}`, () => {
			if (tc.wantErr === true) {
				expect(() => inclusion(tc.index, tc.size)).toThrow();
				return;
			}
			const proof = inclusion(tc.index, tc.size);
			// Ignore the ephemeral node, it is tested separately.
			proof._ephem = id(0, 0n);
			expect(proof).toEqual(tc.want);
		});
	}
});

// TestConsistency contains consistency proof tests. For reference, consider
// the following example:
//
//	           hash5                         hash7
//	          /    \                        /    \
//	         /      \                      /      \
//	        /        \                    /        \
//	       /          \                  /          \
//	      /            \                /            \
//	     k             [ ]    -->      k              l
//	    / \            /              / \            / \
//	   /   \          /              /   \          /   \
//	  /     \        /              /     \        /     \
//	 g       h     [ ]             g       h      i      [ ]
//	/ \     / \    /              / \     / \    / \    /
//	a b     c d    e              a b     c d    e f    j
//	| |     | |    |              | |     | |    | |    |
//	d0 d1   d2 d3  d4             d0 d1   d2 d3  d4 d5  d6
//
// The consistency proof between tree size 5 and 7 consists of nodes e, f, j,
// and k. The node j is taken instead of its missing parent.
describe("TestConsistency", () => {
	const tests: {
		size1: bigint; // The smaller of the two tree sizes.
		size2: bigint; // The bigger of the two tree sizes.
		want?: Nodes;
		wantErr?: boolean;
	}[] = [
		// Errors.
		{ size1: 5n, size2: 0n, wantErr: true },
		{ size1: 9n, size2: 8n, wantErr: true },

		{ size1: 1n, size2: 2n, want: nodes(id(0, 1n)) }, // b
		{ size1: 1n, size2: 4n, want: nodes(id(0, 1n), id(1, 1n)) }, // b h
		{ size1: 1n, size2: 6n, want: rehash(2, 3, id(0, 1n), id(1, 1n), id(1, 2n)) }, // b h i
		{ size1: 2n, size2: 3n, want: rehash(0, 1, id(0, 2n)) }, // c
		{ size1: 2n, size2: 8n, want: nodes(id(1, 1n), id(2, 1n)) }, // h l
		// biome-ignore format: keep the upstream row layout
		{ size1: 3n, size2: 7n, want: rehash(3, 5, // l=hash(i,j)
			id(0, 2n), id(0, 3n), id(1, 0n), id(0, 6n), id(1, 2n)) }, // c d g j i
		// biome-ignore format: keep the upstream row layout
		{ size1: 4n, size2: 7n, want: rehash(0, 2, // l=hash(i,j)
			id(0, 6n), id(1, 2n)) }, // j i
		{
			size1: 5n,
			size2: 7n,
			want: rehash(2, 3, id(0, 4n), id(0, 5n), id(0, 6n), id(2, 0n)), // e f j k
		},
		{ size1: 6n, size2: 7n, want: rehash(1, 2, id(1, 2n), id(0, 6n), id(2, 0n)) }, // i j k
		{ size1: 7n, size2: 8n, want: nodes(id(0, 6n), id(0, 7n), id(1, 2n), id(2, 0n)) }, // j leaf#7 i k

		// Same tree size.
		{ size1: 1n, size2: 1n, want: nodes() },
		{ size1: 2n, size2: 2n, want: nodes() },
		{ size1: 3n, size2: 3n, want: nodes() },
		{ size1: 4n, size2: 4n, want: nodes() },
		{ size1: 5n, size2: 5n, want: nodes() },
		{ size1: 7n, size2: 7n, want: nodes() },
		{ size1: 8n, size2: 8n, want: nodes() },

		// Smaller trees within a bigger stored tree.
		{ size1: 2n, size2: 4n, want: nodes(id(1, 1n)) }, // h
		{ size1: 3n, size2: 5n, want: rehash(3, 4, id(0, 2n), id(0, 3n), id(1, 0n), id(0, 4n)) }, // c d g e
		{ size1: 3n, size2: 6n, want: rehash(3, 4, id(0, 2n), id(0, 3n), id(1, 0n), id(1, 2n)) }, // c d g i
		{ size1: 4n, size2: 6n, want: rehash(0, 1, id(1, 2n)) }, // i
		// biome-ignore format: keep the upstream row layout
		{ size1: 1n, size2: 7n, want: rehash(2, 4, // l=hash(i,j)
			id(0, 1n), id(1, 1n), id(0, 6n), id(1, 2n)) }, // b h j i

		// Some rehashes in the middle of the returned list.
		{
			size1: 10n,
			size2: 15n,
			want: rehash(2, 4, id(1, 4n), id(1, 5n), id(0, 14n), id(1, 6n), id(3, 0n)),
		},
		{
			size1: 24n,
			size2: 31n,
			want: rehash(1, 4, id(3, 2n), id(0, 30n), id(1, 14n), id(2, 6n), id(4, 0n)),
		},
		{
			size1: 81n,
			size2: 95n,
			want: rehash(
				4,
				7,
				id(0, 80n),
				id(0, 81n),
				id(1, 41n),
				id(2, 21n),
				id(0, 94n),
				id(1, 46n),
				id(2, 22n),
				id(4, 4n),
				id(6, 0n),
			),
		},
	];

	for (const tc of tests) {
		it(`${tc.size1}:${tc.size2}`, () => {
			if (tc.wantErr === true) {
				expect(() => consistency(tc.size1, tc.size2)).toThrow();
				return;
			}
			const proof = consistency(tc.size1, tc.size2);
			// Ignore the ephemeral node, it is tested separately.
			proof._ephem = id(0, 0n);
			expect(proof).toEqual(tc.want);
		});
	}
});

describe("TestInclusionSucceedsUpToTreeSize", () => {
	it("accepts every in-range index", () => {
		const maxSize = 555n;
		for (let ts = 1n; ts <= maxSize; ts++) {
			// Port note: upstream writes `for i := ts; i < ts; i++`, which never
			// runs. Kept verbatim rather than silently "fixed".
			for (let i = ts; i < ts; i++) {
				expect(() => inclusion(i, ts)).not.toThrow();
			}
		}
	});
});

describe("TestConsistencySucceedsUpToTreeSize", () => {
	it("accepts every in-range pair of sizes", () => {
		const maxSize = 100n;
		for (let s1 = 1n; s1 < maxSize; s1++) {
			for (let s2 = s1 + 1n; s2 <= maxSize; s2++) {
				expect(() => consistency(s1, s2), `consistency(${s1}, ${s2})`).not.toThrow();
			}
		}
	});
});

describe("TestEphem", () => {
	const tests: { index: bigint; size: bigint; want: NodeID }[] = [
		// Edge case: For perfect trees the ephemeral node is the sibling of the
		// root. However, it will not be used in the proof, as the corresponding
		// subtree is empty.
		{ index: 3n, size: 32n, want: id(5, 1n) },

		{ index: 0n, size: 9n, want: id(3, 1n) },
		{ index: 0n, size: 13n, want: id(3, 1n) },
		{ index: 7n, size: 13n, want: id(3, 1n) },
		{ index: 8n, size: 13n, want: id(2, 3n) },
		{ index: 11n, size: 13n, want: id(2, 3n) },
		// More edge cases when the computed ephemeral node is not used in the
		// proof, because it is fully outside the tree border.
		{ index: 12n, size: 13n, want: id(0, 13n) },
		{ index: 13n, size: 14n, want: id(1, 7n) },

		// There is only one node (level 0, index 1024) in the right subtree, but
		// the ephemeral node is at level 10 rather than level 0. This is because
		// for the purposes of the proof this node is *effectively* at level 10.
		{ index: 123n, size: 1025n, want: id(10, 1n) },

		{ index: 0n, size: 0xffffn, want: id(15, 1n) },
		{ index: 0xf000n, size: 0xffffn, want: id(11, 0x1fn) },
		{ index: 0xff00n, size: 0xffffn, want: id(7, 0x1ffn) },
		{ index: 0xfff0n, size: 0xffffn, want: id(3, 0x1fffn) },
		{ index: 0xffffn - 1n, size: 0xffffn, want: id(0, 0xffffn) },
	];

	for (const tc of tests) {
		it(`${tc.index}:${tc.size}`, () => {
			const n = inclusion(tc.index, tc.size);
			const [got] = n.ephem();
			expect(got).toEqual(tc.want);
		});
	}
});

describe("TestRehash", () => {
	const th = DefaultHasher;
	const h = [
		th.hashLeaf(toUTF8("Hash 1")),
		th.hashLeaf(toUTF8("Hash 2")),
		th.hashLeaf(toUTF8("Hash 3")),
		th.hashLeaf(toUTF8("Hash 4")),
		th.hashLeaf(toUTF8("Hash 5")),
	];
	const at = (i: number): Uint8Array => h[i] as Uint8Array;

	const tests: { desc: string; hashes: Uint8Array[]; nodes: Nodes; want: Uint8Array[] }[] = [
		{
			desc: "no-rehash",
			hashes: h.slice(0, 3),
			nodes: inclusion(3n, 8n),
			want: h.slice(0, 3),
		},
		{
			desc: "rehash",
			hashes: h.slice(0, 5),
			nodes: inclusion(9n, 15n),
			want: [at(0), at(1), th.hashChildren(at(3), at(2)), at(4)],
		},
		{
			desc: "rehash-at-the-end",
			hashes: h.slice(0, 4),
			nodes: inclusion(2n, 7n),
			want: [at(0), at(1), th.hashChildren(at(3), at(2))],
		},
	];

	for (const tc of tests) {
		it(tc.desc, () => {
			const hashes = [...tc.hashes];
			const got = tc.nodes.rehash(hashes, th.hashChildren.bind(th));
			expect(got).toEqual(tc.want);
		});
	}
});

// nodes and rehash mirror the local helpers of proof_test.go. They build the
// expected Nodes value, with the ephemeral node left at its zero value.
function nodes(...ids: NodeID[]): Nodes {
	return new Nodes(ids, 0, 0, id(0, 0n));
}

function rehash(begin: number, end: number, ...ids: NodeID[]): Nodes {
	return new Nodes(ids, begin, end, id(0, 0n));
}

// Not upstream: inclusion and consistency refuse values Go's uint64 cannot hold
// (docs/decisions/0207-uint64-domain-guards.md).
describe("uint64 domain (port hardening)", () => {
	const B64 = 1n << 64n;
	it("rejects negative and over-wide sizes and indices with a RangeError", () => {
		for (const call of [
			() => inclusion(-1n, 5n),
			() => inclusion(0n, B64),
			() => consistency(-1n, 5n),
			() => consistency(1n, B64),
			() => consistency(B64, B64 + 1n),
		]) {
			expect(call).toThrow(RangeError);
		}
	});

	// The lengths are what Go's proof.Inclusion / proof.Consistency return for the
	// same arguments.
	it("accepts the largest sizes Go can", () => {
		const max = B64 - 1n;
		expect(inclusion(max - 1n, max).ids.length).toBe(63);
		expect(consistency(1n, max).ids.length).toBe(126);
	});
});
