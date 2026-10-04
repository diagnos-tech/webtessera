// Copyright 2017 Google LLC. All Rights Reserved.
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
// Ported from merkle/proof/verify_test.go @ v0.0.2

import { describe, expect, it } from "vitest";
import { asUint64 } from "../../../internal/gostd/bits.ts";
import { bytesEqual, fromHex, toHex, toUTF8 } from "../../../internal/gostd/bytes.ts";
import type { LogHasher } from "../hasher.ts";
import { DefaultHasher } from "../rfc6962/rfc6962.ts";
import { RootMismatchError, rootFromInclusionProof, verifyConsistency, verifyInclusion } from "./verify.ts";

interface inclusionProofTestVector {
	leaf: bigint;
	size: bigint;
	proof: Uint8Array[];
}

interface consistencyTestVector {
	size1: bigint;
	size2: bigint;
	proof: Uint8Array[];
}

const hasher = DefaultHasher;
const sha256SomeHash = dh("abacaba000000000000000000000000000000000000000000060061e00123456", 32);
const sha256EmptyTreeHash = dh("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 32);

const inclusionProofs: inclusionProofTestVector[] = [
	{ leaf: 0n, size: 0n, proof: [] },
	{ leaf: 1n, size: 1n, proof: [] },
	{
		leaf: 1n,
		size: 8n,
		proof: [
			dh("96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7", 32),
			dh("5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", 32),
			dh("6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4", 32),
		],
	},
	{
		leaf: 6n,
		size: 8n,
		proof: [
			dh("bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b", 32),
			dh("ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0", 32),
			dh("d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7", 32),
		],
	},
	{
		leaf: 3n,
		size: 3n,
		proof: [dh("fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125", 32)],
	},
	{
		leaf: 2n,
		size: 5n,
		proof: [
			dh("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d", 32),
			dh("5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", 32),
			dh("bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b", 32),
		],
	},
];

const consistencyProofs: consistencyTestVector[] = [
	{ size1: 1n, size2: 1n, proof: [] },
	{
		size1: 1n,
		size2: 8n,
		proof: [
			dh("96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7", 32),
			dh("5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", 32),
			dh("6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4", 32),
		],
	},
	{
		size1: 6n,
		size2: 8n,
		proof: [
			dh("0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a", 32),
			dh("ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0", 32),
			dh("d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7", 32),
		],
	},
	{
		size1: 2n,
		size2: 5n,
		proof: [
			dh("5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e", 32),
			dh("bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b", 32),
		],
	},
	{
		size1: 6n,
		size2: 7n,
		proof: [
			dh("0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a", 32),
			dh("b08693ec2e721597130641e8211e7eedccb4c26413963eee6c1e2ed16ffb1a5f", 32),
			dh("d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7", 32),
		],
	},
];

const roots: Uint8Array[] = [
	dh("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d", 32),
	dh("fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125", 32),
	dh("aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77", 32),
	dh("d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7", 32),
	dh("4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4", 32),
	dh("76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef", 32),
	dh("ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c", 32),
	dh("5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328", 32),
];

const leaves: Uint8Array[] = [
	dh("", 0),
	dh("00", 1),
	dh("10", 1),
	dh("2021", 2),
	dh("3031", 2),
	dh("40414243", 4),
	dh("5051525354555657", 8),
	dh("606162636465666768696a6b6c6d6e6f", 16),
];

// inclusionProbe is a parameter set for inclusion proof verification.
interface inclusionProbe {
	leafIndex: bigint;
	treeSize: bigint;
	root: Uint8Array;
	leafHash: Uint8Array;
	proof: Uint8Array[];

	desc: string;
}

// consistencyProbe is a parameter set for consistency proof verification.
interface consistencyProbe {
	size1: bigint;
	size2: bigint;
	root1: Uint8Array;
	root2: Uint8Array;
	proof: Uint8Array[];

	desc: string;
}

function corruptInclusionProof(
	leafIndex: bigint,
	treeSize: bigint,
	proof: Uint8Array[],
	root: Uint8Array,
	leafHash: Uint8Array,
): inclusionProbe[] {
	// Port note: the arithmetic below is uint64 upstream, and `leafIndex - 1`
	// deliberately wraps to MaxUint64 when leafIndex is 0.
	const ret: inclusionProbe[] = [
		// Wrong leaf index.
		{ leafIndex: asUint64(leafIndex - 1n), treeSize, root, leafHash, proof, desc: "leafIndex - 1" },
		{ leafIndex: asUint64(leafIndex + 1n), treeSize, root, leafHash, proof, desc: "leafIndex + 1" },
		{ leafIndex: leafIndex ^ 2n, treeSize, root, leafHash, proof, desc: "leafIndex ^ 2" },
		// Wrong tree height.
		{ leafIndex, treeSize: asUint64(treeSize * 2n), root, leafHash, proof, desc: "treeSize * 2" },
		{ leafIndex, treeSize: treeSize / 2n, root, leafHash, proof, desc: "treeSize / 2" },
		// Wrong leaf or root.
		{ leafIndex, treeSize, root, leafHash: toUTF8("WrongLeaf"), proof, desc: "wrong leaf" },
		{ leafIndex, treeSize, root: sha256EmptyTreeHash, leafHash, proof, desc: "empty root" },
		{ leafIndex, treeSize, root: sha256SomeHash, leafHash, proof, desc: "random root" },
		// Add garbage at the end.
		{ leafIndex, treeSize, root, leafHash, proof: extend(proof, new Uint8Array()), desc: "trailing garbage" },
		{ leafIndex, treeSize, root, leafHash, proof: extend(proof, root), desc: "trailing root" },
		// Add garbage at the front.
		{ leafIndex, treeSize, root, leafHash, proof: prepend(proof, new Uint8Array()), desc: "preceding garbage" },
		{ leafIndex, treeSize, root, leafHash, proof: prepend(proof, root), desc: "preceding root" },
	];
	const ln = proof.length;

	// Modify single bit in an element of the proof.
	for (let i = 0; i < ln; i++) {
		const wrongProof = prepend(proof); // Copy the proof slice.
		const modified = Uint8Array.from(wrongProof[i] as Uint8Array); // But also the modified data.
		modified[0] = (modified[0] as number) ^ 8; // Flip the bit.
		wrongProof[i] = modified;
		const desc = `modified proof[${i}] bit 3`;
		ret.push({ leafIndex, treeSize, root, leafHash, proof: wrongProof, desc });
	}

	if (ln > 0) {
		ret.push({ leafIndex, treeSize, root, leafHash, proof: proof.slice(0, ln - 1), desc: "removed component" });
	}
	if (ln > 1) {
		const wrongProof = prepend(proof.slice(1), proof[0] as Uint8Array, sha256SomeHash);
		ret.push({ leafIndex, treeSize, root, leafHash, proof: wrongProof, desc: "inserted component" });
	}

	return ret;
}

function corruptConsistencyProof(
	size1: bigint,
	size2: bigint,
	root1: Uint8Array,
	root2: Uint8Array,
	proof: Uint8Array[],
): consistencyProbe[] {
	const ln = proof.length;
	const ret: consistencyProbe[] = [
		// Wrong size1.
		{ size1: asUint64(size1 - 1n), size2, root1, root2, proof, desc: "size1 - 1" },
		{ size1: asUint64(size1 + 1n), size2, root1, root2, proof, desc: "size1 + 1" },
		{ size1: size1 ^ 2n, size2, root1, root2, proof, desc: "size1 ^ 2" },
		// Wrong tree height.
		{ size1, size2: asUint64(size2 * 2n), root1, root2, proof, desc: "size2 * 2" },
		{ size1, size2: size2 / 2n, root1, root2, proof, desc: "size2 / 2" },
		// Wrong root.
		{ size1, size2, root1: toUTF8("WrongRoot"), root2, proof, desc: "wrong root1" },
		{ size1, size2, root1, root2: toUTF8("WrongRoot"), proof, desc: "wrong root2" },
		{ size1, size2, root1: root2, root2: root1, proof, desc: "swapped roots" },
		// Empty proof.
		{ size1, size2, root1, root2, proof: [], desc: "empty proof" },
		// Add garbage at the end.
		{ size1, size2, root1, root2, proof: extend(proof, new Uint8Array()), desc: "trailing garbage" },
		{ size1, size2, root1, root2, proof: extend(proof, root1), desc: "trailing root1" },
		{ size1, size2, root1, root2, proof: extend(proof, root2), desc: "trailing root2" },
		// Add garbage at the front.
		{ size1, size2, root1, root2, proof: prepend(proof, new Uint8Array()), desc: "preceding garbage" },
		{ size1, size2, root1, root2, proof: prepend(proof, root1), desc: "preceding root1" },
		{ size1, size2, root1, root2, proof: prepend(proof, root2), desc: "preceding root2" },
		{ size1, size2, root1, root2, proof: prepend(proof, proof[0] as Uint8Array), desc: "preceding proof[0]" },
	];

	// Remove a node from the end.
	if (ln > 0) {
		ret.push({ size1, size2, root1, root2, proof: proof.slice(0, ln - 1), desc: "truncated proof" });
	}

	// Modify single bit in an element of the proof.
	for (let i = 0; i < ln; i++) {
		const wrongProof = prepend(proof); // Copy the proof slice.
		const modified = Uint8Array.from(wrongProof[i] as Uint8Array); // But also the modified data.
		modified[0] = (modified[0] as number) ^ 16; // Flip the bit.
		wrongProof[i] = modified;
		const desc = `modified proof[${i}] bit 4`;
		ret.push({ size1, size2, root1, root2, proof: wrongProof, desc });
	}

	return ret;
}

function verifierCheck(
	h: LogHasher,
	leafIndex: bigint,
	treeSize: bigint,
	proof: Uint8Array[],
	root: Uint8Array,
	leafHash: Uint8Array,
): Error | null {
	// Verify original inclusion proof.
	let got: Uint8Array;
	try {
		got = rootFromInclusionProof(h, leafIndex, treeSize, leafHash, proof);
	} catch (e) {
		return e as Error;
	}
	if (!bytesEqual(got, root)) {
		return new Error(`got root:\n${toHex(got)}\nexpected:\n${toHex(root)}`);
	}
	const err = catchError(() => verifyInclusion(h, leafIndex, treeSize, leafHash, proof, root));
	if (err !== null) {
		return err;
	}

	const probes = corruptInclusionProof(leafIndex, treeSize, proof, root, leafHash);
	const wrong: string[] = [];
	for (const p of probes) {
		if (catchError(() => verifyInclusion(h, p.leafIndex, p.treeSize, p.leafHash, p.proof, p.root)) === null) {
			wrong.push(p.desc);
		}
	}
	if (wrong.length > 0) {
		return new Error(`incorrectly verified against: ${wrong.join(", ")}`);
	}
	return null;
}

function verifierConsistencyCheck(
	h: LogHasher,
	size1: bigint,
	size2: bigint,
	proof: Uint8Array[],
	root1: Uint8Array,
	root2: Uint8Array,
): Error | null {
	// Verify original consistency proof.
	const err = catchError(() => verifyConsistency(h, size1, size2, proof, root1, root2));
	if (err !== null) {
		return err;
	}
	// For simplicity test only non-trivial proofs that have root1 != root2,
	// size1 != 0 and size1 != size2.
	if (proof.length === 0) {
		return null;
	}

	const probes = corruptConsistencyProof(size1, size2, root1, root2, proof);
	const wrong: string[] = [];
	for (const p of probes) {
		if (catchError(() => verifyConsistency(h, p.size1, p.size2, p.proof, p.root1, p.root2)) === null) {
			wrong.push(p.desc);
		}
	}
	if (wrong.length > 0) {
		return new Error(`incorrectly verified against: ${wrong.join(", ")}`);
	}
	return null;
}

describe("TestVerifyInclusionSingleEntry", () => {
	const data = toUTF8("data");
	// Root and leaf hash for 1-entry tree are the same.
	const hash = hasher.hashLeaf(data);
	// The corresponding inclusion proof is empty.
	const proof: Uint8Array[] = [];
	const emptyHash = new Uint8Array();

	const tests: { root: Uint8Array; leaf: Uint8Array; wantErr: boolean }[] = [
		{ root: hash, leaf: hash, wantErr: false },
		{ root: hash, leaf: emptyHash, wantErr: true },
		{ root: emptyHash, leaf: hash, wantErr: true },
		{ root: emptyHash, leaf: emptyHash, wantErr: true }, // Wrong hash size.
	];

	tests.forEach((tc, i) => {
		it(`test:${i}`, () => {
			const err = catchError(() => verifyInclusion(hasher, 0n, 1n, tc.leaf, proof, tc.root));
			expect(err !== null).toBe(tc.wantErr);
		});
	});
});

describe("TestVerifyInclusion", () => {
	const proof: Uint8Array[] = [];

	const probes: { index: bigint; size: bigint }[] = [
		{ index: 0n, size: 0n },
		{ index: 0n, size: 1n },
		{ index: 1n, size: 0n },
		{ index: 2n, size: 1n },
	];
	for (const p of probes) {
		it(`probe:${p.index}:${p.size}`, () => {
			expect(() => verifyInclusion(hasher, p.index, p.size, sha256SomeHash, proof, new Uint8Array())).toThrow();
			expect(() => verifyInclusion(hasher, p.index, p.size, new Uint8Array(), proof, sha256EmptyTreeHash)).toThrow();
			expect(() => verifyInclusion(hasher, p.index, p.size, sha256SomeHash, proof, sha256EmptyTreeHash)).toThrow();
		});
	}

	// i = 0 is an invalid path.
	for (let i = 1; i < 6; i++) {
		it(`proof:${i}`, () => {
			const p = inclusionProofs[i] as inclusionProofTestVector;
			const leafHash = DefaultHasher.hashLeaf(leaves[Number(p.leaf) - 1] as Uint8Array);
			const err = verifierCheck(
				hasher,
				p.leaf - 1n,
				p.size,
				p.proof,
				roots[Number(p.size) - 1] as Uint8Array,
				leafHash,
			);
			expect(err, `verifierCheck(): ${err?.message}`).toBeNull();
		});
	}
});

describe("TestVerifyConsistency", () => {
	// Port note: upstream's "don't care" roots are the 12-byte strings themselves. This
	// port requires every root to be hasher.size() bytes even where the sizes make the
	// proof trivial (docs/decisions/0202-merkle-proof-hash-sizes.md), so they are hashed
	// to 32 bytes here; they are still roots nobody cares about, and every case keeps
	// upstream's verdict. "TestVerifyConsistency rejects mis-sized roots" below pins
	// what happens to the unhashed values.
	const root1 = hasher.hashLeaf(toUTF8("don't care 1"));
	const root2 = hasher.hashLeaf(toUTF8("don't care 2"));
	const proof1: Uint8Array[] = [];
	const proof2: Uint8Array[] = [sha256EmptyTreeHash];

	const tests: {
		size1: bigint;
		size2: bigint;
		root1: Uint8Array;
		root2: Uint8Array;
		proof: Uint8Array[];
		wantErr: boolean;
	}[] = [
		{ size1: 0n, size2: 0n, root1, root2, proof: proof1, wantErr: true },
		{ size1: 1n, size2: 1n, root1, root2, proof: proof1, wantErr: true },
		// Sizes that are always consistent.
		{ size1: 0n, size2: 0n, root1, root2: root1, proof: proof1, wantErr: false },
		{ size1: 0n, size2: 1n, root1, root2, proof: proof1, wantErr: false },
		{ size1: 1n, size2: 1n, root1: root2, root2, proof: proof1, wantErr: false },
		// Time travel to the past.
		{ size1: 1n, size2: 0n, root1, root2, proof: proof1, wantErr: true },
		{ size1: 2n, size2: 1n, root1, root2, proof: proof1, wantErr: true },
		// Empty proof.
		{ size1: 1n, size2: 2n, root1, root2, proof: proof1, wantErr: true },
		// Roots don't match.
		{ size1: 0n, size2: 0n, root1: sha256EmptyTreeHash, root2, proof: proof1, wantErr: true },
		{ size1: 1n, size2: 1n, root1: sha256EmptyTreeHash, root2, proof: proof1, wantErr: true },
		// Roots match but the proof is not empty.
		{
			size1: 0n,
			size2: 0n,
			root1: sha256EmptyTreeHash,
			root2: sha256EmptyTreeHash,
			proof: proof2,
			wantErr: true,
		},
		{
			size1: 0n,
			size2: 1n,
			root1: sha256EmptyTreeHash,
			root2: sha256EmptyTreeHash,
			proof: proof2,
			wantErr: true,
		},
		{
			size1: 1n,
			size2: 1n,
			root1: sha256EmptyTreeHash,
			root2: sha256EmptyTreeHash,
			proof: proof2,
			wantErr: true,
		},
	];

	tests.forEach((p, i) => {
		it(`test:${i}:size:${p.size1}-${p.size2}`, () => {
			const err = verifierConsistencyCheck(hasher, p.size1, p.size2, p.proof, p.root1, p.root2);
			if (p.wantErr) {
				expect(err, "Incorrectly verified").not.toBeNull();
			} else {
				expect(err, `Failed to verify: ${err?.message}`).toBeNull();
			}
		});
	});

	consistencyProofs.forEach((p, i) => {
		it(`proof:${i}`, () => {
			const err = verifierConsistencyCheck(
				hasher,
				p.size1,
				p.size2,
				p.proof,
				roots[Number(p.size1) - 1] as Uint8Array,
				roots[Number(p.size2) - 1] as Uint8Array,
			);
			expect(err, `Failed to verify known good proof: ${err?.message}`).toBeNull();
		});
	});
});

// The tests below have no upstream counterpart. They pin the port's hardening:
// every proof hash and every root must be exactly hasher.size() bytes
// (docs/decisions/0202-merkle-proof-hash-sizes.md), and every size and index must be a
// uint64 (docs/decisions/0207-uint64-domain-guards.md). Correctly sized inputs are
// covered by every upstream test above, unchanged.
describe("hash sizes (port hardening)", () => {
	// A valid inclusion proof for leaf index 1 in a tree of size 5 and a valid 6 -> 8
	// consistency proof, taken from the vectors above.
	const inclusion = inclusionProofs[5] as inclusionProofTestVector;
	const leafHash = hasher.hashLeaf(leaves[Number(inclusion.leaf) - 1] as Uint8Array);
	const root = roots[Number(inclusion.size) - 1] as Uint8Array;
	const consistency = consistencyProofs[2] as consistencyTestVector;
	const croot1 = roots[Number(consistency.size1) - 1] as Uint8Array;
	const croot2 = roots[Number(consistency.size2) - 1] as Uint8Array;
	const longer = (h: Uint8Array): Uint8Array => Uint8Array.from([...h, 0]);
	const shorter = (h: Uint8Array): Uint8Array => h.subarray(0, h.length - 1);

	it("the vectors used here verify as given", () => {
		verifyInclusion(hasher, inclusion.leaf - 1n, inclusion.size, leafHash, inclusion.proof, root);
		verifyConsistency(hasher, consistency.size1, consistency.size2, consistency.proof, croot1, croot2);
	});

	// A mis-sized proof hash changes the root a proof chains to. Against the true root, Go's
	// verdict is a RootMismatchError, and so is the port's. Against the root the mangled proof
	// chains to, which Go accepts, the port's size check rejects it.
	it("a proof hash of the wrong length is rejected by rootFromInclusionProof and verifyInclusion", () => {
		for (let i = 0; i < inclusion.proof.length; i++) {
			for (const mangle of [longer, shorter, () => new Uint8Array(0)]) {
				const proof = inclusion.proof.slice();
				proof[i] = mangle(proof[i] as Uint8Array);
				const want = `proof[${i}] has unexpected size ${(proof[i] as Uint8Array).length}, want 32`;
				expect(
					catchError(() => rootFromInclusionProof(hasher, inclusion.leaf - 1n, inclusion.size, leafHash, proof))
						?.message,
				).toBe(want);
				const mismatch = catchError(() =>
					verifyInclusion(hasher, inclusion.leaf - 1n, inclusion.size, leafHash, proof, root),
				);
				expect(mismatch).toBeInstanceOf(RootMismatchError);
				const chainedRoot = (mismatch as RootMismatchError).calculatedRoot;
				expect(
					catchError(() => verifyInclusion(hasher, inclusion.leaf - 1n, inclusion.size, leafHash, proof, chainedRoot))
						?.message,
				).toBe(want);
			}
		}
	});

	it("an inclusion root of the wrong length is a RootMismatchError, as in Go", () => {
		for (const r of [longer(root), shorter(root), new Uint8Array(0)]) {
			const err = catchError(() =>
				verifyInclusion(hasher, inclusion.leaf - 1n, inclusion.size, leafHash, inclusion.proof, r),
			);
			expect(err).toBeInstanceOf(RootMismatchError);
			expect((err as RootMismatchError).expectedRoot).toBe(r);
			expect((err as RootMismatchError).calculatedRoot).toEqual(root);
		}
	});

	/** chainedRoots returns the roots a consistency proof chains to, read from Go's RootMismatchErrors. */
	const chainedRoots = (proof: Uint8Array[]): [Uint8Array, Uint8Array] => {
		let r1 = croot1;
		let r2 = croot2;
		for (let k = 0; k < 2; k++) {
			const err = catchError(() => verifyConsistency(hasher, consistency.size1, consistency.size2, proof, r1, r2));
			if (!(err instanceof RootMismatchError)) {
				break;
			}
			if (err.expectedRoot === r1) {
				r1 = err.calculatedRoot;
			} else {
				r2 = err.calculatedRoot;
			}
		}
		return [r1, r2];
	};

	it("a consistency proof hash of the wrong length is rejected", () => {
		for (let i = 0; i < consistency.proof.length; i++) {
			for (const mangle of [longer, shorter]) {
				const proof = consistency.proof.slice();
				proof[i] = mangle(proof[i] as Uint8Array);
				expect(
					catchError(() => verifyConsistency(hasher, consistency.size1, consistency.size2, proof, croot1, croot2)),
				).toBeInstanceOf(RootMismatchError);
				const [r1, r2] = chainedRoots(proof);
				expect(
					catchError(() => verifyConsistency(hasher, consistency.size1, consistency.size2, proof, r1, r2))?.message,
				).toBe(`proof[${i}] has unexpected size ${(proof[i] as Uint8Array).length}, want 32`);
			}
		}
	});

	it("consistency roots of the wrong length are rejected wherever Go accepts them", () => {
		const bad = longer(croot1);
		const cases: Array<[bigint, bigint, Uint8Array[], Uint8Array, Uint8Array, string]> = [
			// size1 == size2: equal but mis-sized roots are not a valid tree head.
			[5n, 5n, [], bad, bad, "root1"],
			// size1 == 0: the proof is trivially empty, the roots must still be hashes.
			[0n, 5n, [], bad, root, "root1"],
			[0n, 5n, [], sha256EmptyTreeHash, new Uint8Array(0), "root2"],
		];
		for (const [size1, size2, proof, r1, r2, name] of cases) {
			const got = name === "root1" ? r1 : r2;
			expect(catchError(() => verifyConsistency(hasher, size1, size2, proof, r1, r2))?.message).toBe(
				`${name} has unexpected size ${got.length}, want 32`,
			);
		}
	});

	it("a consistency root of the wrong length that does not match is a RootMismatchError, as in Go", () => {
		const bad = longer(croot1);
		const cases: Array<[bigint, bigint, Uint8Array[], Uint8Array, Uint8Array, Uint8Array]> = [
			[consistency.size1, consistency.size2, consistency.proof, bad, croot2, bad],
			[consistency.size1, consistency.size2, consistency.proof, croot1, bad, bad],
			[5n, 5n, [], root, bad, bad],
		];
		for (const [size1, size2, proof, r1, r2, expected] of cases) {
			const err = catchError(() => verifyConsistency(hasher, size1, size2, proof, r1, r2));
			expect(err).toBeInstanceOf(RootMismatchError);
			expect((err as RootMismatchError).expectedRoot).toBe(expected);
		}
	});

	it("TestVerifyConsistency rejects mis-sized roots", () => {
		// Upstream accepts these: the sizes alone make them consistent.
		const dontCare = toUTF8("don't care 1");
		expect(catchError(() => verifyConsistency(hasher, 0n, 0n, [], dontCare, dontCare))).not.toBeNull();
		expect(catchError(() => verifyConsistency(hasher, 0n, 1n, [], dontCare, dontCare))).not.toBeNull();
		expect(catchError(() => verifyConsistency(hasher, 1n, 1n, [], dontCare, dontCare))).not.toBeNull();
	});

	it("upstream's own errors keep their precedence over the size checks", () => {
		const bad = new Uint8Array(3);
		expect(catchError(() => verifyInclusion(hasher, 5n, 5n, leafHash, [bad], bad))?.message).toBe(
			"index is beyond size: 5 >= 5",
		);
		expect(catchError(() => verifyInclusion(hasher, 0n, 5n, bad, [bad], bad))?.message).toBe(
			"leafHash has unexpected size 3, want 32",
		);
		expect(catchError(() => verifyInclusion(hasher, 0n, 5n, leafHash, [bad], bad))?.message).toBe(
			"wrong proof size 1, want 3",
		);
		expect(catchError(() => verifyConsistency(hasher, 2n, 1n, [bad], bad, bad))?.message).toBe("size2 (2) < size1 (1)");
		expect(catchError(() => verifyConsistency(hasher, 1n, 1n, [bad], bad, bad))?.message).toBe(
			"size1=size2, but proof is not empty",
		);
		expect(catchError(() => verifyConsistency(hasher, 0n, 1n, [bad], bad, bad))?.message).toBe(
			"expected empty proof, but got 1 components",
		);
		expect(catchError(() => verifyConsistency(hasher, 1n, 2n, [], bad, bad))?.message).toBe("empty proof");
		expect(catchError(() => verifyConsistency(hasher, 3n, 7n, [bad], bad, bad))?.message).toBe(
			"wrong proof size 1, want 4",
		);
	});
});

describe("uint64 domain (port hardening)", () => {
	const leaf = hasher.hashLeaf(toUTF8("x"));
	const B64 = 1n << 64n;
	it("rejects negative and over-wide sizes and indices with a RangeError", () => {
		const calls: Array<() => unknown> = [
			() => rootFromInclusionProof(hasher, -1n, 1n, leaf, []),
			() => rootFromInclusionProof(hasher, 0n, B64, leaf, []),
			() => verifyInclusion(hasher, -1n, 1n, leaf, [], leaf),
			() => verifyInclusion(hasher, 0n, B64, leaf, [], leaf),
			() => verifyConsistency(hasher, -1n, 1n, [], leaf, leaf),
			() => verifyConsistency(hasher, 1n, B64, [leaf], leaf, leaf),
			() => verifyConsistency(hasher, B64, B64, [], leaf, leaf),
		];
		for (const call of calls) {
			expect(call).toThrow(RangeError);
		}
		expect(catchError(() => verifyInclusion(hasher, 0n, B64, leaf, [], leaf))?.message).toBe(
			"size = 18446744073709551616 is outside the uint64 range [0, 2^64-1]",
		);
	});

	it("accepts MaxUint64 as Go does", () => {
		const max = B64 - 1n;
		expect(catchError(() => verifyInclusion(hasher, max, max, leaf, [], leaf))?.message).toBe(
			"index is beyond size: 18446744073709551615 >= 18446744073709551615",
		);
		expect(catchError(() => verifyConsistency(hasher, max, max, [], leaf, leaf))).toBeNull();
	});
});

// extend explicitly copies |proof| slice and appends |hashes| to it.
function extend(proof: Uint8Array[], ...hashes: Uint8Array[]): Uint8Array[] {
	return [...proof, ...hashes];
}

// prepend adds |proof| to the tail of |hashes|.
function prepend(proof: Uint8Array[], ...hashes: Uint8Array[]): Uint8Array[] {
	return [...hashes, ...proof];
}

function dh(h: string, expLen: number): Uint8Array {
	const r = fromHex(h);
	if (r.length !== expLen) {
		throw new Error(`decode "${h}": len=${r.length}, want ${expLen}`);
	}
	return r;
}

// catchError runs fn and returns the error it threw, or null. It stands in for
// Go's `err := f()` when porting tests that assert on error values.
function catchError(fn: () => void): Error | null {
	try {
		fn();
	} catch (e) {
		return e as Error;
	}
	return null;
}
