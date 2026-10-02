// Copyright 2019 Google LLC. All Rights Reserved.
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
// Ported from merkle/compact/range_test.go @ v0.0.2
//
// This mirrors Go's external test package `compact_test`: it exercises only the
// exported surface. The in-package tests live in range_internal_test.ts.

import { describe, expect, it } from "vitest";
import { len64 } from "../../../internal/gostd/bits.ts";
import { bytesEqual, toBase64, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { newRand } from "../../../internal/gostd/rand.ts";
import { DefaultHasher } from "../rfc6962/rfc6962.ts";
import { compactTrees, leafInputs, rootHashes } from "../testonly/constants.ts";
import { type NodeID, newNodeID, rangeNodes } from "./nodes.ts";
import { decompose, type Range, RangeFactory, type VisitFn } from "./range.ts";

// Port note: Go's method value `rfc6962.DefaultHasher.HashChildren` carries its
// receiver; the TypeScript equivalent has to bind it explicitly.
const factory = new RangeFactory(DefaultHasher.hashChildren.bind(DefaultHasher));

// leafData returns test leaf data that depends on the passed in leaf index.
function leafData(index: bigint): Uint8Array {
	return toUTF8(`data: ${index}`);
}

// treeNode represents a Merkle tree node which roots a full binary subtree.
interface treeNode {
	hash: Uint8Array; // The Merkle hash of the subtree.
	visits: number; // The number of times this node was visited.
}

// tree contains a static Merkle tree, for testing.
class tree {
	size: bigint; // The number of leaves.
	nodes: treeNode[][]; // All perfect subtrees indexed by (level, index).

	constructor(size: bigint, nodes: treeNode[][]) {
		this.size = size;
		this.nodes = nodes;
	}

	// node returns the (level, index) node. Stands in for Go's `tr.nodes[l][i]`,
	// which TypeScript's noUncheckedIndexedAccess makes verbose at every use.
	node(level: number, index: number): treeNode {
		return (this.nodes[level] as treeNode[])[index] as treeNode;
	}

	// rootHash returns a canonical hash of the whole (possibly imperfect) tree.
	rootHash(): Uint8Array | null {
		let hash: Uint8Array | null = null;
		for (const level of this.nodes) {
			if (level.length % 2 === 1) {
				const root = (level[level.length - 1] as treeNode).hash;
				if (hash === null) {
					hash = root;
				} else {
					hash = factory.hash(root, hash);
				}
			}
		}
		return hash;
	}

	leaf(index: bigint): Uint8Array {
		return this.node(0, Number(index)).hash;
	}

	visit(level: number, index: bigint, hash: Uint8Array): void {
		if (level >= this.nodes.length || index >= BigInt((this.nodes[level] as treeNode[]).length)) {
			throw new Error("node does not exist");
		}
		const node = this.node(level, Number(index));
		node.visits++;
		const want = node.hash;
		if (!bytesEqual(hash, want)) {
			throw new Error(`hash mismatch: got ${toBase64(shorten(hash))}, want ${toBase64(shorten(want))}`);
		}
	}

	// verifyRange checks that the compact range's hashes match the tree.
	verifyRange(r: Range, wantMatch: boolean): void {
		let pos = r.begin();
		if (r.end() > this.size) {
			throw new Error(`range is too long: ${r.end()} > ${this.size}`);
		}

		// Naively build the expected list of hashes comprising the compact range.
		const [left, right] = decompose(pos, r.end());
		const hashes: Uint8Array[] = [];
		for (let lvl = 0; lvl < 64; lvl++) {
			if ((left & (1n << BigInt(lvl))) !== 0n) {
				hashes.push(this.node(lvl, Number(pos >> BigInt(lvl))).hash);
				pos += 1n << BigInt(lvl);
			}
		}
		// Port note: Go writes this as `for lvl := uint(63); lvl < 64; lvl--`,
		// relying on the unsigned counter overflowing to stop the loop.
		for (let lvl = 63; lvl >= 0; lvl--) {
			if ((right & (1n << BigInt(lvl))) !== 0n) {
				hashes.push(this.node(lvl, Number(pos >> BigInt(lvl))).hash);
				pos += 1n << BigInt(lvl);
			}
		}

		if (pos !== r.end()) {
			throw new Error(`decompose: range [${r.begin()},${r.end()}) is not covered; end=${pos}`);
		}
		const match = deepEqualHashes(r.hashes(), hashes);
		expect(match, `hashes match: ${match}, expected ${wantMatch}`).toBe(wantMatch);
	}

	// verifyAllVisited checks that all nodes of the tree are visited exactly once.
	// This is to verify the efficiency property of compact ranges: any merging
	// process resulting in a single range generates *all* internal nodes, and each
	// node is generated only once.
	verifyAllVisited(r: Range): void {
		expect([r.begin(), r.end()]).toEqual([0n, this.size]);
		for (let lvl = 0; lvl < this.nodes.length; lvl++) {
			const level = this.nodes[lvl] as treeNode[];
			for (let index = 0; index < level.length; index++) {
				const node = level[index] as treeNode;
				expect(node.visits, `Node (${lvl},${index}) visited ${node.visits} times, want 1`).toBe(1);
			}
		}
	}
}

// newTree creates a new Merkle tree of the given size.
function newTree(size: bigint): [tree, VisitFn] {
	const levels = len64(size);
	// Allocate the nodes.
	const nodes: treeNode[][] = new Array<treeNode[]>(levels);
	const tr = new tree(size, nodes);
	// Attach a visitor to the nodes.
	const visit: VisitFn = (id: NodeID, hash: Uint8Array): void => {
		tr.visit(id.level, id.index, hash);
	};

	for (let lvl = 0; lvl < levels; lvl++) {
		const width = Number(size >> BigInt(lvl));
		const row: treeNode[] = new Array<treeNode>(width);
		for (let i = 0; i < width; i++) {
			row[i] = { hash: new Uint8Array(), visits: 0 };
		}
		nodes[lvl] = row;
	}
	// Compute leaf hashes.
	for (let i = 0n; i < size; i++) {
		tr.node(0, Number(i)).hash = hashLeaf(leafData(i));
	}
	// Compute internal node hashes.
	for (let lvl = 1; lvl < levels; lvl++) {
		const row = nodes[lvl] as treeNode[];
		for (let i = 0; i < row.length; i++) {
			tr.node(lvl, i).hash = factory.hash(tr.node(lvl - 1, i * 2).hash, tr.node(lvl - 1, i * 2 + 1).hash);
		}
	}

	return [tr, visit];
}

describe("TestAppend", () => {
	const sizes: bigint[] = [];
	for (let size = 0n; size <= 256n; size++) {
		sizes.push(size);
	}
	sizes.push(555n, 1040n, 5431n);

	for (const size of sizes) {
		it(`size:${size}`, () => {
			const [tr, visit] = newTree(size);
			const cr = factory.newEmptyRange(0n);
			tr.verifyRange(cr, true);
			for (let i = 0n; i < size; i++) {
				cr.append(tr.leaf(i), visit);
				tr.verifyRange(cr, true);
			}
			tr.verifyAllVisited(cr);
		});
	}
});

describe("TestGoldenRanges", () => {
	const inputs = leafInputs();
	const roots = rootHashes();
	const hashes = compactTrees();

	for (let size = 0; size <= inputs.length; size++) {
		it(`size:${size}`, () => {
			const cr = factory.newEmptyRange(0n);
			for (let i = 0; i < size; i++) {
				cr.append(hashLeaf(inputs[i] as Uint8Array), null);
			}
			let hash = cr.getRootHash(null);
			if (size === 0) {
				expect(hash).toBeNull();
				hash = DefaultHasher.emptyRoot();
			}
			expect(bytesEqual(hash as Uint8Array, roots[size] as Uint8Array)).toBe(true);
			expect(deepEqualHashes(cr.hashes(), hashes[size] as Uint8Array[])).toBe(true);
		});
	}
});

// Merge down from [339,340) to [0,340) by prepending single entries.
describe("TestMergeBackwards", () => {
	it("merges backwards", () => {
		const numNodes = 340n;
		const [tr, visit] = newTree(numNodes);
		let rng = factory.newEmptyRange(numNodes);
		tr.verifyRange(rng, true);
		for (let i = numNodes; i > 0n; i--) {
			const prepend = factory.newEmptyRange(i - 1n);
			tr.verifyRange(prepend, true);
			prepend.append(tr.leaf(i - 1n), visit);
			tr.verifyRange(prepend, true);
			prepend.appendRange(rng, visit);
			rng = prepend;
			tr.verifyRange(rng, true);
		}
		tr.verifyAllVisited(rng);
	});
});

// Build ranges [0, 13), [13, 26), ... [208,220) by appending single entries to
// each. Then append those ranges one by one to [0,0), to get [0,220).
describe("TestMergeInBatches", () => {
	it("merges in batches", () => {
		const numNodes = 220n;
		const batch = 13n;
		const [tr, visit] = newTree(numNodes);

		const batches: Range[] = [];
		// Merge all the nodes within the batches.
		for (let i = 0n; i < numNodes; i += batch) {
			const rng = factory.newEmptyRange(i);
			tr.verifyRange(rng, true);
			for (let node = i; node < i + batch && node < numNodes; node++) {
				rng.append(tr.leaf(node), visit);
				tr.verifyRange(rng, true);
			}
			batches.push(rng);
		}

		const total = factory.newEmptyRange(0n);
		// Merge the batches.
		for (const b of batches) {
			total.appendRange(b, visit);
			tr.verifyRange(total, true);
		}
		tr.verifyAllVisited(total);
	});
});

// Build many trees of random size by randomly merging their sub-ranges.
describe("TestMergeRandomly", () => {
	for (let seed = 1n; seed < 100n; seed++) {
		it(`seed:${seed}`, () => {
			const rnd = newRand(seed);
			// Port note: upstream draws numNodes from the *global* rand, which Go
			// seeds randomly; the port draws it from the seeded generator so the
			// suite is reproducible. See ADR-0012.
			const numNodes = rnd.uint64() % 500n;

			const [tr, visit] = newTree(numNodes);
			const mergeAll = (begin: bigint, end: bigint): Range => {
				const rng = factory.newEmptyRange(begin);
				if (begin + 1n === end) {
					rng.append(tr.leaf(begin), visit);
				} else if (begin < end) {
					const mid = begin + rnd.int63n(end - begin);
					rng.appendRange(mergeAll(begin, mid), visit);
					rng.appendRange(mergeAll(mid, end), visit);
				}
				tr.verifyRange(rng, true);
				return rng;
			};
			const rng = mergeAll(0n, numNodes);
			tr.verifyAllVisited(rng);
		});
	}
});

describe("TestNewRange", () => {
	it("validates its arguments", () => {
		const numNodes = 123n;
		const [tr, visit] = newTree(numNodes);
		const rng = factory.newEmptyRange(0n);
		for (let i = 0n; i < numNodes; i++) {
			rng.append(tr.leaf(i), visit);
		}

		expect(() => factory.newRange(10n, 5n, [])).toThrow();

		const rng1 = factory.newRange(rng.begin(), rng.end(), rng.hashes());
		tr.verifyRange(rng1, true);

		// The number of hashes is incorrect.
		expect(() => factory.newRange(rng.begin(), rng.end(), [...rng.hashes(), new Uint8Array()])).toThrow();
		// The number of hashes does not correspond to the range.
		expect(() => factory.newRange(rng.begin(), rng.end() - 1n, rng.hashes())).toThrow();

		const corrupted = rng.hashes()[0] as Uint8Array;
		corrupted[0] = (corrupted[0] as number) ^ 1; // Corrupt the original hashes.
		const rng2 = factory.newRange(rng.begin(), rng.end(), rng.hashes());
		tr.verifyRange(rng2, false);
	});
});

describe("TestNewRangeWithStorage", () => {
	it("rebuilds a range from stored nodes", () => {
		const numNodes = 777n;
		const [tr] = newTree(numNodes);
		const root = tr.rootHash();

		// Port note: Go keys this map by the compact.NodeID struct value.
		// TypeScript Maps compare object keys by identity, so the key is the
		// node's coordinates rendered as a string.
		const key = (id: NodeID): string => `${id.level}:${id.index}`;
		const nodes = new Map<string, Uint8Array>();
		const getHashes = (ids: NodeID[]): Uint8Array[] => {
			return ids.map((id) => nodes.get(key(id)) as Uint8Array);
		};

		let cr = factory.newEmptyRange(0n);
		for (let i = 0n; i < numNodes; i++) {
			nodes.set(key(newNodeID(0, i)), tr.leaf(i));
			cr.append(tr.leaf(i), (id, hash) => {
				nodes.set(key(id), hash);
			});
			const hashes = getHashes(rangeNodes(0n, i + 1n, []));
			cr = factory.newRange(0n, i + 1n, hashes);
		}

		const got = cr.getRootHash(null);
		expect(bytesEqual(got as Uint8Array, root as Uint8Array)).toBe(true);
	});
});

describe("TestGetRootHash", () => {
	for (let size = 0n; size < 16n; size++) {
		it(`size:${size}`, () => {
			const [tr] = newTree(size);
			const rng = factory.newEmptyRange(0n);
			for (let i = 0n; i < size; i++) {
				rng.append(tr.leaf(i), null);
			}
			const root = rng.getRootHash(null);
			const want = tr.rootHash();
			if (want === null) {
				expect(root).toBeNull();
			} else {
				expect(bytesEqual(root as Uint8Array, want)).toBe(true);
			}
		});
	}

	// Should accept only [0, N) ranges.
	it("rejects ranges that do not start at 0", () => {
		const rng = factory.newEmptyRange(10n);
		expect(() => rng.getRootHash(null)).toThrow();
	});
});

describe("TestGetRootHashGolden", () => {
	interface node {
		level: number;
		index: bigint;
		hash: string;
	}

	const tests: { size: number; wantRoot: string; wantNodes?: node[] }[] = [
		{ size: 0, wantRoot: "", wantNodes: [] }, // TODO(pavelkalinnikov): Use hasher.EmptyRoot().
		{
			size: 10,
			wantRoot: "VjWMPSYNtCuCNlF/RLnQy6HcwSk6CIipfxm+hettA+4=",
			wantNodes: [{ level: 4, index: 0n, hash: "VjWMPSYNtCuCNlF/RLnQy6HcwSk6CIipfxm+hettA+4=" }],
		},
		{ size: 15, wantRoot: "j4SulYmocFuxdeyp12xXCIgK6PekBcxzAIj4zbQzNEI=" },
		{ size: 16, wantRoot: "c+4Uc6BCMOZf/v3NZK1kqTUJe+bBoFtOhP+P3SayKRE=", wantNodes: [] },
		{
			size: 100,
			wantRoot: "dUh9hYH88p0CMoHkdr1wC2szbhcLAXOejWpINIooKUY=",
			wantNodes: [
				{ level: 6, index: 1n, hash: "/K5I3bQ6Wz/beVi9IFKizZ073WqI8kGqstdkbmMcTXI=" },
				{ level: 7, index: 0n, hash: "dUh9hYH88p0CMoHkdr1wC2szbhcLAXOejWpINIooKUY=" },
			],
		},
		{
			size: 255,
			wantRoot: "SmdsuKUqiod3RX2jyF2M6JnbdE4QuTwwipfAowI4/i0=",
			wantNodes: [
				{ level: 2, index: 63n, hash: "EphrHrAU2E+H65CW1o2SwiJVA1dNragVhsMsOkyBdZ4=" },
				{ level: 3, index: 31n, hash: "fwen9eGNKOdGYC7L1GSwMKBlyjIIZBlsKVkmPGtsZEY=" },
				{ level: 4, index: 15n, hash: "Iq5blg5fdl93qbEUzBBEiGMoP7zyzbwf14JuB5YBidM=" },
				{ level: 5, index: 7n, hash: "D6s+gn79wNsgmdvBv0fVIYCougsU+PUSdtLGrWGmyO4=" },
				{ level: 6, index: 3n, hash: "swSuozoE2E7iTV9cnNGcnjbLEeDq+5ep2hRJuI0pTtI=" },
				{ level: 7, index: 1n, hash: "xv1RcZ3JpQusUjlsGQzsV9kWuITo3aLNpEsKymbFhak=" },
				{ level: 8, index: 0n, hash: "SmdsuKUqiod3RX2jyF2M6JnbdE4QuTwwipfAowI4/i0=" },
			],
		},
		{ size: 256, wantRoot: "qFI0t/tZ1MdOYgyPpPzHFiZVw86koScXy9q3FU5casA=", wantNodes: [] },
		{
			size: 1000,
			wantRoot: "RXrgb8xHd55Y48FbfotJwCbV82Kx22LZfEbmBGAvwlQ=",
			wantNodes: [
				{ level: 6, index: 15n, hash: "CBbiN/le+CpZNxEmCVIgfQSl/ZTapYxUOsdKTkiVjtc=" },
				{ level: 7, index: 7n, hash: "npfCeOdllUJZLLRbvEkxlwY7enS6pRlChKVTJjHcevI=" },
				{ level: 8, index: 3n, hash: "5MVDHIWhLErkcLgceSnxZWOTG04QlhIkm3aUEOQLpWw=" },
				{ level: 9, index: 1n, hash: "6EoN2SheMl5oA3qymXw1Ltcp1ku/INU+rBqEe2+jIjI=" },
				{ level: 10, index: 0n, hash: "RXrgb8xHd55Y48FbfotJwCbV82Kx22LZfEbmBGAvwlQ=" },
			],
		},
		{ size: 4095, wantRoot: "cWRFdQhPcjn9WyBXE/r1f04ejxIm5lvg40DEpRBVS0w=" },
		{ size: 4096, wantRoot: "6uU/phfHg1n/GksYT6TO9aN8EauMCCJRl3dIK0HDs2M=", wantNodes: [] },
		{ size: 10000, wantRoot: "VZcav65F9haHVRk3wre2axFoBXRNeUh/1d9d5FQfxIg=" },
		{ size: 65535, wantRoot: "iPuVYJhP6SEE4gUFp8qbafd2rYv9YTCDYqAxCj8HdLM=" },
	];

	for (const tc of tests) {
		it(`size:${tc.size}`, () => {
			const rng = factory.newEmptyRange(0n);
			for (let i = 0; i < tc.size; i++) {
				const data = new Uint8Array([i & 0xff, (i >> 8) & 0xff]);
				const hash = hashLeaf(data);
				rng.append(hash, null);
			}
			const visited: node[] = [];
			const hash = rng.getRootHash((id, h) => {
				visited.push({ level: id.level, index: id.index, hash: toBase64(h) });
			});
			expect(hash === null ? "" : toBase64(hash)).toBe(tc.wantRoot);
			if (tc.wantNodes !== undefined) {
				expect(visited).toEqual(tc.wantNodes);
			}
		}, 60000);
	}
});

describe("TestDecomposeCases", () => {
	const tests: { begin: bigint; end: bigint; wantL: bigint; wantR: bigint }[] = [
		{ begin: 0n, end: 0n, wantL: 0x00n, wantR: 0x00n }, // subtree sizes [],[]
		{ begin: 0n, end: 2n, wantL: 0x00n, wantR: 0x02n }, // subtree sizes [], [2]
		{ begin: 0n, end: 4n, wantL: 0x00n, wantR: 0x04n }, // subtree sizes [], [4]
		{ begin: 1n, end: 3n, wantL: 0x01n, wantR: 0x01n }, // subtree sizes [1], [1]
		{ begin: 3n, end: 7n, wantL: 0x01n, wantR: 0x03n }, // subtree sizes [1], [2, 1]
		{ begin: 3n, end: 17n, wantL: 0x0dn, wantR: 0x01n }, // subtree sizes [1, 4, 8], [1]
		{ begin: 4n, end: 28n, wantL: 0x0cn, wantR: 0x0cn }, // subtree sizes [4, 8], [8, 4]
		{ begin: 8n, end: 24n, wantL: 0x08n, wantR: 0x08n }, // subtree sizes [8], [8]
		{ begin: 8n, end: 28n, wantL: 0x08n, wantR: 0x0cn }, // subtree sizes [8], [8, 4]
		{ begin: 11n, end: 25n, wantL: 0x05n, wantR: 0x09n }, // subtree sizes [1, 4], [8, 1]
		{ begin: 31n, end: 45n, wantL: 0x01n, wantR: 0x0dn }, // subtree sizes [1], [8, 4, 1]
	];

	for (const tc of tests) {
		it(`[${tc.begin},${tc.end})`, () => {
			expect(decompose(tc.begin, tc.end)).toEqual([tc.wantL, tc.wantR]);
		});
	}
});

function verifyDecompose(begin: bigint, end: bigint): void {
	const [left, right] = decompose(begin, end);
	// Smoke test the sum of decomposition masks.
	if (left + right !== end - begin) {
		throw new Error(`${left}+${right} != ${end}-${begin}`);
	}

	let pos = begin;
	for (let lvl = 0; lvl < 64; lvl++) {
		const size = 1n << BigInt(lvl);
		if ((left & size) !== 0n) {
			if (pos % size !== 0n) {
				throw new Error(`left: level ${lvl} not aligned`);
			}
			pos += size;
		}
	}
	// Port note: Go writes this as `for lvl := uint(63); lvl < 64; lvl--`,
	// relying on the unsigned counter overflowing to stop the loop.
	for (let lvl = 63; lvl >= 0; lvl--) {
		const size = 1n << BigInt(lvl);
		if ((right & size) !== 0n) {
			if (pos % size !== 0n) {
				throw new Error(`right: level ${lvl} not aligned`);
			}
			pos += size;
		}
	}
	if (pos !== end) {
		throw new Error(`decomposition covers up to ${pos}, want ${end}`);
	}
}

describe("TestDecompose", () => {
	it("covers every sub-range up to 100", () => {
		const n = 100n;
		for (let i = 0n; i <= n; i++) {
			for (let j = i; j <= n; j++) {
				expect(() => verifyDecompose(i, j), `verifyDecompose(${i},${j})`).not.toThrow();
			}
		}
	});
});

describe("TestDecomposePow2", () => {
	for (let p = 0; p < 64; p++) {
		it(`2^${p}`, () => {
			let end = 1n << BigInt(p);
			expect(() => verifyDecompose(0n, end), `verifyDecompose(0,${end})`).not.toThrow();
			end += end - 1n;
			expect(() => verifyDecompose(0n, end), `verifyDecompose(0,${end})`).not.toThrow();
		});
	}
});

function hashLeaf(data: Uint8Array): Uint8Array {
	return DefaultHasher.hashLeaf(data);
}

function shorten(hash: Uint8Array): Uint8Array {
	if (hash.length < 4) {
		return hash;
	}
	return hash.subarray(0, 4);
}

// deepEqualHashes stands in for `reflect.DeepEqual` over Go's `[][]byte`.
// Port note: Go distinguishes a nil slice from an empty one; TypeScript renders
// both as `[]`, so an empty compact range compares equal to an absent one.
function deepEqualHashes(a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (!bytesEqual(a[i] as Uint8Array, b[i] as Uint8Array)) {
			return false;
		}
	}
	return true;
}
