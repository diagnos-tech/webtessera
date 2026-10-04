// Copyright 2024 The Tessera authors. All Rights Reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
//
// Original source: https://github.com/FiloSottile/sunlight/blob/main/tile.go
//
// # Copyright 2023 The Sunlight Authors
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// Ported from tessera/ctonly/ct.go @ 4a6d9f9

// Package ctonly has support for CT Tiles API.
//
// This code should not be reused outside of CT.
// Most of this code came from Filippo's Sunlight implementation of https://c2sp.org/ct-static-api.

import { sha256 } from "@noble/hashes/sha2.js";
import * as cryptobyte from "../internal/gostd/cryptobyte.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";

const emptyBytes = new Uint8Array(0);

/**
 * EntryFields carries the values an Entry is built from.
 *
 * Port note: it stands in for Go's composite literal, where an omitted field takes its
 * zero value. `[]byte` zero values are nil in Go and an empty Uint8Array here; both have
 * length zero, which is all the encoders below observe. See
 * docs/decisions/0043-ctonly-entry-port.md.
 */
export interface EntryFields {
	readonly timestamp?: bigint;
	readonly isPrecert?: boolean;
	readonly certificate?: Uint8Array;
	readonly precertificate?: Uint8Array;
	readonly issuerKeyHash?: Uint8Array;
	readonly fingerprintsChain?: readonly Uint8Array[];
}

/** Entry represents a CT log entry. */
export class Entry {
	readonly timestamp: bigint;
	readonly isPrecert: boolean;
	/**
	 * certificate holds different things depending on whether the entry represents a
	 * Certificate or a Precertificate submission:
	 *   - isPrecert === false: the bytes here are the x509 certificate submitted for logging.
	 *   - isPrecert === true: the bytes here are the TBS certificate extracted from the submitted precert.
	 */
	readonly certificate: Uint8Array;
	/** precertificate holds the precertificate to be logged, only used when isPrecert is true. */
	readonly precertificate: Uint8Array;
	readonly issuerKeyHash: Uint8Array;
	readonly fingerprintsChain: readonly Uint8Array[];

	constructor(fields: EntryFields = {}) {
		this.timestamp = fields.timestamp ?? 0n;
		this.isPrecert = fields.isPrecert ?? false;
		this.certificate = fields.certificate ?? emptyBytes;
		this.precertificate = fields.precertificate ?? emptyBytes;
		this.issuerKeyHash = fields.issuerKeyHash ?? emptyBytes;
		this.fingerprintsChain = fields.fingerprintsChain ?? [];
	}

	/**
	 * leafData returns the data which should be added to an entry bundle for this entry.
	 *
	 * Note that this will include data which IS NOT directly committed to by the entry's
	 * merkleLeafHash.
	 *
	 * Port note: Go's FingerprintsChain is a `[][32]byte`, so every fingerprint is 32 bytes by
	 * its type; a Uint8Array is not, and a fingerprint of any other length would write a bundle
	 * entry no parser can split. Such an entry throws a RangeError here instead
	 * (docs/decisions/0043-ctonly-entry-port.md).
	 */
	leafData(idx: bigint): Uint8Array {
		this.fingerprintsChain.forEach((f, i) => {
			if (f.length !== 32) {
				throw new RangeError(`ctonly: fingerprintsChain[${i}] is ${f.length} bytes, want 32`);
			}
		});
		const b = cryptobyte.newBuilder(new Uint8Array(0));
		b.addUint64(this.timestamp);
		if (!this.isPrecert) {
			b.addUint16(0 /* entry_type = x509_entry */);
			b.addUint24LengthPrefixed((b) => {
				b.addBytes(this.certificate);
			});
		} else {
			b.addUint16(1 /* entry_type = precert_entry */);
			b.addBytes(this.issuerKeyHash);
			b.addUint24LengthPrefixed((b) => {
				// Note that this is really the TBS extracted from the submitted precertificate.
				b.addBytes(this.certificate);
			});
		}
		addExtensions(b, idx);
		if (this.isPrecert) {
			b.addUint24LengthPrefixed((b) => {
				b.addBytes(this.precertificate);
			});
		}
		b.addUint16LengthPrefixed((b) => {
			for (const f of this.fingerprintsChain) {
				b.addBytes(f);
			}
		});
		return b.bytesOrPanic();
	}

	/**
	 * merkleTreeLeaf returns a RFC 6962 MerkleTreeLeaf.
	 *
	 * Note that we embed an SCT extension which captures the index of the entry in the log according to
	 * the mechanism specified in https://c2sp.org/ct-static-api.
	 */
	merkleTreeLeaf(idx: bigint): Uint8Array {
		const b = new cryptobyte.Builder();
		b.addUint8(0 /* version = v1 */);
		b.addUint8(0 /* leaf_type = timestamped_entry */);
		b.addUint64(this.timestamp);
		if (!this.isPrecert) {
			b.addUint16(0 /* entry_type = x509_entry */);
			b.addUint24LengthPrefixed((b) => {
				b.addBytes(this.certificate);
			});
		} else {
			b.addUint16(1 /* entry_type = precert_entry */);
			b.addBytes(this.issuerKeyHash);
			b.addUint24LengthPrefixed((b) => {
				// Note that this is really the TBS extracted from the submitted precertificate.
				b.addBytes(this.certificate);
			});
		}
		addExtensions(b, idx);
		return b.bytesOrPanic();
	}

	/**
	 * merkleLeafHash returns the RFC6962 leaf hash for this entry.
	 *
	 * Note that we embed an SCT extension which captures the index of the entry in the log according to
	 * the mechanism specified in https://c2sp.org/ct-static-api.
	 */
	merkleLeafHash(leafIndex: bigint): Uint8Array {
		return DefaultHasher.hashLeaf(this.merkleTreeLeaf(leafIndex));
	}

	identity(): Uint8Array {
		let r: Uint8Array;
		if (this.isPrecert) {
			r = sha256(this.precertificate);
		} else {
			r = sha256(this.certificate);
		}
		return r;
	}
}

function addExtensions(b: cryptobyte.Builder, leafIndex: bigint): void {
	b.addUint16LengthPrefixed((b) => {
		let ext: Uint8Array;
		try {
			ext = new extensions(leafIndex).marshal();
		} catch (err) {
			b.setError(err instanceof Error ? err : new Error(`${err}`));
			return;
		}
		b.addBytes(ext);
	});
}

/**
 * extensions is the CTExtensions field of SignedCertificateTimestamp and
 * TimestampedEntry, according to c2sp.org/static-ct-api.
 */
class extensions {
	readonly leafIndex: bigint;

	constructor(leafIndex: bigint) {
		this.leafIndex = leafIndex;
	}

	marshal(): Uint8Array {
		// enum {
		//     leaf_index(0), (255)
		// } ExtensionType;
		//
		// struct {
		//     ExtensionType extension_type;
		//     opaque extension_data<0..2^16-1>;
		// } Extension;
		//
		// Extension CTExtensions<0..2^16-1>;
		//
		// uint8 uint40[5];
		// uint40 LeafIndex;

		const b = new cryptobyte.Builder();
		b.addUint8(0 /* extension_type = leaf_index */);
		b.addUint16LengthPrefixed((b) => {
			if (this.leafIndex >= 1n << 40n) {
				b.setError(new Error("leaf_index out of range"));
				return;
			}
			addUint40(b, this.leafIndex);
		});
		return b.bytes();
	}
}

/** addUint40 appends a big-endian, 40-bit value to the byte string. */
function addUint40(b: cryptobyte.Builder, v: bigint): void {
	b.addBytes(
		Uint8Array.of(
			Number((v >> 32n) & 0xffn),
			Number((v >> 24n) & 0xffn),
			Number((v >> 16n) & 0xffn),
			Number((v >> 8n) & 0xffn),
			Number(v & 0xffn),
		),
	);
}
