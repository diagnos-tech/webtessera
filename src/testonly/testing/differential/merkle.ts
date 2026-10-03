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

// Differential suites for merkle/{proof,compact,rfc6962} over
// fixtures/data/differential_{proof_inclusion,proof_consistency,proof_nodes,compact,rfc6962}.json
// (fixtures/gen/differential_merkle.go).

import { describe, it } from "vitest";
import { appendUint64BE } from "../../../internal/gostd/bytes.ts";
import { type NodeID, newNodeID, rangeNodes, rangeSize } from "../../../vendor/merkle/compact/nodes.ts";
import { decompose, type Range, RangeFactory } from "../../../vendor/merkle/compact/range.ts";
import { consistency, inclusion, type Nodes } from "../../../vendor/merkle/proof/proof.ts";
import {
	RootMismatchError,
	rootFromInclusionProof,
	verifyConsistency,
	verifyInclusion,
} from "../../../vendor/merkle/proof/verify.ts";
import { DefaultHasher } from "../../../vendor/merkle/rfc6962/rfc6962.ts";
import { bytesToHex, hexToBytes, loadFixture, u64 } from "../../fixtures.ts";
import { attempt, DifferentialReport, messageOf, type Outcome } from "../differential.ts";

/** A hash reference: a hashPool index, a negative oddPool index, or a hex hash. */
type Ref = number | string;

/** A verification result: "" ok, ["m", calculatedRootHex] RootMismatchError, else the error text. */
type VerifyResult = string | readonly ["m", string];

interface PoolCorpus {
	readonly hashPool: readonly string[];
	readonly oddPool: readonly string[];
	readonly mismatchText: readonly (readonly [row: number, text: string])[];
}

interface InclusionCorpus extends PoolCorpus {
	readonly cases: readonly (readonly [
		index: string,
		size: string,
		leaf: Ref,
		proof: readonly Ref[],
		root: Ref,
		result: VerifyResult,
	])[];
}

interface ConsistencyCorpus extends PoolCorpus {
	readonly cases: readonly (readonly [
		size1: string,
		size2: string,
		proof: readonly Ref[],
		root1: Ref,
		root2: Ref,
		result: VerifyResult,
	])[];
}

type NodesRow =
	| readonly [a: string, b: string, err: string]
	| readonly [
			a: string,
			b: string,
			err: "",
			ids: string,
			begin: number,
			end: number,
			ephem: string,
			rehash?: readonly Ref[],
	  ];

interface NodesCorpus {
	readonly hashPool: readonly string[];
	readonly inclusion: readonly NodesRow[];
	readonly consistency: readonly NodesRow[];
	readonly rehashLen: readonly (readonly [index: string, size: string, k: number, err: string])[];
}

type Step = readonly [
	leaf: string,
	visitor: number,
	err: string,
	panic: string,
	begin: string,
	end: string,
	hashes: string,
	visits: string,
];

interface CompactCorpus {
	readonly decompose: readonly (readonly [begin: string, end: string, left: string, right: string])[];
	readonly rangeNodes: readonly (readonly [begin: string, end: string, size: number, ids: string])[];
	readonly nodeID: readonly (readonly [
		level: number,
		index: string,
		pl: number,
		pi: string,
		sl: number,
		si: string,
		cb: string,
		ce: string,
	])[];
	readonly sequential: readonly (readonly [
		begin: string,
		steps: readonly Step[],
		rootErr: string,
		root: string,
		rootNil: number,
		rootVisits: string,
	])[];
	readonly merges: readonly (readonly [
		begin: string,
		end: string,
		mids: readonly string[],
		hashes: string,
		visits: string,
	])[];
	readonly mergeErrs: readonly (readonly [
		lb: string,
		le: string,
		rb: string,
		re: string,
		drop: number,
		err: string,
		panic: string,
		begin: string,
		end: string,
		hashes: string,
		visits: string,
	])[];
	readonly newRange: readonly (readonly [begin: string, end: string, n: number, err: string])[];
}

interface RFC6962Corpus {
	readonly emptyRoot: string;
	readonly leaf: readonly (readonly [input: string, hash: string])[];
	readonly children: readonly (readonly [left: string, right: string, hash: string])[];
}

class Pool {
	readonly pool: Uint8Array[];
	readonly odd: Uint8Array[];

	constructor(c: { readonly hashPool: readonly string[]; readonly oddPool?: readonly string[] }) {
		this.pool = c.hashPool.map(hexToBytes);
		this.odd = (c.oddPool ?? []).map(hexToBytes);
	}

	get(ref: Ref): Uint8Array {
		if (typeof ref === "string") {
			return hexToBytes(ref);
		}
		return (ref >= 0 ? this.pool[ref] : this.odd[-1 - ref]) as Uint8Array;
	}

	/** ref renders a hash the way the corpus does: its pool index when it is one, else hex. */
	ref(h: Uint8Array): Ref {
		const x = bytesToHex(h);
		const i = this.pool.findIndex((p) => bytesToHex(p) === x);
		return i >= 0 ? i : x;
	}
}

const hashChildren = DefaultHasher.hashChildren.bind(DefaultHasher);

/** upstreamCheckFirst lists the errors upstream raises before the port's hash-size checks. */
const sizeErrorPattern = /^(proof\[(\d+)\]|root|root1|root2) has unexpected size (\d+), want 32$/;

/**
 * checkVerify compares one verification outcome with Go's. named resolves the hash a
 * "has unexpected size" error names, for the "merkle-hash-size" divergence: it applies
 * when some proof hash or root is not 32 bytes and Go got past all of its own checks.
 */
function checkVerify(
	rep: DifferentialReport,
	rid: string,
	go: VerifyResult,
	got: Outcome<unknown>,
	outOfDomain: boolean,
	named: (name: string, index: number) => Uint8Array | undefined,
	text: string | undefined,
): void {
	if (outOfDomain && !(typeof go === "string" && go !== "")) {
		// Go accepted, or computed a root, from a hash of the wrong size.
		const m = got.ok ? null : sizeErrorPattern.exec(messageOf(got.error));
		const h = m ? named(m[1]?.startsWith("proof") ? "proof" : (m[1] as string), Number(m[2] ?? -1)) : undefined;
		if (m && h !== undefined && h.length === Number(m[3]) && h.length !== 32) {
			rep.diverge("merkle-hash-size");
		} else {
			rep.fail(
				rid,
				`wrong-size hash: expected a "has unexpected size" error, got ${got.ok ? "success" : messageOf(got.error)} (go: ${JSON.stringify(go)})`,
			);
		}
		return;
	}
	if (go === "") {
		if (!got.ok) {
			rep.fail(rid, `go verified, ts threw ${messageOf(got.error)}`);
		}
		return;
	}
	if (typeof go === "string") {
		if (got.ok) {
			rep.fail(rid, `go rejected (${go}), ts verified`);
		} else {
			rep.equal(rid, "err", go, messageOf(got.error));
			if (got.error instanceof RootMismatchError) {
				rep.fail(rid, "ts threw RootMismatchError where go returned a plain error");
			}
		}
		return;
	}
	if (got.ok || !(got.error instanceof RootMismatchError)) {
		rep.fail(rid, `go RootMismatchError(calc=${go[1]}), ts ${got.ok ? "verified" : messageOf(got.error)}`);
		return;
	}
	rep.equal(rid, "calculatedRoot", go[1], got.error.calculatedRoot);
	if (text !== undefined) {
		rep.equal(rid, "RootMismatchError text", text, got.error.message);
	}
}

function idsString(ids: readonly NodeID[]): string {
	return ids.map((id) => `${id.level}:${id.index}`).join(" ");
}

function h16(b: Uint8Array): string {
	return bytesToHex(b.subarray(0, 8));
}

function leafHash(i: bigint): Uint8Array {
	return DefaultHasher.hashLeaf(appendUint64BE(new Uint8Array(0), i));
}

function rangeHashes(r: Range): string {
	return r
		.hashes()
		.map((h) => h16(h))
		.join(" ");
}

/** describeMerkleDifferential registers the merkle differential tests. */
export function describeMerkleDifferential(): void {
	describe("merkle differential (differential_proof_*.json, differential_compact.json, differential_rfc6962.json)", () => {
		it("verifyInclusion and rootFromInclusionProof reach Go's verdict, error text and calculated root", async () => {
			const f = await loadFixture<InclusionCorpus>("differential_proof_inclusion");
			const pool = new Pool(f);
			const texts = new Map(f.mismatchText.map(([row, text]) => [row, text]));
			const rep = new DifferentialReport("verifyInclusion");
			f.cases.forEach(([index, size, leaf, proofRefs, rootRef, result], row) => {
				rep.record();
				const proof = proofRefs.map((r) => pool.get(r));
				const root = pool.get(rootRef);
				const leafHash = pool.get(leaf);
				const outOfDomain = proof.some((h) => h.length !== 32) || root.length !== 32;
				const rid = `#${row} index=${index} size=${size} leaf=${leaf} proof=${JSON.stringify(proofRefs)} root=${rootRef}`;
				const i = u64(index);
				const s = u64(size);
				const named = (name: string, k: number) => (name === "proof" ? proof[k] : name === "root" ? root : undefined);
				checkVerify(
					rep,
					rid,
					result,
					attempt(() => verifyInclusion(DefaultHasher, i, s, leafHash, proof, root)),
					outOfDomain,
					named,
					texts.get(row),
				);
				if (!outOfDomain) {
					const rf = attempt(() => rootFromInclusionProof(DefaultHasher, i, s, leafHash, proof));
					const want =
						result === "" ? `ok:${bytesToHex(root)}` : typeof result === "string" ? `err:${result}` : `ok:${result[1]}`;
					rep.equal(
						rid,
						"rootFromInclusionProof",
						want,
						rf.ok ? `ok:${bytesToHex(rf.value)}` : `err:${messageOf(rf.error)}`,
					);
				}
			});
			rep.assertClean(4000, ["merkle-hash-size"], ["merkle-hash-size"]);
		});

		it("verifyConsistency reaches Go's verdict, error text and calculated roots", async () => {
			const f = await loadFixture<ConsistencyCorpus>("differential_proof_consistency");
			const pool = new Pool(f);
			const texts = new Map(f.mismatchText.map(([row, text]) => [row, text]));
			const rep = new DifferentialReport("verifyConsistency");
			f.cases.forEach(([size1, size2, proofRefs, r1, r2, result], row) => {
				rep.record();
				const proof = proofRefs.map((r) => pool.get(r));
				const root1 = pool.get(r1);
				const root2 = pool.get(r2);
				const outOfDomain = proof.some((h) => h.length !== 32) || root1.length !== 32 || root2.length !== 32;
				const rid = `#${row} size1=${size1} size2=${size2} proof=${JSON.stringify(proofRefs)} root1=${r1} root2=${r2}`;
				const named = (name: string, k: number) =>
					name === "proof" ? proof[k] : name === "root1" ? root1 : name === "root2" ? root2 : undefined;
				const got = attempt(() => verifyConsistency(DefaultHasher, u64(size1), u64(size2), proof, root1, root2));
				checkVerify(rep, rid, result, got, outOfDomain, named, texts.get(row));
				if (!outOfDomain && !got.ok && got.error instanceof RootMismatchError) {
					const e = got.error.expectedRoot;
					if (bytesToHex(e) !== bytesToHex(root1) && bytesToHex(e) !== bytesToHex(root2)) {
						rep.fail(rid, "RootMismatchError.expectedRoot is neither root1 nor root2");
					}
				}
			});
			rep.assertClean(4000, ["merkle-hash-size"], ["merkle-hash-size"]);
		});

		it("inclusion and consistency produce Go's node IDs, ephemeral node and rehash output", async () => {
			const f = await loadFixture<NodesCorpus>("differential_proof_nodes");
			const pool = new Pool(f);
			const rep = new DifferentialReport("proof.Nodes");
			const check = (kind: string, row: NodesRow, got: Outcome<Nodes>): void => {
				rep.record();
				const rid = `${kind}(${row[0]}, ${row[1]})`;
				if (row[2] !== "") {
					rep.equal(rid, "err", row[2], got.ok ? "ok" : messageOf(got.error));
					return;
				}
				if (!got.ok) {
					rep.fail(rid, `go ok, ts threw ${messageOf(got.error)}`);
					return;
				}
				const [, , , ids, begin, end, ephem, rehash] = row as Extract<NodesRow, { length: 7 | 8 }>;
				const n = got.value;
				const [e, b, en] = n.ephem();
				rep.equal(rid, "ids", ids, idsString(n.ids));
				rep.equal(rid, "ephem", [begin, end, ephem], [b, en, `${e.level}:${e.index}`]);
				if (rehash !== undefined) {
					const input = n.ids.map((_, i) => pool.pool[i % pool.pool.length] as Uint8Array);
					const out = attempt(() => n.rehash(input, hashChildren));
					rep.equal(
						rid,
						"rehash",
						rehash,
						out.ok ? out.value.map((h) => pool.ref(h)) : `throws ${messageOf(out.error)}`,
					);
				}
			};
			for (const row of f.inclusion) {
				check(
					"inclusion",
					row,
					attempt(() => inclusion(u64(row[0]), u64(row[1]))),
				);
			}
			for (const row of f.consistency) {
				check(
					"consistency",
					row,
					attempt(() => consistency(u64(row[0]), u64(row[1]))),
				);
			}
			for (const [index, size, k, err] of f.rehashLen) {
				rep.record();
				const n = inclusion(u64(index), u64(size));
				const got = attempt(() => n.rehash(pool.pool.slice(0, k), hashChildren));
				rep.equal(
					`rehash inclusion(${index}, ${size}) with ${k} hashes`,
					"err",
					err,
					got.ok ? "" : messageOf(got.error),
				);
			}
			rep.assertClean(2900);
		});

		it("decompose, rangeNodes, rangeSize and NodeID match Go up to 2^64-1", async () => {
			const f = await loadFixture<CompactCorpus>("differential_compact");
			const rep = new DifferentialReport("compact nodes");
			for (const [b, e, l, r] of f.decompose) {
				rep.record();
				const got = attempt(() => decompose(u64(b), u64(e)));
				rep.equal(`decompose(${b}, ${e})`, "left,right", [l, r], got.ok ? got.value : messageOf(got.error));
			}
			for (const [b, e, size, ids] of f.rangeNodes) {
				rep.record();
				rep.equal(
					`rangeNodes(${b}, ${e})`,
					"nodes",
					[size, ids],
					[rangeSize(u64(b), u64(e)), idsString(rangeNodes(u64(b), u64(e), []))],
				);
			}
			for (const [level, index, pl, pi, sl, si, cb, ce] of f.nodeID) {
				rep.record();
				const id = newNodeID(level, u64(index));
				const p = id.parent();
				const s = id.sibling();
				rep.equal(
					`NodeID(${level}, ${index})`,
					"parent,sibling,coverage",
					[pl, pi, sl, si, cb, ce],
					[p.level, p.index, s.level, s.index, ...id.coverage()],
				);
			}
			rep.assertClean(5000);
		});

		it("Range traces: sequential appends past 2^64-1, merges, merge errors and newRange match Go", async () => {
			const f = await loadFixture<CompactCorpus>("differential_compact");
			const factory = new RangeFactory(hashChildren);
			const rep = new DifferentialReport("compact.Range");
			for (const [begin, steps, rootErr, root, rootNil, rootVisits] of f.sequential) {
				const r = factory.newEmptyRange(u64(begin));
				for (const [leaf, useVisitor, err, panic, sb, se, hashes, visits] of steps) {
					rep.record();
					const rid = `seq begin=${begin} append@${leaf}`;
					const vis: string[] = [];
					const got = attempt(() =>
						r.append(
							leafHash(u64(leaf)),
							useVisitor === 1 ? (id, h) => vis.push(`${id.level}:${id.index}:${h16(h)}`) : null,
						),
					);
					rep.equal(rid, "err", err || panic, got.ok ? "" : messageOf(got.error));
					rep.equal(rid, "state", [sb, se, hashes, visits], [r.begin(), r.end(), rangeHashes(r), vis.join(" ")]);
				}
				rep.record();
				const vis: string[] = [];
				const got = attempt(() => r.getRootHash((id, h) => vis.push(`${id.level}:${id.index}:${h16(h)}`)));
				const rid = `seq begin=${begin} getRootHash`;
				if (rootErr !== "") {
					rep.equal(rid, "err", rootErr, got.ok ? "ok" : messageOf(got.error));
				} else if (!got.ok) {
					rep.fail(rid, `go ok, ts threw ${messageOf(got.error)}`);
				} else {
					rep.equal(rid, "root", rootNil === 1 ? null : root, got.value === null ? null : bytesToHex(got.value));
					rep.equal(rid, "visits", rootVisits, vis.join(" "));
				}
			}
			for (const [begin, end, mids, hashes, visits] of f.merges) {
				rep.record();
				const queue = [...mids];
				const vis: string[] = [];
				const vf = (id: NodeID, h: Uint8Array) => vis.push(`${id.level}:${id.index}:${h16(h)}`);
				const build = (lo: bigint, hi: bigint): Range => {
					const r = factory.newEmptyRange(lo);
					if (hi === lo) {
						return r;
					}
					if (hi === lo + 1n) {
						r.append(leafHash(lo), vf);
						return r;
					}
					const mid = u64(queue.shift() as string);
					const left = build(lo, mid);
					const right = build(mid, hi);
					r.appendRange(left, vf);
					r.appendRange(right, vf);
					return r;
				};
				const got = attempt(() => build(u64(begin), u64(end)));
				const rid = `merge [${begin}, ${end}) mids=${mids.join(",")}`;
				if (!got.ok) {
					rep.fail(rid, `ts threw ${messageOf(got.error)}`);
					continue;
				}
				rep.equal(rid, "hashes", hashes, got.value.hashes().map(bytesToHex).join(" "));
				rep.equal(rid, "visits", visits, vis.join(" "));
			}
			for (const [lb, le, rb, re, drop, err, panic, begin, end, hashes, visits] of f.mergeErrs) {
				rep.record();
				const left = factory.newEmptyRange(u64(lb));
				for (let k = u64(lb); k < u64(le); k++) {
					left.append(leafHash(k), null);
				}
				const full = factory.newEmptyRange(u64(rb));
				for (let k = u64(rb); k < u64(re); k++) {
					full.append(leafHash(k), null);
				}
				const right =
					drop === 0 ? full : factory.newRange(u64(rb), u64(re), full.hashes().slice(0, full.hashes().length - drop));
				const vis: string[] = [];
				const got = attempt(() => left.appendRange(right, (id, h) => vis.push(`${id.level}:${id.index}:${h16(h)}`)));
				const rid = `appendRange [${lb}, ${le}) + [${rb}, ${re}) drop=${drop}`;
				rep.equal(rid, "err", err || panic, got.ok ? "" : messageOf(got.error));
				rep.equal(
					rid,
					"state",
					[begin, end, hashes, visits],
					[left.begin(), left.end(), rangeHashes(left), vis.join(" ")],
				);
			}
			for (const [b, e, n, err] of f.newRange) {
				rep.record();
				const hs = Array.from({ length: n }, (_, k) => leafHash(BigInt(k)));
				const got = attempt(() => factory.newRange(u64(b), u64(e), hs));
				rep.equal(`newRange(${b}, ${e}, ${n} hashes)`, "err", err, got.ok ? "" : messageOf(got.error));
			}
			rep.assertClean(1500);
		});

		it("rfc6962 HashLeaf, HashChildren and EmptyRoot match Go", async () => {
			const f = await loadFixture<RFC6962Corpus>("differential_rfc6962");
			const rep = new DifferentialReport("rfc6962");
			rep.record();
			rep.equal("EmptyRoot", "hash", f.emptyRoot, DefaultHasher.emptyRoot());
			for (const [input, hash] of f.leaf) {
				rep.record();
				rep.equal(`HashLeaf(${input.length / 2} bytes)`, "hash", hash, DefaultHasher.hashLeaf(hexToBytes(input)));
			}
			for (const [l, r, hash] of f.children) {
				rep.record();
				rep.equal(`HashChildren(${l}, ${r})`, "hash", hash, DefaultHasher.hashChildren(hexToBytes(l), hexToBytes(r)));
			}
			rep.assertClean(400);
		});
	});
}
