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
// Ported from merkle/testonly/tree_test.go @ v0.0.2

import { describe, expect, it } from "vitest";
import { bytesEqual, toHex, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { newRand } from "../../../internal/gostd/rand.ts";
import { DefaultHasher } from "../rfc6962/rfc6962.ts";
import { leafInputs, rootHashes } from "./constants.ts";
import { refConsistencyProof, refInclusionProof, refRootHash } from "./reference.ts";
import { Tree } from "./tree.ts";

function validateTree(mt: Tree, size: bigint): void {
	expect(mt.size(), `Size: ${mt.size()}, want ${size}`).toBe(size);
	const roots = rootHashes();
	expect(bytesEqual(mt.hash(), roots[Number(size)] as Uint8Array), `Hash(${size})`).toBe(true);
	for (let s = 0n; s <= size; s++) {
		expect(bytesEqual(mt.hashAt(s), roots[Number(s)] as Uint8Array), `HashAt(${s}/${size})`).toBe(true);
	}
}

describe("TestBuildTreeBuildOneAtATime", () => {
	it("builds one entry at a time", () => {
		const mt = newTree([]);
		validateTree(mt, 0n);
		leafInputs().forEach((entry, i) => {
			mt.appendData(entry);
			validateTree(mt, BigInt(i + 1));
		});
	});
});

describe("TestBuildTreeBuildTwoChunks", () => {
	it("builds in two chunks", () => {
		const entries = leafInputs();
		const mt = newTree([]);
		mt.appendData(...entries.slice(0, 3));
		validateTree(mt, 3n);
		mt.appendData(...entries.slice(3, 8));
		validateTree(mt, 8n);
	});
});

describe("TestBuildTreeBuildAllAtOnce", () => {
	it("builds all at once", () => {
		const mt = newTree([]);
		mt.appendData(...leafInputs());
		validateTree(mt, 8n);
	});
});

describe("TestTreeHashAt", () => {
	const test = (desc: string, entries: Uint8Array[]): void => {
		it(desc, () => {
			const mt = newTree(entries);
			for (let size = 0; size <= entries.length; size++) {
				const got = mt.hashAt(BigInt(size));
				const want = refRootHash(entries.slice(0, size), mt._hasher);
				expect(bytesEqual(got, want), `HashAt(${size}): ${toHex(got)}, want ${toHex(want)}`).toBe(true);
			}
		});
	};

	const entries = leafInputs();
	for (let size = 0; size <= entries.length; size++) {
		test(`size:${size}`, entries.slice(0, size));
	}
	test("generated", genEntries(256));
});

describe("TestTreeInclusionProof", () => {
	const test = (desc: string, entries: Uint8Array[]): void => {
		it(desc, () => {
			const mt = newTree(entries);
			const size = BigInt(entries.length);
			for (let index = 0n; index < size; index++) {
				const got = mt.inclusionProof(index, size);
				const want = refInclusionProof(entries.slice(0, Number(size)), index, mt._hasher);
				expect(got, `InclusionProof(${index}, ${size})`).toEqual(want);
			}
		});
	};

	test("generated", genEntries(256));
	const entries = leafInputs();
	for (let size = 0; size < entries.length; size++) {
		test(`golden:${size}`, entries.slice(0, size));
	}
});

describe("TestTreeConsistencyProof", () => {
	const entries = leafInputs();
	const mt = newTree(entries);

	it("validates the tree", () => {
		validateTree(mt, 8n);
	});

	it("rejects a shrinking range", () => {
		expect(() => mt.consistencyProof(6n, 3n)).toThrow();
	});

	for (let size1 = 0n; size1 <= 8n; size1++) {
		for (let size2 = size1; size2 <= 8n; size2++) {
			const s1 = size1;
			const s2 = size2;
			it(`${s1}:${s2}`, () => {
				const got = mt.consistencyProof(s1, s2);
				const want = refConsistencyProof(entries.slice(0, Number(s2)), s2, s1, mt._hasher, true);
				expect(got).toEqual(want);
			});
		}
	}
});

// Make random proof queries and check against the reference implementation.
describe("TestTreeConsistencyProofFuzz", () => {
	it("matches the reference implementation for random queries", () => {
		const entries = genEntries(256);
		// Port note: upstream uses the package-level `rand`, which Go seeds
		// randomly; the port uses a seeded generator so failures reproduce.
		const rnd = newRand(1n);

		for (let treeSize = 1n; treeSize <= 256n; treeSize++) {
			const mt = newTree(entries.slice(0, Number(treeSize)));
			for (let i = 0; i < 8; i++) {
				const size2 = rnd.int63n(treeSize + 1n);
				const size1 = rnd.int63n(size2 + 1n);

				const got = mt.consistencyProof(size1, size2);
				const want = refConsistencyProof(entries.slice(0, Number(size2)), size2, size1, mt._hasher, true);
				expect(got, `ConsistencyProof(${size1}, ${size2})`).toEqual(want);
			}
		}
	}, 60000);
});

describe("TestTreeAppend", () => {
	it("agrees with appendData", () => {
		const entries = genEntries(256);
		const mt1 = newTree(entries);

		const mt2 = newTree([]);
		for (const entry of entries) {
			mt2.append(DefaultHasher.hashLeaf(entry));
		}

		expect(mt1, "Trees built with appendData and append mismatch").toEqual(mt2);
	});
});

describe("TestTreeAppendAssociativity", () => {
	it("is associative", () => {
		const entries = genEntries(256);
		const mt1 = newTree([]);
		mt1.appendData(...entries);

		const mt2 = newTree([]);
		for (const entry of entries) {
			mt2.appendData(entry);
		}

		expect(mt1, "appendData is not associative").toEqual(mt2);
	});
});

function newTree(entries: Uint8Array[]): Tree {
	const tree = new Tree(DefaultHasher);
	tree.appendData(...entries);
	return tree;
}

// genEntries a slice of entries of the given size.
function genEntries(size: number): Uint8Array[] {
	const entries: Uint8Array[] = new Array<Uint8Array>(size);
	for (let i = 0; i < size; i++) {
		entries[i] = toUTF8(String(i));
	}
	return entries;
}
