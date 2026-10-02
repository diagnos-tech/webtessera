// Copyright 2024 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/entry.go @ 4a6d9f9

// Module tessera provides an implementation of a tile-based logging framework.

import { appendUint16BE, concatBytes } from "./internal/gostd/bytes.ts";
import { identityHash } from "./lifecycle.ts";
import { DefaultHasher } from "./vendor/merkle/rfc6962/rfc6962.ts";

/**
 * Entry represents an entry in a log.
 *
 * Port note: Go keeps all the data in exported fields inside an unexported `internal`
 * struct. This allows Go to use gob to serialise the entry data (relying on the
 * backwards-compatibility it provides), while also keeping these fields private, which
 * deters bad practice by forcing use of the API to set these values to safe values.
 * TypeScript has no gob concern and no package-private visibility (ADR-0010), but the
 * field-privacy *intent* is kept: `internal` is grouped exactly as Go groups it, so other
 * files in the same conceptual Go package (this file's own `newEntry`, and `ct_only.ts`'s
 * `convertCTEntry` — see docs/decisions/0059-convertctentry-ported-closes-second-adr-0044-item.md)
 * can reach it the way Go's same-package visibility allows, while ordinary callers use the
 * accessor methods below. Nesting the fields under `internal` — rather than flattening them
 * onto Entry directly — is what avoids the field/accessor name collision that ADR-0010
 * prefixes with `_` for flatter cases (`internal.data` and `data()` live on different
 * objects), so this container needs no leading underscore of its own.
 */
export class Entry {
	internal: {
		data: Uint8Array;
		identity: Uint8Array;
		leafHash: Uint8Array;
		index: bigint | undefined;
	};

	/** marshalForBundle knows how to convert this entry's Data into a marshalled bundle entry. */
	marshalForBundle: (index: bigint) => Uint8Array;

	/** @internal Constructs a blank Entry, mirroring Go's `&Entry{}` zero value; use newEntry. */
	constructor() {
		this.internal = {
			data: new Uint8Array(0),
			identity: new Uint8Array(0),
			leafHash: new Uint8Array(0),
			index: undefined,
		};
		this.marshalForBundle = (): Uint8Array => new Uint8Array(0);
	}

	/** data returns the raw entry bytes which will form the entry in the log. */
	data(): Uint8Array {
		return this.internal.data;
	}

	/** identity returns an identity which may be used to de-duplicate entries and they are being added to the log. */
	identity(): Uint8Array {
		return this.internal.identity;
	}

	/**
	 * leafHash is the Merkle leaf hash which will be used for this entry in the log.
	 * Note that in almost all cases, this should be the RFC6962 definition of a leaf hash.
	 */
	leafHash(): Uint8Array {
		return this.internal.leafHash;
	}

	/** index returns the index assigned to the entry in the log, or undefined if no index has been assigned. */
	index(): bigint | undefined {
		return this.internal.index;
	}

	/**
	 * marshalBundleData returns this entry's data in a format ready to be appended to an EntryBundle.
	 *
	 * Note that marshalBundleData _may_ be called multiple times, potentially with different values for index
	 * (e.g. if there's a failure in the storage when trying to persist the assignment), so index should not
	 * be considered final until the storage Add method has returned successfully with the durably assigned index.
	 */
	marshalBundleData(index: bigint): Uint8Array {
		this.internal.index = index;
		return this.marshalForBundle(index);
	}
}

/** newEntry creates a new Entry object with leaf data. */
export function newEntry(data: Uint8Array): Entry {
	const e = new Entry();
	e.internal.data = data;
	const h = identityHash(e.internal.data);
	e.internal.identity = h;
	e.internal.leafHash = DefaultHasher.hashLeaf(e.internal.data);
	// By default we will marshal ourselves into a bundle using the mechanism described
	// by https://c2sp.org/tlog-tiles:
	e.marshalForBundle = (): Uint8Array => {
		const lengthPrefix = appendUint16BE(new Uint8Array(0), e.internal.data.length);
		return concatBytes(lengthPrefix, e.internal.data);
	};
	return e;
}
