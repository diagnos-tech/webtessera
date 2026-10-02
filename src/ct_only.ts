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
// Ported from tessera/ct_only.go @ 4a6d9f9
//
// This is a partial port: one declaration that depends on the append lifecycle is still
// deferred, marked with a TODO(gustavo) below. See
// docs/decisions/0044-ct-only-partial-port.md.
//
// identityHash previously had a temporary duplicate copy here, pending src/lifecycle.ts.
// That file now exists (docs/decisions/0055-identityhash-relocated-closes-adr-0044.md);
// the copy is deleted and this file imports the shared definition instead.
//
// convertCTEntry previously awaited the root `Entry` type from src/entry.ts. That file now
// exists too, with exactly the `internal.identity`/`internal.leafHash`/`internal.data`
// fields and `marshalForBundle` hook this function needs — see entry.ts's own doc comment
// on `Entry.internal` — so convertCTEntry is ported below. It needed neither `Appender`
// nor `IndexFuture`; only its sibling `NewCertificateTransparencyAppender` does.
//
// `(*MigrationOptions).WithCTLayout` previously awaited src/migrate_lifecycle.ts, which now
// exists too, so `withCTLayout` is ported below — closing the second half of the TODO the
// witness/migrate work package's mission brief named explicitly.
// `(*AppendOptions).WithCTLayout` still awaits Wave 3's `AppendOptions`.

import { sha256 } from "@noble/hashes/sha2.js";
import * as layout from "./api/layout/index.ts";
import type * as ctonly from "./ctonly/ct.ts";
import { Entry } from "./entry.ts";
import * as cryptobyte from "./internal/gostd/cryptobyte.ts";
import { identityHash } from "./lifecycle.ts";
import type { MigrationOptions } from "./migrate_lifecycle.ts";
import { DefaultHasher } from "./vendor/merkle/rfc6962/rfc6962.ts";

// TODO(gustavo): port NewCertificateTransparencyAppender from tessera/ct_only.go:38. It
// returns a function which knows how to add a CT-specific entry type to the log, and needs
// `Appender` and `IndexFuture` from tessera/append_lifecycle.go. `IndexFuture` is ported
// (src/append_lifecycle.ts — docs/decisions/0054-append-lifecycle-partial-port.md), but
// `Appender` itself awaits the rest of that file, which is Wave 3's job.

/**
 * convertCTEntry returns an Entry struct which will do the right thing for CT Static API logs.
 *
 * This MUST NOT be used for any other purpose.
 */
export function convertCTEntry(e: ctonly.Entry): Entry {
	const r = new Entry();
	r.internal.identity = e.identity();
	r.marshalForBundle = (idx: bigint): Uint8Array => {
		r.internal.leafHash = e.merkleLeafHash(idx);
		r.internal.data = e.leafData(idx);
		return r.internal.data;
	};

	return r;
}

// TODO(gustavo): port `(*AppendOptions).WithCTLayout` from tessera/ct_only.go:60. It sets
// `entriesPath` and `bundleIDHasher` on `AppendOptions`, defined in
// tessera/append_lifecycle.go, which Wave 3 still owns. The three functions it (and
// withCTLayout below) install — ctEntriesPath, ctBundleIDHasher and ctMerkleLeafHasher —
// are all present below.

/**
 * withCTLayout instructs the underlying storage to use a Static CT API compatible scheme for layout.
 *
 * Port note: Go defines this as a method, `(*MigrationOptions).WithCTLayout`, on the type
 * `src/migrate_lifecycle.ts` declares — same Go package, cross-file method, exactly like
 * `convertCTEntry` above reaching into `src/entry.ts`'s `Entry.internal`. TypeScript
 * cannot add a method to a class from a different module without subclassing (which would
 * change `MigrationOptions`'s identity, breaking `instanceof` checks and the type `Driver`
 * lifecycle methods expect), so this is a standalone function taking the options object as
 * its argument — `withCTLayout(o)` in place of Go's chaining `o.WithCTLayout()` — mutating
 * and returning it, which preserves the fluent call site's chaining shape even though it
 * is a free function rather than a method. `o.internal.entriesPath` etc. are the same
 * `internal`-grouped fields `MigrationOptions`'s own `withAntispam` method reaches by
 * `this.internal...`; see that class's doc comment for why they are grouped this way.
 */
export function withCTLayout(o: MigrationOptions): MigrationOptions {
	o.internal.entriesPath = ctEntriesPath;
	o.internal.bundleIDHasher = ctBundleIDHasher;
	o.internal.bundleLeafHasher = ctMerkleLeafHasher;
	return o;
}

export function ctEntriesPath(n: bigint, p: number): string {
	return `tile/data/${layout.nWithSuffix(0n, n, p)}`;
}

/**
 * ctBundleIDHasher knows how to calculate antispam identity hashes for entries in a
 * Static-CT formatted entry bundle.
 */
export function ctBundleIDHasher(bundle: Uint8Array): Uint8Array[] {
	const r: Uint8Array[] = [];
	const b = new cryptobyte.String(bundle);
	for (let i = 0; i < layout.EntryBundleWidth && !b.empty(); i++) {
		// Timestamp
		if (!b.skip(8)) {
			throw new Error(`failed to read timestamp of entry index ${i} of bundle`);
		}

		const entryType = b.readUint16();
		if (entryType === undefined) {
			throw new Error(`failed to read entry type of entry index ${i} of bundle`);
		}

		switch (entryType) {
			case 0: {
				// X509 entry
				const cert = b.readUint24LengthPrefixed();
				if (cert === undefined) {
					throw new Error(`failed to read certificate at entry index ${i} of bundle`);
				}

				// For x509 entries we hash (just) the x509 certificate for identity.
				r.push(identityHash(cert.bytes()));

				// Must continue below to consume all the remaining bytes in the entry.
				break;
			}

			case 1: {
				// Precert entry
				// IssuerKeyHash
				if (!b.skip(sha256.outputLen)) {
					throw new Error(`failed to read issuer key hash at entry index ${i} of bundle`);
				}
				if (b.readUint24LengthPrefixed() === undefined) {
					throw new Error(`failed to read precert tbs at entry index ${i} of bundle`);
				}
				break;
			}

			default:
				throw new Error(`unknown entry type at entry index ${i} of bundle`);
		}

		if (b.readUint16LengthPrefixed() === undefined) {
			throw new Error(`failed to read SCT extensions at entry index ${i} of bundle`);
		}

		if (entryType === 1) {
			const precert = b.readUint24LengthPrefixed();
			if (precert === undefined) {
				throw new Error(`failed to read precert at entry index ${i} of bundle`);
			}
			// For Precert entries we hash (just) the full precertificate for identity.
			r.push(identityHash(precert.bytes()));
		}
		if (b.readUint16LengthPrefixed() === undefined) {
			throw new Error(`failed to read chain fingerprints at entry index ${i} of bundle`);
		}
	}
	if (!b.empty()) {
		throw new Error(`unexpected ${b.length} bytes of trailing data in entry bundle`);
	}
	return r;
}

/** copyBytes copies N bytes between from and to. */
export function copyBytes(from: cryptobyte.String, to: cryptobyte.Builder, N: number): boolean {
	const b = from.readBytes(N);
	if (b === undefined) {
		return false;
	}
	to.addBytes(b);
	return true;
}

/** copyUint16LengthPrefixed copies a uint16 length and value between from and to. */
export function copyUint16LengthPrefixed(from: cryptobyte.String, to: cryptobyte.Builder): boolean {
	const b = from.readUint16LengthPrefixed();
	if (b === undefined) {
		return false;
	}
	to.addUint16LengthPrefixed((c) => {
		c.addBytes(b.bytes());
	});
	return true;
}

/** copyUint24LengthPrefixed copies a uint24 length and value between from and to. */
export function copyUint24LengthPrefixed(from: cryptobyte.String, to: cryptobyte.Builder): boolean {
	const b = from.readUint24LengthPrefixed();
	if (b === undefined) {
		return false;
	}
	to.addUint24LengthPrefixed((c) => {
		c.addBytes(b.bytes());
	});
	return true;
}

/**
 * ctMerkleLeafHasher knows how to calculate RFC6962 Merkle leaf hashes for entries in a
 * Static-CT formatted entry bundle.
 */
export function ctMerkleLeafHasher(bundle: Uint8Array): Uint8Array[] {
	const r: Uint8Array[] = [];
	const b = new cryptobyte.String(bundle);
	for (let i = 0; i < layout.EntryBundleWidth && !b.empty(); i++) {
		const preimage = new cryptobyte.Builder();
		preimage.addUint8(0 /* version = v1 */);
		preimage.addUint8(0 /* leaf_type = timestamped_entry */);

		// Timestamp
		if (!copyBytes(b, preimage, 8)) {
			throw new Error(`failed to copy timestamp of entry index ${i} of bundle`);
		}

		const entryType = b.readUint16();
		if (entryType === undefined) {
			throw new Error(`failed to read entry type of entry index ${i} of bundle`);
		}
		preimage.addUint16(entryType);

		switch (entryType) {
			case 0:
				// X509 entry
				if (!copyUint24LengthPrefixed(b, preimage)) {
					throw new Error(`failed to copy certificate at entry index ${i} of bundle`);
				}
				break;

			case 1:
				// Precert entry
				// IssuerKeyHash
				if (!copyBytes(b, preimage, sha256.outputLen)) {
					throw new Error(`failed to copy issuer key hash at entry index ${i} of bundle`);
				}

				if (!copyUint24LengthPrefixed(b, preimage)) {
					throw new Error(`failed to copy precert tbs at entry index ${i} of bundle`);
				}
				break;

			default:
				throw new Error(`unknown entry type 0x${entryType.toString(16)} at entry index ${i} of bundle`);
		}

		if (!copyUint16LengthPrefixed(b, preimage)) {
			throw new Error(`failed to copy SCT extensions at entry index ${i} of bundle`);
		}

		if (entryType === 1) {
			if (b.readUint24LengthPrefixed() === undefined) {
				throw new Error(`failed to read precert at entry index ${i} of bundle`);
			}
		}
		if (b.readUint16LengthPrefixed() === undefined) {
			throw new Error(`failed to read chain fingerprints at entry index ${i} of bundle`);
		}

		const h = DefaultHasher.hashLeaf(preimage.bytesOrPanic());
		r.push(h);
	}
	if (!b.empty()) {
		throw new Error(`unexpected ${b.length} bytes of trailing data in entry bundle`);
	}
	return r;
}
