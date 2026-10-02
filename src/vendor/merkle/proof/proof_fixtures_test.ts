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

// Golden-fixture tests for merkle/proof. The vectors in fixtures/data are
// emitted by the real Go implementation; see fixtures/README.md and
// docs/decisions/0006-golden-fixtures-from-go.md.
//
// The proof *bytes* are produced here the way a caller produces them — through
// testonly.Tree, which drives proof.Inclusion/Consistency and Nodes.rehash — so
// this exercises the whole stack, not just the node-ID arithmetic.

import { beforeAll, describe, expect, it } from "vitest";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { bytesToHex, type Fixture, hexToBytes, loadFixture, u64 } from "../../../testonly/fixtures.ts";
import { newNodeID } from "../compact/nodes.ts";
import { DefaultHasher } from "../rfc6962/rfc6962.ts";
import { Tree } from "../testonly/tree.ts";
import { consistency, inclusion } from "./proof.ts";
import { rootFromInclusionProof, verifyConsistency, verifyInclusion } from "./verify.ts";

interface NodesCase {
	readonly index: string;
	readonly size: string;
	readonly ids: readonly { level: number; index: string }[];
	readonly ephemLevel: number;
	readonly ephemIndex: string;
	readonly begin: number;
	readonly end: number;
	readonly wantErr: boolean;
	readonly wantErrMsg: string;
}

interface LeafProof {
	readonly index: string;
	readonly leaf: string;
	readonly leafHash: string;
	readonly proof: readonly string[];
}

interface TreeProofs {
	readonly size: string;
	readonly root: string;
	readonly proofs: readonly LeafProof[];
}

interface InclusionFixture {
	readonly entryScheme: string;
	readonly smallTrees: readonly TreeProofs[];
	readonly largeTrees: readonly TreeProofs[];
	readonly reference: {
		readonly leaves: readonly string[];
		readonly rootsBySize: readonly string[];
		readonly proofs: readonly TreeProofs[];
		readonly consistency: readonly { size1: string; size2: string; proof: readonly string[] }[];
	};
	readonly nodes: readonly NodesCase[];
	readonly verifyErrors: readonly {
		desc: string;
		index: string;
		size: string;
		leafHash: string;
		proof: readonly string[];
		root: string;
		wantErr: boolean;
		wantErrMsg: string;
	}[];
}

interface ConsistencyFixture {
	readonly entryScheme: string;
	readonly roots: readonly { size: string; root: string }[];
	readonly cases: readonly { size1: string; size2: string; proof: readonly string[] }[];
	readonly largeCases: readonly { size1: string; size2: string; proof: readonly string[] }[];
	readonly nodes: readonly NodesCase[];
	readonly verifyErrors: readonly {
		desc: string;
		size1: string;
		size2: string;
		proof: readonly string[];
		root1: string;
		root2: string;
		wantErr: boolean;
		wantErrMsg: string;
	}[];
}

// entryData mirrors the fixture corpus: entry i is the UTF-8 bytes of "entry-<i>".
function entryData(i: number): Uint8Array {
	return toUTF8(`entry-${i}`);
}

function buildTree(size: number): Tree {
	const tree = new Tree(DefaultHasher);
	for (let i = 0; i < size; i++) {
		tree.appendData(entryData(i));
	}
	return tree;
}

let inc: Fixture<InclusionFixture>;
let cons: Fixture<ConsistencyFixture>;
let corpus: Tree;

beforeAll(async () => {
	[inc, cons] = await Promise.all([
		loadFixture<InclusionFixture>("proof_inclusion"),
		loadFixture<ConsistencyFixture>("proof_consistency"),
	]);
	corpus = buildTree(5000);
}, 120000);

describe("proof fixtures: inclusion", () => {
	it("agrees on proof.inclusion's node IDs and ephemeral node", () => {
		expect(inc.nodes.length).toBeGreaterThan(0);
		for (const tc of inc.nodes) {
			const desc = `inclusion(${tc.index}, ${tc.size})`;
			if (tc.wantErr) {
				expect(() => inclusion(u64(tc.index), u64(tc.size)), desc).toThrow(tc.wantErrMsg);
				continue;
			}
			const got = inclusion(u64(tc.index), u64(tc.size));
			expect(got.ids, `${desc}: ids`).toEqual(tc.ids.map((n) => newNodeID(n.level, u64(n.index))));
			expect(got.ephem(), `${desc}: ephem`).toEqual([newNodeID(tc.ephemLevel, u64(tc.ephemIndex)), tc.begin, tc.end]);
		}
	});

	it("reproduces every proof for trees of size 1..40, and verifies it", () => {
		expect(inc.smallTrees.length).toBeGreaterThan(0);
		for (const t of inc.smallTrees) {
			const size = u64(t.size);
			expect(bytesToHex(corpus.hashAt(size)), `root at size ${t.size}`).toBe(t.root);
			for (const p of t.proofs) {
				const index = u64(p.index);
				const desc = `size ${t.size} index ${p.index}`;
				expect(bytesToHex(DefaultHasher.hashLeaf(hexToBytes(p.leaf))), `${desc}: leaf hash`).toBe(p.leafHash);
				const got = corpus.inclusionProof(index, size);
				expect(got.map(bytesToHex), desc).toEqual(p.proof);
				// The proof the fixture records must verify against the root it records.
				expect(() =>
					verifyInclusion(
						DefaultHasher,
						index,
						size,
						hexToBytes(p.leafHash),
						p.proof.map(hexToBytes),
						hexToBytes(t.root),
					),
				).not.toThrow();
			}
		}
	}, 60000);

	it("reproduces the selected proofs in trees up to 5000, and verifies them", () => {
		expect(inc.largeTrees.length).toBeGreaterThan(0);
		for (const t of inc.largeTrees) {
			const size = u64(t.size);
			expect(bytesToHex(corpus.hashAt(size)), `root at size ${t.size}`).toBe(t.root);
			for (const p of t.proofs) {
				const index = u64(p.index);
				const desc = `size ${t.size} index ${p.index}`;
				const got = corpus.inclusionProof(index, size);
				expect(got.map(bytesToHex), desc).toEqual(p.proof);
				const calcRoot = rootFromInclusionProof(
					DefaultHasher,
					index,
					size,
					hexToBytes(p.leafHash),
					p.proof.map(hexToBytes),
				);
				expect(bytesToHex(calcRoot), `${desc}: recomputed root`).toBe(t.root);
			}
		}
	}, 60000);

	it("agrees with the canonical RFC 6962 eight-leaf reference tree", () => {
		const ref = inc.reference;
		const tree = new Tree(DefaultHasher);
		for (const leaf of ref.leaves) {
			tree.appendData(hexToBytes(leaf));
		}
		ref.rootsBySize.forEach((want, size) => {
			expect(bytesToHex(tree.hashAt(BigInt(size))), `reference root at size ${size}`).toBe(want);
		});
		for (const t of ref.proofs) {
			const size = u64(t.size);
			for (const p of t.proofs) {
				const desc = `reference size ${t.size} index ${p.index}`;
				expect(tree.inclusionProof(u64(p.index), size).map(bytesToHex), desc).toEqual(p.proof);
			}
		}
		for (const c of ref.consistency) {
			const desc = `reference consistency ${c.size1}:${c.size2}`;
			expect(tree.consistencyProof(u64(c.size1), u64(c.size2)).map(bytesToHex), desc).toEqual(c.proof);
		}
	});

	it("agrees on rootFromInclusionProof's rejections", () => {
		expect(inc.verifyErrors.length).toBeGreaterThan(0);
		for (const tc of inc.verifyErrors) {
			const run = (): Uint8Array =>
				rootFromInclusionProof(
					DefaultHasher,
					u64(tc.index),
					u64(tc.size),
					hexToBytes(tc.leafHash),
					tc.proof.map(hexToBytes),
				);
			if (tc.wantErr) {
				expect(run, tc.desc).toThrow(tc.wantErrMsg);
			} else {
				expect(bytesToHex(run()), tc.desc).toBe(tc.root);
			}
		}
	});
});

describe("proof fixtures: consistency", () => {
	it("agrees on proof.consistency's node IDs and ephemeral node", () => {
		expect(cons.nodes.length).toBeGreaterThan(0);
		for (const tc of cons.nodes) {
			// The generator names the two sizes `index` and `size`, in that order.
			const desc = `consistency(${tc.index}, ${tc.size})`;
			if (tc.wantErr) {
				expect(() => consistency(u64(tc.index), u64(tc.size)), desc).toThrow(tc.wantErrMsg);
				continue;
			}
			const got = consistency(u64(tc.index), u64(tc.size));
			expect(got.ids, `${desc}: ids`).toEqual(tc.ids.map((n) => newNodeID(n.level, u64(n.index))));
			expect(got.ephem(), `${desc}: ephem`).toEqual([newNodeID(tc.ephemLevel, u64(tc.ephemIndex)), tc.begin, tc.end]);
		}
	});

	it("agrees on the root hash at every recorded size", () => {
		expect(cons.roots.length).toBeGreaterThan(0);
		for (const tc of cons.roots) {
			expect(bytesToHex(corpus.hashAt(u64(tc.size))), `root at size ${tc.size}`).toBe(tc.root);
		}
	});

	it("reproduces every proof for pairs up to 40, and verifies it", () => {
		expect(cons.cases.length).toBeGreaterThan(0);
		const rootBySize = new Map(cons.roots.map((r) => [r.size, r.root]));
		for (const tc of cons.cases) {
			const size1 = u64(tc.size1);
			const size2 = u64(tc.size2);
			const desc = `consistencyProof(${tc.size1}, ${tc.size2})`;
			expect(corpus.consistencyProof(size1, size2).map(bytesToHex), desc).toEqual(tc.proof);
			const root1 = rootBySize.get(tc.size1);
			const root2 = rootBySize.get(tc.size2);
			expect(root1, `no recorded root for size ${tc.size1}`).toBeDefined();
			expect(root2, `no recorded root for size ${tc.size2}`).toBeDefined();
			expect(() =>
				verifyConsistency(
					DefaultHasher,
					size1,
					size2,
					tc.proof.map(hexToBytes),
					hexToBytes(root1 as string),
					hexToBytes(root2 as string),
				),
			).not.toThrow();
		}
	}, 120000);

	it("reproduces the selected large proofs, and verifies them", () => {
		expect(cons.largeCases.length).toBeGreaterThan(0);
		const rootBySize = new Map(cons.roots.map((r) => [r.size, r.root]));
		for (const tc of cons.largeCases) {
			const size1 = u64(tc.size1);
			const size2 = u64(tc.size2);
			const desc = `consistencyProof(${tc.size1}, ${tc.size2})`;
			expect(corpus.consistencyProof(size1, size2).map(bytesToHex), desc).toEqual(tc.proof);
			const root1 = rootBySize.get(tc.size1);
			const root2 = rootBySize.get(tc.size2);
			if (root1 === undefined || root2 === undefined) {
				continue;
			}
			expect(() =>
				verifyConsistency(DefaultHasher, size1, size2, tc.proof.map(hexToBytes), hexToBytes(root1), hexToBytes(root2)),
			).not.toThrow();
		}
	}, 120000);

	it("agrees on verifyConsistency's rejections", () => {
		expect(cons.verifyErrors.length).toBeGreaterThan(0);
		for (const tc of cons.verifyErrors) {
			const run = (): void =>
				verifyConsistency(
					DefaultHasher,
					u64(tc.size1),
					u64(tc.size2),
					tc.proof.map(hexToBytes),
					hexToBytes(tc.root1),
					hexToBytes(tc.root2),
				);
			if (tc.wantErr) {
				expect(run, tc.desc).toThrow(tc.wantErrMsg);
			} else {
				expect(run, tc.desc).not.toThrow();
			}
		}
	});
});
