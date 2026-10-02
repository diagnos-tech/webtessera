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

// Golden-fixture tests for merkle/compact. The vectors in fixtures/data are
// emitted by the real Go implementation; see fixtures/README.md and
// docs/decisions/0006-golden-fixtures-from-go.md.
//
// This is where the uint64 edges get exercised for real: the rangeNodes and
// decompose tables run to math.MaxUint64, and the nodeIds table includes
// (63, 2^63-1), whose coverage end wraps to 0.

import { beforeAll, describe, expect, it } from "vitest";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { bytesToHex, type Fixture, hexToBytes, loadFixture, u64 } from "../../../testonly/fixtures.ts";
import { DefaultHasher } from "../rfc6962/rfc6962.ts";
import { type NodeID, newNodeID, rangeNodes, rangeSize } from "./nodes.ts";
import { decompose, type Range, RangeFactory, type VisitFn } from "./range.ts";

interface VisitedNode {
	readonly level: number;
	readonly index: string;
	readonly hash: string;
}

interface AppendStep {
	readonly size: string;
	readonly leaf: string;
	readonly leafHash: string;
	readonly hashes: readonly string[];
	readonly visited: readonly VisitedNode[];
	readonly root: string;
	readonly rootVisited: readonly VisitedNode[];
}

interface MergeCase {
	readonly desc: string;
	readonly begin: string;
	readonly mid: string;
	readonly end: string;
	readonly leftHashes: readonly string[];
	readonly rightHashes: readonly string[];
	readonly hashes: readonly string[];
	readonly visited: readonly VisitedNode[];
	readonly root: string;
}

interface CompactRangeFixture {
	readonly emptyRangeRootIsNil: boolean;
	readonly appends: readonly AppendStep[];
	readonly largeSizes: readonly AppendStep[];
	readonly merges: readonly MergeCase[];
	readonly rangeNodes: readonly {
		begin: string;
		end: string;
		size: number;
		ids: readonly { level: number; index: string }[];
	}[];
	readonly decompose: readonly { begin: string; end: string; left: string; right: string }[];
	readonly nodeIds: readonly {
		level: number;
		index: string;
		parentLevel: number;
		parentIndex: string;
		siblingLevel: number;
		siblingIndex: string;
		coverageBegin: string;
		coverageEnd: string;
	}[];
	readonly errors: readonly {
		op: string;
		desc: string;
		begin: string;
		end: string;
		hashes: readonly string[];
		wantErr: boolean;
		wantErrMsg: string;
	}[];
}

const factory = new RangeFactory(DefaultHasher.hashChildren.bind(DefaultHasher));

// entryData mirrors the fixture corpus: entry i is the UTF-8 bytes of "entry-<i>".
function entryData(i: bigint): Uint8Array {
	return toUTF8(`entry-${i}`);
}

// recorder collects visitor callbacks in the fixture's own encoding.
function recorder(): [VisitFn, VisitedNode[]] {
	const out: VisitedNode[] = [];
	const visit: VisitFn = (id, hash) => {
		out.push({ level: id.level, index: id.index.toString(), hash: bytesToHex(hash) });
	};
	return [visit, out];
}

function hexes(hashes: readonly Uint8Array[]): string[] {
	return hashes.map(bytesToHex);
}

let f: Fixture<CompactRangeFixture>;

beforeAll(async () => {
	f = await loadFixture<CompactRangeFixture>("compact_range");
});

describe("compact fixtures: append", () => {
	it("reproduces every recorded state up to size 300", () => {
		expect(f.emptyRangeRootIsNil).toBe(true);
		const cr = factory.newEmptyRange(0n);
		for (const step of f.appends) {
			const size = u64(step.size);
			if (size > 0n) {
				// The leaf hash the fixture records must be the hash of the leaf it records.
				expect(bytesToHex(DefaultHasher.hashLeaf(hexToBytes(step.leaf))), step.size).toBe(step.leafHash);
				const [visit, visited] = recorder();
				cr.append(hexToBytes(step.leafHash), visit);
				expect(visited, `append visits at size ${step.size}`).toEqual(step.visited);
			}
			expect(hexes(cr.hashes()), `hashes at size ${step.size}`).toEqual(step.hashes);

			const [rootVisit, rootVisited] = recorder();
			const root = cr.getRootHash(rootVisit);
			expect(root === null ? "" : bytesToHex(root), `root at size ${step.size}`).toBe(step.root);
			expect(rootVisited, `root visits at size ${step.size}`).toEqual(step.rootVisited);
		}
	}, 120000);

	it("reproduces the recorded state at the large sizes", () => {
		for (const step of f.largeSizes) {
			const size = u64(step.size);
			const cr = factory.newEmptyRange(0n);
			for (let i = 0n; i < size - 1n; i++) {
				cr.append(DefaultHasher.hashLeaf(entryData(i)), null);
			}
			const [visit, visited] = recorder();
			cr.append(hexToBytes(step.leafHash), visit);
			expect(visited, `final append visits at size ${step.size}`).toEqual(step.visited);
			expect(hexes(cr.hashes()), `hashes at size ${step.size}`).toEqual(step.hashes);

			const [rootVisit, rootVisited] = recorder();
			const root = cr.getRootHash(rootVisit);
			expect(root === null ? "" : bytesToHex(root), `root at size ${step.size}`).toBe(step.root);
			expect(rootVisited, `root visits at size ${step.size}`).toEqual(step.rootVisited);
		}
	}, 300000);
});

describe("compact fixtures: appendRange", () => {
	it("reproduces every recorded merge", () => {
		expect(f.merges.length).toBeGreaterThan(0);
		for (const tc of f.merges) {
			const begin = u64(tc.begin);
			const mid = u64(tc.mid);
			const end = u64(tc.end);
			const left = factory.newRange(begin, mid, tc.leftHashes.map(hexToBytes));
			const right = factory.newRange(mid, end, tc.rightHashes.map(hexToBytes));

			const [visit, visited] = recorder();
			left.appendRange(right, visit);
			expect(visited, `${tc.desc}: visits`).toEqual(tc.visited);
			expect(hexes(left.hashes()), `${tc.desc}: hashes`).toEqual(tc.hashes);
			expect(left.begin(), `${tc.desc}: begin`).toBe(begin);
			expect(left.end(), `${tc.desc}: end`).toBe(end);

			if (begin === 0n) {
				const root = left.getRootHash(null);
				expect(root === null ? "" : bytesToHex(root), `${tc.desc}: root`).toBe(tc.root);
			} else {
				// The generator records no root for ranges that do not start at 0,
				// because GetRootHash rejects them.
				expect(tc.root, `${tc.desc}: root`).toBe("");
				expect(() => left.getRootHash(null)).toThrow();
			}
		}
	}, 60000);
});

describe("compact fixtures: node addressing", () => {
	it("agrees on rangeNodes and rangeSize, including up to MaxUint64", () => {
		expect(f.rangeNodes.length).toBeGreaterThan(0);
		for (const tc of f.rangeNodes) {
			const begin = u64(tc.begin);
			const end = u64(tc.end);
			const got: NodeID[] = rangeNodes(begin, end, []);
			const want = tc.ids.map((n) => newNodeID(n.level, u64(n.index)));
			expect(got, `rangeNodes(${tc.begin}, ${tc.end})`).toEqual(want);
			expect(rangeSize(begin, end), `rangeSize(${tc.begin}, ${tc.end})`).toBe(tc.size);
		}
	});

	it("agrees on decompose, including up to MaxUint64", () => {
		expect(f.decompose.length).toBeGreaterThan(0);
		for (const tc of f.decompose) {
			expect(decompose(u64(tc.begin), u64(tc.end)), `decompose(${tc.begin}, ${tc.end})`).toEqual([
				u64(tc.left),
				u64(tc.right),
			]);
		}
	});

	it("agrees on NodeID parent, sibling and coverage", () => {
		expect(f.nodeIds.length).toBeGreaterThan(0);
		for (const tc of f.nodeIds) {
			const id = newNodeID(tc.level, u64(tc.index));
			const desc = `node (${tc.level},${tc.index})`;
			expect(id.parent(), `${desc}: parent`).toEqual(newNodeID(tc.parentLevel, u64(tc.parentIndex)));
			expect(id.sibling(), `${desc}: sibling`).toEqual(newNodeID(tc.siblingLevel, u64(tc.siblingIndex)));
			expect(id.coverage(), `${desc}: coverage`).toEqual([u64(tc.coverageBegin), u64(tc.coverageEnd)]);
		}
	});
});

describe("compact fixtures: rejections", () => {
	it("agrees on newRange's error messages", () => {
		const cases = f.errors.filter((e) => e.op === "newRange");
		expect(cases.length).toBeGreaterThan(0);
		for (const tc of cases) {
			const run = (): Range => factory.newRange(u64(tc.begin), u64(tc.end), tc.hashes.map(hexToBytes));
			if (tc.wantErr) {
				expect(run, tc.desc).toThrow(tc.wantErrMsg);
			} else {
				expect(run, tc.desc).not.toThrow();
			}
		}
	});
});
