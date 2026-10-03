// Copyright 2017 Google LLC. All Rights Reserved.
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
//
// Ported from merkle/proof/verify.go @ v0.0.2

import {
	assertUint64,
	len64,
	onesCount64,
	shiftLeft64,
	shiftRight64,
	trailingZeros64,
} from "../../../internal/gostd/bits.ts";
import { bytesEqual } from "../../../internal/gostd/bytes.ts";
import type { LogHasher } from "../hasher.ts";

/**
 * RootMismatchError occurs when an inclusion proof fails.
 *
 * Port note: Go's RootMismatchError is a struct value with an Error method, returned
 * as `error` and recovered with `errors.As(err, &RootMismatchError{})`. Here it is an
 * Error subclass carrying the same two fields (camelCased), recovered with
 * `instanceof` or `errorAs`. The message is Go's `%v` rendering; see formatBytes.
 */
export class RootMismatchError extends Error {
	readonly expectedRoot: Uint8Array;
	readonly calculatedRoot: Uint8Array;

	constructor(expectedRoot: Uint8Array, calculatedRoot: Uint8Array) {
		super(
			`calculated root:\n${formatBytes(calculatedRoot)}\n does not match expected root:\n${formatBytes(expectedRoot)}`,
		);
		this.name = "RootMismatchError";
		this.expectedRoot = expectedRoot;
		this.calculatedRoot = calculatedRoot;
	}
}

function verifyMatch(calculated: Uint8Array, expected: Uint8Array): void {
	if (!bytesEqual(calculated, expected)) {
		throw new RootMismatchError(expected, calculated);
	}
}

/**
 * checkHashSize throws unless h is exactly hasher.size() bytes long. name is how the
 * error message refers to h.
 *
 * Port note: this check has no upstream counterpart. Go's verifier accepts proof
 * hashes and roots of any length, and the hash chaining treats a node hash as opaque
 * bytes, so a mis-sized "hash" is not rejected for being mis-sized. The port requires
 * every proof hash and every root to be a node hash of the hasher's size. Each call
 * sits after all of upstream's own checks in its function, so every input upstream
 * rejects for another reason is rejected with upstream's error, and every input whose
 * hashes are all correctly sized behaves exactly as upstream.
 * See docs/decisions/0202-merkle-proof-hash-sizes.md.
 */
function checkHashSize(hasher: LogHasher, name: string, h: Uint8Array): void {
	const got = h.length;
	const want = hasher.size();
	if (got !== want) {
		throw new Error(`${name} has unexpected size ${got}, want ${want}`);
	}
}

/** checkProofHashSizes applies checkHashSize to every element of proof, reporting proof[i]. */
function checkProofHashSizes(hasher: LogHasher, proof: readonly Uint8Array[]): void {
	for (let i = 0; i < proof.length; i++) {
		checkHashSize(hasher, `proof[${i}]`, proof[i] as Uint8Array);
	}
}

/**
 * verifyInclusion verifies the correctness of the inclusion proof for the leaf
 * with the specified hash and index, relatively to the tree of the given size
 * and root hash. Requires 0 <= index < size.
 *
 * Port note: index and size must be uint64s (docs/decisions/0207-uint64-domain-guards.md),
 * and root and every proof hash must be hasher.size() bytes
 * (docs/decisions/0202-merkle-proof-hash-sizes.md).
 */
export function verifyInclusion(
	hasher: LogHasher,
	index: bigint,
	size: bigint,
	leafHash: Uint8Array,
	proof: readonly Uint8Array[],
	root: Uint8Array,
): void {
	const calcRoot = rootFromInclusionProof(hasher, index, size, leafHash, proof);
	checkHashSize(hasher, "root", root);
	verifyMatch(calcRoot, root);
}

/**
 * rootFromInclusionProof calculates the expected root hash for a tree of the
 * given size, provided a leaf index and hash with the corresponding inclusion
 * proof. Requires 0 <= index < size.
 *
 * Port note: index and size must be uint64s, and every proof hash must be
 * hasher.size() bytes; see verifyInclusion.
 */
export function rootFromInclusionProof(
	hasher: LogHasher,
	index: bigint,
	size: bigint,
	leafHash: Uint8Array,
	proof: readonly Uint8Array[],
): Uint8Array {
	assertUint64(index, "index");
	assertUint64(size, "size");
	if (index >= size) {
		throw new Error(`index is beyond size: ${index} >= ${size}`);
	}
	if (leafHash.length !== hasher.size()) {
		throw new Error(`leafHash has unexpected size ${leafHash.length}, want ${hasher.size()}`);
	}

	const [inner, border] = decompInclProof(index, size);
	if (proof.length !== inner + border) {
		throw new Error(`wrong proof size ${proof.length}, want ${inner + border}`);
	}
	checkProofHashSizes(hasher, proof);

	let res = chainInner(hasher, leafHash, proof.slice(0, inner), index);
	res = chainBorderRight(hasher, res, proof.slice(inner));
	return res;
}

/**
 * verifyConsistency checks that the passed-in consistency proof is valid
 * between the passed in tree sizes, with respect to the corresponding root
 * hashes. Requires 0 <= size1 <= size2.
 *
 * Port note: size1 and size2 must be uint64s (docs/decisions/0207-uint64-domain-guards.md),
 * and root1, root2 and every proof hash must be hasher.size() bytes, whatever the
 * sizes (docs/decisions/0202-merkle-proof-hash-sizes.md).
 */
export function verifyConsistency(
	hasher: LogHasher,
	size1: bigint,
	size2: bigint,
	proof: readonly Uint8Array[],
	root1: Uint8Array,
	root2: Uint8Array,
): void {
	assertUint64(size1, "size1");
	assertUint64(size2, "size2");
	if (size2 < size1) {
		// Port note: the arguments are swapped relative to the format string in
		// the Go source; kept verbatim so the message text matches upstream.
		throw new Error(`size2 (${size1}) < size1 (${size2})`);
	}
	if (size1 === size2) {
		if (proof.length > 0) {
			throw new Error("size1=size2, but proof is not empty");
		}
		checkHashSize(hasher, "root1", root1);
		checkHashSize(hasher, "root2", root2);
		verifyMatch(root1, root2);
		return;
	}
	if (size1 === 0n) {
		// Any size greater than 0 is consistent with size 0.
		if (proof.length > 0) {
			throw new Error(`expected empty proof, but got ${proof.length} components`);
		}
		checkHashSize(hasher, "root1", root1);
		checkHashSize(hasher, "root2", root2);
		return; // Proof OK.
	}
	if (proof.length === 0) {
		throw new Error("empty proof");
	}

	let [inner, border] = decompInclProof(size1 - 1n, size2);
	const shift = trailingZeros64(size1);
	inner -= shift; // Note: shift < inner if size1 < size2.

	// The proof includes the root hash for the sub-tree of size 2^shift.
	let seed = proof[0] as Uint8Array;
	let start = 1;
	if (size1 === shiftLeft64(1n, shift)) {
		// Unless size1 is that very 2^shift.
		seed = root1;
		start = 0;
	}
	if (proof.length !== start + inner + border) {
		throw new Error(`wrong proof size ${proof.length}, want ${start + inner + border}`);
	}
	checkHashSize(hasher, "root1", root1);
	checkHashSize(hasher, "root2", root2);
	checkProofHashSizes(hasher, proof);
	proof = proof.slice(start);
	// Now proof.length == inner+border, and proof is effectively a suffix of
	// inclusion proof for entry |size1-1| in a tree of size |size2|.

	// Verify the first root.
	const mask = shiftRight64(size1 - 1n, shift); // Start chaining from level |shift|.
	let hash1 = chainInnerRight(hasher, seed, proof.slice(0, inner), mask);
	hash1 = chainBorderRight(hasher, hash1, proof.slice(inner));
	verifyMatch(hash1, root1);

	// Verify the second root.
	let hash2 = chainInner(hasher, seed, proof.slice(0, inner), mask);
	hash2 = chainBorderRight(hasher, hash2, proof.slice(inner));
	verifyMatch(hash2, root2);
}

/**
 * decompInclProof breaks down inclusion proof for a leaf at the specified
 * |index| in a tree of the specified |size| into 2 components. The splitting
 * point between them is where paths to leaves |index| and |size-1| diverge.
 * Returns lengths of the bottom and upper proof parts correspondingly. The sum
 * of the two determines the correct length of the inclusion proof.
 */
function decompInclProof(index: bigint, size: bigint): [number, number] {
	const inner = innerProofSize(index, size);
	const border = onesCount64(shiftRight64(index, inner));
	return [inner, border];
}

function innerProofSize(index: bigint, size: bigint): number {
	return len64(index ^ (size - 1n));
}

/**
 * chainInner computes a subtree hash for a node on or below the tree's right
 * border. Assumes |proof| hashes are ordered from lower levels to upper, and
 * |seed| is the initial subtree/leaf hash on the path located at the specified
 * |index| on its level.
 */
function chainInner(hasher: LogHasher, seed: Uint8Array, proof: readonly Uint8Array[], index: bigint): Uint8Array {
	for (let i = 0; i < proof.length; i++) {
		const h = proof[i] as Uint8Array;
		if ((shiftRight64(index, i) & 1n) === 0n) {
			seed = hasher.hashChildren(seed, h);
		} else {
			seed = hasher.hashChildren(h, seed);
		}
	}
	return seed;
}

/**
 * chainInnerRight computes a subtree hash like chainInner, but only takes
 * hashes to the left from the path into consideration, which effectively means
 * the result is a hash of the corresponding earlier version of this subtree.
 */
function chainInnerRight(hasher: LogHasher, seed: Uint8Array, proof: readonly Uint8Array[], index: bigint): Uint8Array {
	for (let i = 0; i < proof.length; i++) {
		const h = proof[i] as Uint8Array;
		if ((shiftRight64(index, i) & 1n) === 1n) {
			seed = hasher.hashChildren(h, seed);
		}
	}
	return seed;
}

/**
 * chainBorderRight chains proof hashes along tree borders. This differs from
 * inner chaining because |proof| contains only left-side subtree hashes.
 */
function chainBorderRight(hasher: LogHasher, seed: Uint8Array, proof: readonly Uint8Array[]): Uint8Array {
	for (const h of proof) {
		seed = hasher.hashChildren(h, seed);
	}
	return seed;
}

/**
 * formatBytes renders a byte slice the way Go's `%v` verb does, e.g. `[1 2 3]`.
 * RootMismatchError's message is built with `%v`, and upstream tests assert on
 * message content.
 *
 * Port note: upstream has no such helper; `fmt.Sprintf("%v", b)` on a `[]byte` is
 * the decimal bytes, space-separated, in brackets, and this reproduces exactly that
 * (a nil slice and an empty one both print as `[]`).
 */
function formatBytes(b: Uint8Array): string {
	return `[${Array.from(b).join(" ")}]`;
}
