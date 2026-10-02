// Copyright 2019 Google LLC. All Rights Reserved.
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
// Ported from merkle/compact/range.go @ v0.0.2

// Package compact provides compact Merkle tree data structures.

import {
	asUint64,
	len64,
	onesCount64,
	shiftLeft64,
	shiftRight64,
	trailingZeros64,
} from "../../../internal/gostd/bits.ts";
import { bytesEqual } from "../../../internal/gostd/bytes.ts";
import { type NodeID, newNodeID, rangeSize } from "./nodes.ts";

/** HashFn computes an internal node's hash using the hashes of its child nodes. */
export type HashFn = (left: Uint8Array, right: Uint8Array) => Uint8Array;

/** VisitFn visits the node with the specified ID and hash. */
export type VisitFn = (id: NodeID, hash: Uint8Array) => void;

/**
 * RangeFactory allows creating compact ranges with the specified hash
 * function, which must not be nil, and must not be changed.
 */
export class RangeFactory {
	readonly hash: HashFn;

	constructor(hash: HashFn) {
		this.hash = hash;
	}

	/**
	 * newRange creates a Range for [begin, end) with the given set of hashes. The
	 * hashes correspond to the roots of the minimal set of perfect sub-trees
	 * covering the [begin, end) leaves range, ordered left to right.
	 */
	newRange(begin: bigint, end: bigint, hashes: Uint8Array[]): Range {
		if (end < begin) {
			throw new Error(`invalid range: end=${end}, want >= ${begin}`);
		}
		const got = hashes.length;
		const want = rangeSize(begin, end);
		if (got !== want) {
			throw new Error(`invalid hashes: got ${got} values, want ${want}`);
		}
		return new Range(this, begin, end, hashes);
	}

	/**
	 * newEmptyRange returns a new Range for an empty [begin, begin) range. The
	 * value of begin defines where the range will start growing from when entries
	 * are appended to it.
	 */
	newEmptyRange(begin: bigint): Range {
		return new Range(this, begin, begin, []);
	}
}

/**
 * Range represents a compact Merkle tree range for leaf indices [begin, end).
 *
 * It contains the minimal set of perfect subtrees whose leaves comprise this
 * range. The structure is efficiently mergeable with other compact ranges that
 * share one of the endpoints with it.
 *
 * For more details, see
 * https://github.com/transparency-dev/merkle/blob/main/docs/compact_ranges.md.
 */
export class Range {
	/** @internal Unexported in Go; see docs/decisions/0010-package-private-members.md. */
	_f: RangeFactory;
	/** @internal */
	_begin: bigint;
	/** @internal */
	_end: bigint;
	/** @internal */
	_hashes: Uint8Array[];

	/**
	 * @internal Stands in for Go's `&Range{f, begin, end, hashes}` composite
	 * literal, which is package-private. It performs no validation — construct
	 * ranges through RangeFactory.
	 */
	constructor(f: RangeFactory, begin: bigint, end: bigint, hashes: Uint8Array[]) {
		this._f = f;
		this._begin = begin;
		this._end = end;
		this._hashes = hashes;
	}

	/** begin returns the first index covered by the range (inclusive). */
	begin(): bigint {
		return this._begin;
	}

	/** end returns the last index covered by the range (exclusive). */
	end(): bigint {
		return this._end;
	}

	/**
	 * hashes returns sub-tree hashes corresponding to the minimal set of perfect
	 * sub-trees covering the [begin, end) range, ordered left to right.
	 */
	hashes(): Uint8Array[] {
		return this._hashes;
	}

	/**
	 * append extends the compact range by appending the passed in hash to it. It
	 * reports all the added nodes through the visitor function (if non-null).
	 */
	append(hash: Uint8Array, visitor: VisitFn | null): void {
		if (visitor !== null) {
			visitor(newNodeID(0, this._end), hash);
		}
		this.#appendImpl(this._end + 1n, hash, [], visitor);
	}

	/**
	 * appendRange extends the compact range by merging in the other compact range
	 * from the right. It uses the tree hasher to calculate hashes of newly created
	 * nodes, and reports them through the visitor function (if non-null).
	 */
	appendRange(other: Range, visitor: VisitFn | null): void {
		if (other._f !== this._f) {
			throw new Error("incompatible ranges");
		}
		const got = other._begin;
		const want = this._end;
		if (got !== want) {
			throw new Error(`ranges are disjoint: other.begin=${got}, want ${want}`);
		}
		if (other._hashes.length === 0) {
			// The other range is empty, merging is trivial.
			return;
		}
		this.#appendImpl(other._end, other._hashes[0] as Uint8Array, other._hashes.slice(1), visitor);
	}

	/**
	 * getRootHash returns the root hash of the Merkle tree represented by this
	 * compact range. Requires the range to start at index 0. If the range is
	 * empty, returns null.
	 *
	 * If visitor is not null, it is called with all "ephemeral" nodes (i.e. the
	 * ones rooting imperfect subtrees) along the right border of the tree.
	 */
	getRootHash(visitor: VisitFn | null): Uint8Array | null {
		if (this._begin !== 0n) {
			throw new Error(`begin=${this._begin}, want 0`);
		}
		const ln = this._hashes.length;
		if (ln === 0) {
			return null;
		}
		let hash = this._hashes[ln - 1] as Uint8Array;
		// All non-perfect subtree hashes along the right border of the tree
		// correspond to the parents of all perfect subtree nodes except the lowest
		// one (therefore the loop skips it).
		let size = this._end;
		for (let i = ln - 2; i >= 0; i--) {
			hash = this._f.hash(this._hashes[i] as Uint8Array, hash);
			if (visitor !== null) {
				size &= size - 1n; // Delete the previous node.
				const level = trailingZeros64(size) + 1; // Compute the parent level.
				const index = shiftRight64(size, level); // And its horizontal index.
				visitor(newNodeID(level, index), hash);
			}
		}
		return hash;
	}

	/** equal compares two Ranges for equality. */
	equal(other: Range): boolean {
		if (this._f !== other._f || this._begin !== other._begin || this._end !== other._end) {
			return false;
		}
		if (this._hashes.length !== other._hashes.length) {
			return false;
		}
		for (let i = 0; i < this._hashes.length; i++) {
			if (!bytesEqual(this._hashes[i] as Uint8Array, other._hashes[i] as Uint8Array)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * appendImpl extends the compact range by merging the [r.end, end) compact
	 * range into it. The other compact range is decomposed into a seed hash and
	 * all the other hashes (possibly none). The method uses the tree hasher to
	 * calculate hashes of newly created nodes, and reports them through the
	 * visitor function (if non-null).
	 */
	#appendImpl(end: bigint, seed: Uint8Array, hashes: readonly Uint8Array[], visitor: VisitFn | null): void {
		// Bits [low, high) of r.end encode the merge path, i.e. the sequence of node
		// merges that transforms the two compact ranges into one.
		const [low, rawHigh] = getMergePath(this._begin, this._end, end);
		const high = rawHigh < low ? low : rawHigh;
		let index = shiftRight64(this._end, low);
		// Now bits [0, high-low) of index encode the merge path.

		// The number of one bits in index is the number of nodes from the left range
		// that will be merged, and zero bits correspond to the nodes in the right
		// range. Below we make sure that both ranges have enough hashes, which can
		// be false only in case the data is corrupted in some way.
		const ones = onesCount64(index & (shiftLeft64(1n, high - low) - 1n));
		if (this._hashes.length < ones) {
			throw new Error(`corrupted lhs range: got ${this._hashes.length} hashes, want >= ${ones}`);
		}
		const zeros = high - low - ones;
		if (hashes.length < zeros) {
			throw new Error(`corrupted rhs range: got ${hashes.length + 1} hashes, want >= ${zeros + 1}`);
		}

		// Some of the trailing nodes of the left compact range, and some of the
		// leading nodes of the right range, are sequentially merged with the seed,
		// according to the mask. All new nodes are reported through the visitor.
		let idx1 = this._hashes.length;
		let idx2 = 0;
		for (let h = low; h < high; h++) {
			if ((index & 1n) === 0n) {
				seed = this._f.hash(seed, hashes[idx2] as Uint8Array);
				idx2++;
			} else {
				idx1--;
				seed = this._f.hash(this._hashes[idx1] as Uint8Array, seed);
			}
			index >>= 1n;
			if (visitor !== null) {
				visitor(newNodeID(h + 1, index), seed);
			}
		}

		// All nodes from both ranges that have not been merged are bundled together
		// with the "merged" seed node.
		this._hashes = [...this._hashes.slice(0, idx1), seed, ...hashes.slice(idx2)];
		this._end = end;
	}
}

/**
 * getMergePath returns the merging path between the compact range [begin, mid)
 * and [mid, end). The path is represented as a range of bits within mid, with
 * bit indices [low, high). A bit value of 1 on level i of mid means that the
 * node on this level merges with the corresponding node in the left compact
 * range, whereas 0 represents merging with the right compact range. If the
 * path is empty then high <= low.
 *
 * The output is not specified if begin <= mid <= end doesn't hold, but the
 * function never panics.
 *
 * @internal Unexported in Go; see docs/decisions/0010-package-private-members.md.
 */
export function getMergePath(begin: bigint, mid: bigint, end: bigint): [number, number] {
	const low = trailingZeros64(mid);
	let high = 64;
	if (begin !== 0n) {
		high = len64(mid ^ (begin - 1n));
	}
	// Port note: `mid - 1` is uint64 subtraction upstream and wraps to MaxUint64
	// when mid is 0, which the {0,0,0} case of TestGetMergePath depends on.
	const high2 = len64(asUint64(mid - 1n) ^ end);
	if (high2 < high) {
		high = high2;
	}
	return [low, high - 1];
}

/**
 * decompose splits the [begin, end) range into a minimal number of sub-ranges,
 * each of which is of the form [m * 2^k, (m+1) * 2^k), i.e. of length 2^k, for
 * some integers m, k >= 0.
 *
 * The sequence of sizes is returned encoded as bitmasks left and right, where:
 *   - a 1 bit in a bitmask denotes a sub-range of the corresponding size 2^k
 *   - left mask bits in LSB-to-MSB order encode the left part of the sequence
 *   - right mask bits in MSB-to-LSB order encode the right part
 *
 * The corresponding values of m are not returned (they can be calculated from
 * begin and the sub-range sizes).
 *
 * For example, (begin, end) values of (0b110, 0b11101) would indicate a
 * sequence of tree sizes: 2,8; 8,4,1.
 *
 * The output is not specified if begin > end, but the function never panics.
 */
export function decompose(begin: bigint, end: bigint): [bigint, bigint] {
	// Special case, as the code below works only if begin != 0, or end < 2^63.
	if (begin === 0n) {
		return [0n, end];
	}
	const xbegin = begin - 1n;
	// Find where paths to leaves #begin-1 and #end diverge, and mask the upper
	// bits away, as only the nodes strictly below this point are in the range.
	const d = len64(xbegin ^ end) - 1;
	const mask = asUint64(shiftLeft64(1n, d) - 1n);
	// The left part of the compact range consists of all nodes strictly below
	// and to the right from the path to leaf #begin-1, corresponding to zero
	// bits in the masked part of begin-1. Likewise, the right part consists of
	// nodes below and to the left from the path to leaf #end, corresponding to
	// ones in the masked part of end.
	return [asUint64(~xbegin) & mask, end & mask];
}
