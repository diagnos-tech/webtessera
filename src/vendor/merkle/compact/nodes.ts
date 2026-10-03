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
// Ported from merkle/compact/nodes.go @ v0.0.2

import {
	assertUint64,
	asUint64,
	len64,
	onesCount64,
	shiftLeft64,
	shiftRight64,
	trailingZeros64,
} from "../../../internal/gostd/bits.ts";
import { decompose } from "./range.ts";

/**
 * NodeID identifies a node of a Merkle tree.
 *
 * The ID consists of a level and index within this level. Levels are numbered
 * from 0, which corresponds to the tree leaves. Within each level, nodes are
 * numbered with consecutive indices starting from 0.
 *
 *	L4:         ┌───────0───────┐                ...
 *	L3:     ┌───0───┐       ┌───1───┐       ┌─── ...
 *	L2:   ┌─0─┐   ┌─1─┐   ┌─2─┐   ┌─3─┐   ┌─4─┐  ...
 *	L1:  ┌0┐ ┌1┐ ┌2┐ ┌3┐ ┌4┐ ┌5┐ ┌6┐ ┌7┐ ┌8┐ ┌9┐ ...
 *	L0:  0 1 2 3 4 5 6 7 8 9 ... ... ... ... ... ...
 *
 * When the tree is not perfect, the nodes that would complement it to perfect
 * are called ephemeral. Algorithms that operate with ephemeral nodes still map
 * them to the same address space.
 *
 * Port note: Go's NodeID is a comparable struct value, so `a == b` compares the
 * coordinates. A TypeScript class instance compares by identity, so compare `level`
 * and `index` (or use a deep-equality matcher in tests); the fields are `readonly` to
 * keep the value semantics. Go's `uint` level is a `number` (ADR-0003).
 */
export class NodeID {
	readonly level: number;
	readonly index: bigint;

	/**
	 * Stands in for Go's `NodeID{Level: level, Index: index}` composite literal,
	 * which is public because both fields are exported.
	 *
	 * Port note: index must be a uint64; anything else throws a RangeError. See
	 * docs/decisions/0207-uint64-domain-guards.md.
	 */
	constructor(level: number, index: bigint) {
		assertUint64(index, "index");
		this.level = level;
		this.index = index;
	}

	/** parent returns the ID of the parent node. */
	parent(): NodeID {
		return newNodeID(this.level + 1, this.index >> 1n);
	}

	/** sibling returns the ID of the sibling node. */
	sibling(): NodeID {
		return newNodeID(this.level, this.index ^ 1n);
	}

	/** coverage returns the [begin, end) range of leaves covered by the node. */
	coverage(): [bigint, bigint] {
		return [shiftLeft64(this.index, this.level), shiftLeft64(asUint64(this.index + 1n), this.level)];
	}
}

/**
 * newNodeID returns a NodeID with the passed in node coordinates.
 *
 * Port note: index must be a uint64; the NodeID constructor enforces it.
 */
export function newNodeID(level: number, index: bigint): NodeID {
	return new NodeID(level, index);
}

/**
 * rangeNodes appends the IDs of the nodes that comprise the [begin, end)
 * compact range to the given slice, and returns the new slice. The caller may
 * pre-allocate space with the help of the rangeSize function.
 *
 * Port note: Go's `append` may write through to the caller's backing array. The
 * port always returns a fresh array, which is the behaviour upstream's callers
 * rely on (they reassign the result, and nodes_test.go asserts the passed-in
 * prefix is left intact). See docs/decisions/0013-go-slice-semantics-in-merkle.md.
 *
 * Port note: begin and end must be uint64s; anything else throws a RangeError.
 * See docs/decisions/0207-uint64-domain-guards.md.
 */
export function rangeNodes(begin: bigint, end: bigint, ids: readonly NodeID[]): NodeID[] {
	assertUint64(begin, "begin");
	assertUint64(end, "end");
	let [left, right] = decompose(begin, end);

	const out = [...ids];
	let pos = begin;
	// Iterate over perfect subtrees along the left border of the range, ordered
	// from lower to upper levels.
	for (let bit = 0n; left !== 0n; pos += bit, left ^= bit) {
		const level = trailingZeros64(left);
		bit = shiftLeft64(1n, level);
		out.push(newNodeID(level, shiftRight64(pos, level)));
	}

	// Iterate over perfect subtrees along the right border of the range, ordered
	// from upper to lower levels.
	for (let bit = 0n; right !== 0n; pos += bit, right ^= bit) {
		const level = len64(right) - 1;
		bit = shiftLeft64(1n, level);
		out.push(newNodeID(level, shiftRight64(pos, level)));
	}

	return out;
}

/**
 * rangeSize returns the number of nodes in the [begin, end) compact range.
 *
 * Port note: begin and end must be uint64s; see rangeNodes.
 */
export function rangeSize(begin: bigint, end: bigint): number {
	assertUint64(begin, "begin");
	assertUint64(end, "end");
	const [left, right] = decompose(begin, end);
	return onesCount64(left) + onesCount64(right);
}
