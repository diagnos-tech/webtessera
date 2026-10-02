// Copyright 2024 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/ct_only.go @ 4a6d9f9
//
// Port note: Go declares two methods named WithCTLayout in this file, one on
// *AppendOptions and one on *MigrationOptions, both reaching the receivers' unexported
// fields from a different file of the same package. TypeScript has neither cross-file
// methods nor same-name free functions, so both receivers share the single function
// withCTLayout below, which dispatches on the receiver's class. See
// docs/decisions/0079-migrationoptions-withctlayout-is-a-function.md and
// docs/decisions/0130-ct-only-port-completed.md.
//
// The unexported helpers ctEntriesPath, ctBundleIDHasher, ctMerkleLeafHasher and the
// copy* functions are exported only so that ct_only_test.ts can reach them, since Go's
// in-package tests have no TypeScript equivalent (docs/decisions/0044-ct-only-partial-port.md).
// They are not re-exported from the package barrel.

import { sha256 } from "@noble/hashes/sha2.js";
import * as layout from "./api/layout/index.ts";
import { type Appender, AppendOptions, type IndexFuture } from "./append_lifecycle.ts";
import type * as ctonly from "./ctonly/ct.ts";
import { Entry } from "./entry.ts";
import * as cryptobyte from "./internal/gostd/cryptobyte.ts";
import { identityHash } from "./lifecycle.ts";
import { MigrationOptions } from "./migrate_lifecycle.ts";
import { DefaultHasher } from "./vendor/merkle/rfc6962/rfc6962.ts";

/**
 * newCertificateTransparencyAppender returns a function which knows how to add a CT-specific entry type to the log.
 *
 * This entry point MUST ONLY be used for CT logs participating in the CT ecosystem.
 * It should not be used as the basis for any other/new transparency application as this protocol:
 * a) embodies some techniques which are not considered to be best practice (it does this to retain backawards-compatibility with RFC6962)
 * b) is not compatible with the https://c2sp.org/tlog-tiles API which we _very strongly_ encourage you to use instead.
 *
 * Users of this MUST NOT call `add` on the underlying Appender directly.
 *
 * Returns a future, which resolves to the assigned index in the log, or throws an error.
 *
 * Port note: Go's `func(context.Context, *ctonly.Entry) IndexFuture` takes the context as its
 * first parameter; the port moves it to an optional trailing `signal`, per
 * docs/decisions/0004-errors-context-and-concurrency.md. `a.add` is read on every call, not
 * captured, because Go's `a.Add` is a field that newAppender decorates after construction.
 */
export function newCertificateTransparencyAppender(
	a: Appender,
): (e: ctonly.Entry, signal?: AbortSignal) => IndexFuture {
	return (e: ctonly.Entry, signal?: AbortSignal): IndexFuture => a.add(convertCTEntry(e), signal);
}

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

/**
 * withCTLayout instructs the underlying storage to use a Static CT API compatible scheme for layout.
 *
 * Go defines this twice, as `(*AppendOptions).WithCTLayout` and `(*MigrationOptions).WithCTLayout`.
 * Both are ported here as overloads of one function, so that the identifier mapping of
 * docs/decisions/0002-file-and-identifier-naming.md still holds (`WithCTLayout` is always
 * `withCTLayout`) and a caller writes the same thing for either options type.
 *
 * For AppendOptions it sets the entry bundle path and the antispam identity hasher. For
 * MigrationOptions it additionally sets the Merkle leaf hasher, because a migration must
 * recompute leaf hashes from the source log's bundles, which Go's AppendOptions never does.
 *
 * Because AppendOptions.withAntispam and MigrationOptions.withAntispam capture the identity
 * hasher that is current when they are called, withCTLayout must be applied before them.
 *
 * Port note: Go's methods are declared in this file but belong to types from other files of the
 * same package. TypeScript cannot add a method to a class from another module without
 * subclassing, which would change the class's identity, so this is a free function taking the
 * options as its argument and mutating and returning it, preserving the fluent shape; see
 * docs/decisions/0079-migrationoptions-withctlayout-is-a-function.md and
 * docs/decisions/0130-ct-only-port-completed.md. The fields it writes are the cross-module
 * ones documented on each class (`AppendOptions._entriesPath` and `bundleIDHasher`,
 * `MigrationOptions.internal`).
 */
export function withCTLayout(o: AppendOptions): AppendOptions;
export function withCTLayout(o: MigrationOptions): MigrationOptions;
export function withCTLayout(o: AppendOptions | MigrationOptions): AppendOptions | MigrationOptions {
	if (o instanceof AppendOptions) {
		o._entriesPath = ctEntriesPath;
		o.bundleIDHasher = ctBundleIDHasher;
		return o;
	}
	if (o instanceof MigrationOptions) {
		o.internal.entriesPath = ctEntriesPath;
		o.internal.bundleIDHasher = ctBundleIDHasher;
		o.internal.bundleLeafHasher = ctMerkleLeafHasher;
		return o;
	}
	// Unreachable for callers the overloads admit. It is reachable when two copies of this library
	// are loaded and the receiver was built by the other one, where a bare property write would
	// either fail with an unrelated TypeError or silently configure the wrong object.
	throw new Error("withCTLayout: unsupported options type");
}

/**
 * ctEntriesPath returns the Static CT API path of entry bundle n (partial width p, or zero for a
 * full bundle). Unlike the tlog-tiles layout it lives under `tile/data/` rather than `tile/entries/`.
 */
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
