// Copyright 2016 Google LLC. All Rights Reserved.
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
// Ported from merkle/rfc6962/rfc6962.go @ v0.0.2

// Package rfc6962 provides hashing functionality according to RFC6962.

// Port note: Go blank-imports `crypto/sha256` here ("SHA256 is the default
// algorithm."), which registers SHA-256 with `crypto.Hash`; the port imports the
// noble implementation directly. See docs/decisions/0011-merkle-constructors-and-hash-injection.md.
import { sha256 } from "@noble/hashes/sha2.js";
import type { CHash } from "@noble/hashes/utils.js";
import type { LogHasher } from "../hasher.ts";

/** Domain separation prefixes */
export const RFC6962LeafHashPrefix = 0;
/** Domain separation prefixes */
export const RFC6962NodeHashPrefix = 1;

/**
 * Hasher implements the RFC6962 tree hashing algorithm.
 *
 * Port note: Go embeds `crypto.Hash`, an index into the standard library's
 * registry of hash implementations, and calls `t.New()` to instantiate it. There
 * is no such registry in TypeScript, so the constructor takes the hash function
 * itself — the direct equivalent of upstream's `New(crypto.SHA256)` is
 * `new Hasher(sha256)`. See docs/decisions/0011-merkle-constructors-and-hash-injection.md.
 */
export class Hasher implements LogHasher {
	readonly hash: CHash;

	/** New creates a new Hashers.LogHasher on the passed in hash function. */
	constructor(hash: CHash) {
		this.hash = hash;
	}

	/** emptyRoot returns a special case for an empty tree. */
	emptyRoot(): Uint8Array {
		return this.hash.create().digest();
	}

	/**
	 * hashLeaf returns the Merkle tree leaf hash of the data passed in through leaf.
	 * The data in leaf is prefixed by the LeafHashPrefix.
	 */
	hashLeaf(leaf: Uint8Array): Uint8Array {
		const h = this.hash.create();
		h.update(new Uint8Array([RFC6962LeafHashPrefix]));
		h.update(leaf);
		return h.digest();
	}

	/**
	 * hashChildren returns the inner Merkle tree node hash of the two child nodes l and r.
	 * The hashed structure is NodeHashPrefix||l||r.
	 */
	hashChildren(l: Uint8Array, r: Uint8Array): Uint8Array {
		const h = this.hash.create();
		const b = new Uint8Array(1 + l.length + r.length);
		b[0] = RFC6962NodeHashPrefix;
		b.set(l, 1);
		b.set(r, 1 + l.length);

		h.update(b);
		return h.digest();
	}

	/** size returns the number of bytes the hash* functions will return. */
	size(): number {
		return this.hash.outputLen;
	}
}

/**
 * DefaultHasher is a SHA256 based LogHasher.
 *
 * Port note: declared after Hasher, where Go declares it before, because a `const`
 * cannot use a class before the class declaration has run. See
 * docs/decisions/0011-merkle-constructors-and-hash-injection.md.
 */
export const DefaultHasher = new Hasher(sha256);
