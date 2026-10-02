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
// Ported from merkle/hasher.go @ v0.0.2

// Package merkle provides Merkle tree interfaces and implementation.

// TODO(pavelkalinnikov): Remove this root package. The only interface provided
// here does not have to exist, and can be [re-]defined on the user side, such
// as in compact or proof package.

/** LogHasher provides the hash functions needed to compute dense merkle trees. */
export interface LogHasher {
	/** emptyRoot supports returning a special case for the root of an empty tree. */
	emptyRoot(): Uint8Array;
	/** hashLeaf computes the hash of a leaf that exists. */
	hashLeaf(leaf: Uint8Array): Uint8Array;
	/** hashChildren computes interior nodes. */
	hashChildren(l: Uint8Array, r: Uint8Array): Uint8Array;
	/** size returns the number of bytes the hash* functions will return. */
	size(): number;
}
