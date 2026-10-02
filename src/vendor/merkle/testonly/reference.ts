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
// Ported from merkle/testonly/reference_test.go @ v0.0.2 (implementation half)
//
// Port note: upstream keeps these helpers in reference_test.go and shares them
// with tree_test.go through the Go package. Importing one *_test.ts from
// another registers its suites twice, so the helpers live here and the tests
// that exercise them stay in reference_test.ts.
// See docs/decisions/0010-package-private-members.md.

import { len64 } from "../../../internal/gostd/bits.ts";
import type { LogHasher } from "../hasher.ts";

// The reference Merkle tree hashing and proof algorithms in this file directly
// implement the definitions from RFC 6962 [1]. We use this implementation only
// for testing correctness of other more flexible and performant algorithms,
// such as the in-memory Tree type and compact ranges.
//
// [1] https://datatracker.ietf.org/doc/html/rfc6962#section-2

/**
 * refRootHash returns the root hash of a Merkle tree with the given entries.
 * This is a reference implementation for cross-checking.
 */
export function refRootHash(entries: readonly Uint8Array[], hasher: LogHasher): Uint8Array {
	if (entries.length === 0) {
		return hasher.emptyRoot();
	}
	if (entries.length === 1) {
		return hasher.hashLeaf(entries[0] as Uint8Array);
	}
	const split = Number(downToPowerOfTwo(BigInt(entries.length)));
	return hasher.hashChildren(refRootHash(entries.slice(0, split), hasher), refRootHash(entries.slice(split), hasher));
}

/**
 * refInclusionProof returns the inclusion proof for the given leaf index in a
 * Merkle tree with the given entries. This is a reference implementation for
 * cross-checking.
 */
export function refInclusionProof(entries: readonly Uint8Array[], index: bigint, hasher: LogHasher): Uint8Array[] {
	const size = BigInt(entries.length);
	if (size === 1n || index >= size) {
		return [];
	}
	const split = downToPowerOfTwo(size);
	if (index < split) {
		return [
			...refInclusionProof(entries.slice(0, Number(split)), index, hasher),
			refRootHash(entries.slice(Number(split)), hasher),
		];
	}
	return [
		...refInclusionProof(entries.slice(Number(split)), index - split, hasher),
		refRootHash(entries.slice(0, Number(split)), hasher),
	];
}

/**
 * refConsistencyProof returns the consistency proof for the two tree sizes, in
 * a Merkle tree with the given entries. This is a reference implementation for
 * cross-checking.
 */
export function refConsistencyProof(
	entries: readonly Uint8Array[],
	size2: bigint,
	size1: bigint,
	hasher: LogHasher,
	haveRoot1: boolean,
): Uint8Array[] {
	if (size1 === 0n || size1 > size2) {
		return [];
	}
	// Consistency proof for two equal sizes is empty.
	if (size1 === size2) {
		// Record the hash of this subtree if it's not the root for which the proof
		// was originally requested (which happens when size1 is a power of 2).
		if (!haveRoot1) {
			return [refRootHash(entries.slice(0, Number(size1)), hasher)];
		}
		return [];
	}

	// At this point: 0 < size1 < size2.
	const split = downToPowerOfTwo(size2);
	if (size1 <= split) {
		// Root of size1 is in the left subtree of size2. Prove that the left
		// subtrees are consistent, and record the hash of the right subtree (only
		// present in size2).
		return [
			...refConsistencyProof(entries.slice(0, Number(split)), split, size1, hasher, haveRoot1),
			refRootHash(entries.slice(Number(split)), hasher),
		];
	}

	// Root of size1 is at the same level as size2 root. Prove that the right
	// subtrees are consistent. The right subtree doesn't contain the root of
	// size1, so set haveRoot1 = false. Record the hash of the left subtree
	// (equal in both trees).
	return [
		...refConsistencyProof(entries.slice(Number(split)), size2 - split, size1 - split, hasher, false),
		refRootHash(entries.slice(0, Number(split)), hasher),
	];
}

/** downToPowerOfTwo returns the largest power of two smaller than x. */
export function downToPowerOfTwo(x: bigint): bigint {
	if (x < 2n) {
		throw new Error("downToPowerOfTwo requires value >= 2");
	}
	return 1n << BigInt(len64(x - 1n) - 1);
}
