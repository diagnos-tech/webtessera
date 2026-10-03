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
// Ported from merkle/testonly/tree.go @ v0.0.2

import type { NodeID } from "../compact/nodes.ts";
import { rangeNodes } from "../compact/nodes.ts";
import type { LogHasher } from "../hasher.ts";
import { consistency, inclusion } from "../proof/proof.ts";

/**
 * Tree implements an append-only Merkle tree. For testing.
 *
 * Port note: Go's constructor is `testonly.New(hasher)`. `new` is a reserved
 * word in TypeScript, so the class constructor takes its place:
 * `new Tree(hasher)`. See docs/decisions/0011-merkle-constructors-and-hash-injection.md.
 */
export class Tree {
	/** @internal Unexported in Go; see docs/decisions/0010-package-private-members.md. */
	_hasher: LogHasher;
	/** @internal */
	_size: bigint;
	/** @internal Node hashes, indexed by node (level, index). */
	_hashes: Uint8Array[][];

	/** New returns a new empty Merkle tree. */
	constructor(hasher: LogHasher) {
		this._hasher = hasher;
		this._size = 0n;
		this._hashes = [];
	}

	/** appendData adds the leaf hashes of the given entries to the end of the tree. */
	appendData(...entries: Uint8Array[]): void {
		for (const data of entries) {
			this.#appendImpl(this._hasher.hashLeaf(data));
		}
	}

	/** append adds the given leaf hashes to the end of the tree. */
	append(...hashes: Uint8Array[]): void {
		for (const hash of hashes) {
			this.#appendImpl(hash);
		}
	}

	#appendImpl(hash: Uint8Array): void {
		let level = 0;
		for (; ((this._size >> BigInt(level)) & 1n) === 1n; level++) {
			const row = this._hashes[level] as Uint8Array[];
			row.push(hash);
			hash = this._hasher.hashChildren(row[row.length - 2] as Uint8Array, hash);
		}
		if (level > this._hashes.length) {
			throw new Error("gap in tree appends");
		} else if (level === this._hashes.length) {
			this._hashes.push([]);
		}

		(this._hashes[level] as Uint8Array[]).push(hash);
		this._size++;
	}

	/** size returns the current number of leaves in the tree. */
	size(): bigint {
		return this._size;
	}

	/**
	 * leafHash returns the leaf hash at the given index.
	 * Requires 0 <= index < size(), otherwise throws.
	 */
	leafHash(index: bigint): Uint8Array {
		return this.#node(0, index);
	}

	/** hash returns the current root hash of the tree. */
	hash(): Uint8Array {
		return this.hashAt(this._size);
	}

	/**
	 * hashAt returns the root hash at the given size.
	 * Requires 0 <= size <= size(), otherwise throws.
	 */
	hashAt(size: bigint): Uint8Array {
		if (size === 0n) {
			return this._hasher.emptyRoot();
		}
		const hashes = this.#getNodes(rangeNodes(0n, size, []));

		let hash = hashes[hashes.length - 1] as Uint8Array;
		for (let i = hashes.length - 2; i >= 0; i--) {
			hash = this._hasher.hashChildren(hashes[i] as Uint8Array, hash);
		}
		return hash;
	}

	/**
	 * inclusionProof returns the inclusion proof for the given leaf index in the
	 * tree of the given size. Requires 0 <= index < size <= size(), otherwise may
	 * throw.
	 */
	inclusionProof(index: bigint, size: bigint): Uint8Array[] {
		const nodes = inclusion(index, size);
		return nodes.rehash(this.#getNodes(nodes.ids), (l, r) => this._hasher.hashChildren(l, r));
	}

	/**
	 * consistencyProof returns the consistency proof between the two given tree
	 * sizes. Requires 0 <= size1 <= size2 <= size(), otherwise may throw.
	 */
	consistencyProof(size1: bigint, size2: bigint): Uint8Array[] {
		const nodes = consistency(size1, size2);
		return nodes.rehash(this.#getNodes(nodes.ids), (l, r) => this._hasher.hashChildren(l, r));
	}

	#getNodes(ids: readonly NodeID[]): Uint8Array[] {
		return ids.map((id) => this.#node(id.level, id.index));
	}

	// node stands in for Go's `t.hashes[level][index]`, which TypeScript's
	// noUncheckedIndexedAccess makes verbose at every use. Go panics on an
	// out-of-range index; this throws.
	#node(level: number, index: bigint): Uint8Array {
		const row = this._hashes[level];
		const hash = row === undefined ? undefined : row[Number(index)];
		if (hash === undefined) {
			throw new Error(`node (${level},${index}) does not exist`);
		}
		return hash;
	}
}
