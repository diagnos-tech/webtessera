// Copyright 2022 Google LLC. All Rights Reserved.
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
// Ported from merkle/proof/proof.go @ v0.0.2

// Package proof contains helpers for constructing log Merkle tree proofs.

import { assertUint64, len64, shiftRight64, trailingZeros64 } from "../../../internal/gostd/bits.ts";
import { type NodeID, newNodeID, rangeNodes, rangeSize } from "../compact/nodes.ts";

/**
 * Nodes contains information on how to construct a log Merkle tree proof. It
 * supports any proof that has at most one ephemeral node, such as inclusion
 * and consistency proofs defined in RFC 6962.
 */
export class Nodes {
	/**
	 * ids contains the IDs of non-ephemeral nodes sufficient to build the proof.
	 * If an ephemeral node is needed for a proof, it can be recomputed based on
	 * a subset of nodes in this list.
	 */
	ids: NodeID[];
	/**
	 * @internal begin is the beginning index (inclusive) into the ids[begin:end]
	 * subslice of the nodes which will be used to re-create the ephemeral node.
	 * Unexported in Go; see docs/decisions/0010-package-private-members.md.
	 */
	_begin: number;
	/**
	 * @internal end is the ending (exclusive) index into the ids[begin:end]
	 * subslice of the nodes which will be used to re-create the ephemeral node.
	 */
	_end: number;
	/**
	 * @internal ephem is the ID of the ephemeral node in the proof. This node is
	 * a common ancestor of all nodes in ids[begin:end]. It is the node that
	 * otherwise would have been used in the proof if the tree was perfect.
	 */
	_ephem: NodeID;

	/**
	 * Stands in for Go's `Nodes{IDs: ids}` composite literal, which code outside the
	 * package may write because IDs is exported. The unexported fields keep their zero
	 * values; only nodesLiteral, which stands in for the in-package literal, sets them.
	 * See docs/decisions/0208-merkle-barrels-and-tuple-returns.md.
	 */
	constructor(ids: NodeID[] = []) {
		this.ids = ids;
		this._begin = 0;
		this._end = 0;
		this._ephem = newNodeID(0, 0n);
	}

	/**
	 * ephem returns the ephemeral node, and indices begin and end, such that
	 * ids[begin:end] slice contains the child nodes of the ephemeral node.
	 *
	 * The list is empty iff there are no ephemeral nodes in the proof. Some
	 * examples of when this can happen: a proof in a perfect tree; an inclusion
	 * proof for a leaf in a perfect subtree at the right edge of the tree.
	 */
	ephem(): [NodeID, number, number] {
		return [this._ephem, this._begin, this._end];
	}

	/**
	 * rehash computes the proof based on the slice of node hashes corresponding to
	 * their IDs in the n.ids field. The slices must be of the same length. The hc
	 * parameter computes a node's hash based on hashes of its children.
	 *
	 * Warning: The passed-in slice of hashes can be modified in-place.
	 */
	rehash(h: Uint8Array[], hc: (left: Uint8Array, right: Uint8Array) => Uint8Array): Uint8Array[] {
		const got = h.length;
		const want = this.ids.length;
		if (got !== want) {
			throw new Error(`got ${got} hashes but expected ${want}`);
		}
		let cursor = 0;
		// Scan the list of node hashes, and store the rehashed list in-place.
		// Invariant: cursor <= i, and h[:cursor] contains all the hashes of the
		// rehashed list after scanning h up to index i-1.
		for (let i = 0, ln = h.length; i < ln; i++, cursor++) {
			let hash = h[i] as Uint8Array;
			if (i >= this._begin && i < this._end) {
				// Scan the block of node hashes that need rehashing.
				for (i++; i < this._end; i++) {
					hash = hc(h[i] as Uint8Array, hash);
				}
				i--;
			}
			h[cursor] = hash;
		}
		return h.slice(0, cursor);
	}

	/**
	 * @internal skipFirst is unexported in Go, but the port's `inclusion` and
	 * `consistency` are module-level functions and cannot reach a `#private`
	 * method. See docs/decisions/0010-package-private-members.md.
	 */
	skipFirst(): Nodes {
		// Port note: Go's method has a value receiver, so it works on a copy. The
		// port returns a new Nodes for the same reason.
		const ids = this.ids.slice(1);
		// Fixup the indices into the ids slice.
		let begin = this._begin;
		let end = this._end;
		if (begin < end) {
			begin--;
			end--;
		}
		return nodesLiteral(ids, begin, end, this._ephem);
	}
}

/**
 * @internal nodesLiteral stands in for Go's in-package composite literal
 * `Nodes{IDs: ids, begin: begin, end: end, ephem: ephem}`, which sets the fields only
 * package proof can reach. See docs/decisions/0010-package-private-members.md.
 */
export function nodesLiteral(ids: NodeID[], begin: number, end: number, ephem: NodeID): Nodes {
	const n = new Nodes(ids);
	n._begin = begin;
	n._end = end;
	n._ephem = ephem;
	return n;
}

/**
 * inclusion returns the information on how to fetch and construct an inclusion
 * proof for the given leaf index in a log Merkle tree of the given size. It
 * requires 0 <= index < size.
 *
 * Port note: index and size must be uint64s; anything else throws a RangeError.
 * See docs/decisions/0207-uint64-domain-guards.md.
 */
export function inclusion(index: bigint, size: bigint): Nodes {
	assertUint64(index, "index");
	assertUint64(size, "size");
	if (index >= size) {
		throw new Error(`index ${index} out of bounds for tree size ${size}`);
	}
	return nodes(index, 0, size).skipFirst();
}

/**
 * consistency returns the information on how to fetch and construct a
 * consistency proof between the two given tree sizes of a log Merkle tree. It
 * requires 0 <= size1 <= size2.
 *
 * Port note: size1 and size2 must be uint64s; see inclusion.
 */
export function consistency(size1: bigint, size2: bigint): Nodes {
	assertUint64(size1, "size1");
	assertUint64(size2, "size2");
	if (size1 > size2) {
		throw new Error(`tree size ${size1} > ${size2}`);
	}
	if (size1 === size2 || size1 === 0n) {
		return new Nodes([]);
	}

	// Find the root of the biggest perfect subtree that ends at size1.
	const level = trailingZeros64(size1);
	const index = shiftRight64(size1 - 1n, level);
	// The consistency proof consists of this node (except if size1 is a power of
	// two, in which case adding this node would be redundant because the client
	// is assumed to know it from a checkpoint), and nodes of the inclusion proof
	// into this node in the tree of size2.
	const p = nodes(index, level, size2);

	// Handle the case when size1 is a power of 2.
	if (index === 0n) {
		return p.skipFirst();
	}
	return p;
}

/**
 * nodes returns the node IDs necessary to prove that the (level, index) node
 * is included in the Merkle tree of the given size.
 */
function nodes(index: bigint, level: number, size: bigint): Nodes {
	// Compute the `fork` node, where the path from root to (level, index) node
	// diverges from the path to (0, size).
	//
	// The sibling of this node is the ephemeral node which represents a subtree
	// that is not complete in the tree of the given size. To compute the hash
	// of the ephemeral node, we need all the non-ephemeral nodes that cover the
	// same range of leaves.
	//
	// The `inner` variable is how many layers up from (level, index) the `fork`
	// and the ephemeral nodes are.
	const inner = len64(index ^ shiftRight64(size, level)) - 1;
	const fork = newNodeID(level + inner, shiftRight64(index, inner));

	const [begin, end] = fork.coverage();
	const left = rangeSize(0n, begin);
	const right = rangeSize(end, size);

	let node = newNodeID(level, index);
	// Pre-allocate the exact number of nodes for the proof, in order:
	// - The seed node for which we are building the proof.
	// - The `inner` nodes at each level up to the fork node.
	// - The `right` nodes, comprising the ephemeral node.
	// - The `left` nodes, completing the coverage of the whole [0, size) range.
	let ids: NodeID[] = [node];

	// The first portion of the proof consists of the siblings for nodes of the
	// path going up to the level at which the ephemeral node appears.
	for (; node.level < fork.level; node = node.parent()) {
		ids.push(node.sibling());
	}
	// This portion of the proof covers the range [begin, end) under it. The
	// ranges to the left and to the right from it remain to be covered.

	// Add all the nodes (potentially none) that cover the right range, and
	// represent the ephemeral node. Reverse them so that the rehash method can
	// process hashes in the convenient order, from lower to upper levels.
	let len1 = ids.length;
	ids = rangeNodes(end, size, ids);
	reverse(ids, ids.length - right);
	let len2 = ids.length;
	// Add the nodes that cover the left range, ordered increasingly by level.
	ids = rangeNodes(0n, begin, ids);
	reverse(ids, ids.length - left);

	// ids[len1:len2] contains the nodes representing the ephemeral node. If
	// it's empty, make it zero. Note that it can also contain a single node.
	// Depending on the preference of the layer above, it may or may not be
	// considered ephemeral.
	if (len1 >= len2) {
		len1 = 0;
		len2 = 0;
	}

	return nodesLiteral(ids, len1, len2, fork.sibling());
}

/**
 * reverse reverses ids[from:] in place.
 *
 * Port note: Go reverses the sub-slice `ids[from:]`, which shares its backing
 * array with ids. TypeScript arrays have no slice views, so the offset is
 * passed explicitly.
 */
function reverse(ids: NodeID[], from: number): void {
	for (let i = from, j = ids.length - 1; i < j; i++, j--) {
		const tmp = ids[i] as NodeID;
		ids[i] = ids[j] as NodeID;
		ids[j] = tmp;
	}
}
