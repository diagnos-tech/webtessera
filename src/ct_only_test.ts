// Copyright 2024 Google LLC. All Rights Reserved.
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
// Ported from tessera/ct_only_test.go @ 4a6d9f9

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { convertCTEntry, ctBundleIDHasher, ctEntriesPath, ctMerkleLeafHasher, withCTLayout } from "./ct_only.ts";
import { Entry } from "./ctonly/ct.ts";
import { Entry as RootEntry } from "./entry.ts";
import { concatBytes, toHex, toUTF8 } from "./internal/gostd/bytes.ts";
import { newMigrationOptions } from "./migrate_lifecycle.ts";
import { hexToBytes, loadFixture } from "./testonly/fixtures.ts";

describe("TestCTEntriesPath", () => {
	const tests: { N: bigint; p: number; wantPath: string }[] = [
		{
			N: 0n,
			p: 0,
			wantPath: "tile/data/000",
		},
		{
			N: 0n,
			p: 8,
			wantPath: "tile/data/000.p/8",
		},
		{
			N: 255n,
			p: 0,
			wantPath: "tile/data/255",
		},
		{
			N: 255n,
			p: 253,
			wantPath: "tile/data/255.p/253",
		},
		{
			N: 256n,
			p: 0,
			wantPath: "tile/data/256",
		},
		{
			N: 123456789000n,
			p: 0,
			wantPath: "tile/data/x123/x456/x789/000",
		},
	];

	for (const test of tests) {
		it(`N ${test.N}`, () => {
			const gotPath = ctEntriesPath(test.N, test.p);
			expect(gotPath).toBe(test.wantPath);
		});
	}
});

const testCert = toUTF8("I am a Certificate");
const testPrecert = toUTF8("I am a Precertificate");
const testPrecertTBS = toUTF8("I am a Precertificate TBS");
const testIssuerKeyHash = sha256(toUTF8("I'm an IssuerKey"));
const testFingerprintsChain = [sha256(toUTF8("one")), sha256(toUTF8("two"))];

// The three entry shapes the tests below build bundles from. Go writes these inline as
// composite literals; they are hoisted here only because both tests use the same set.
const singleCertificate = (): Entry[] => [
	new Entry({
		timestamp: 1234n,
		isPrecert: false,
		certificate: testCert,
		fingerprintsChain: testFingerprintsChain,
	}),
];

const singlePrecertificate = (): Entry[] => [
	new Entry({
		timestamp: 1234n,
		isPrecert: true,
		certificate: testPrecertTBS,
		precertificate: testPrecert,
		issuerKeyHash: testIssuerKeyHash,
		fingerprintsChain: testFingerprintsChain,
	}),
];

const mixedBag = (): Entry[] => [...singlePrecertificate(), ...singleCertificate()];

describe("TestCTIdentityHasher", () => {
	const tests: { name: string; entries: Entry[] }[] = [
		{
			name: "Single Certificate",
			entries: singleCertificate(),
		},
		{
			name: "Single Preertificate",
			entries: singlePrecertificate(),
		},
		{
			name: "Mixed bag",
			entries: mixedBag(),
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			let bundle: Uint8Array = new Uint8Array(0);
			const wantIDs: Uint8Array[] = [];
			for (const e of test.entries) {
				bundle = concatBytes(bundle, e.leafData(123n));
				wantIDs.push(e.identity());
			}

			const gotIDs = ctBundleIDHasher(bundle);
			expect(gotIDs.length).toBe(wantIDs.length);
			expect(gotIDs.map(toHex)).toEqual(wantIDs.map(toHex));
		});
	}
});

describe("TestCTMerkleLeafHasher", () => {
	const tests: { name: string; entries: Entry[] }[] = [
		{
			name: "Single Certificate",
			entries: singleCertificate(),
		},
		{
			name: "Single Preertificate",
			entries: singlePrecertificate(),
		},
		{
			name: "Mixed bag",
			entries: mixedBag(),
		},
	];

	for (const test of tests) {
		it(test.name, () => {
			let bundle: Uint8Array = new Uint8Array(0);
			const wantIDs: Uint8Array[] = [];
			for (const e of test.entries) {
				bundle = concatBytes(bundle, e.leafData(123n));
				wantIDs.push(e.merkleLeafHash(123n));
			}

			const gotIDs = ctMerkleLeafHasher(bundle);
			expect(gotIDs.length).toBe(wantIDs.length);
			expect(gotIDs.map(toHex)).toEqual(wantIDs.map(toHex));
		});
	}
});

// The tests below have no upstream counterpart. ct_only.go's bundle parsers report
// every malformed input with a distinct message, and none of those paths is reachable
// from the upstream tests; they are the ones a mis-ported length prefix would hit first.

describe("bundle parser errors", () => {
	const goodBundle = (): Uint8Array => concatBytes(...singleCertificate().map((e) => e.leafData(123n)));

	it("rejects trailing data after a full bundle", () => {
		// The trailing-data check is only reachable once the loop has consumed
		// EntryBundleWidth entries; before that, extra bytes are read as the start of the
		// next entry and fail there instead.
		const entry = goodBundle();
		const full: Uint8Array[] = [];
		for (let i = 0; i < 256; i++) {
			full.push(entry);
		}
		expect(ctBundleIDHasher(concatBytes(...full)).length).toBe(256);
		expect(ctMerkleLeafHasher(concatBytes(...full)).length).toBe(256);

		const bundle = concatBytes(...full, Uint8Array.of(0xff, 0xff));
		expect(() => ctBundleIDHasher(bundle)).toThrowError("unexpected 2 bytes of trailing data in entry bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError("unexpected 2 bytes of trailing data in entry bundle");
	});

	it("reports a partial entry that follows a complete one", () => {
		const bundle = concatBytes(goodBundle(), Uint8Array.of(0xff, 0xff));
		expect(() => ctBundleIDHasher(bundle)).toThrowError("failed to read timestamp of entry index 1 of bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError("failed to copy timestamp of entry index 1 of bundle");
	});

	it("rejects a truncated timestamp", () => {
		const bundle = goodBundle().subarray(0, 4);
		expect(() => ctBundleIDHasher(bundle)).toThrowError("failed to read timestamp of entry index 0 of bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError("failed to copy timestamp of entry index 0 of bundle");
	});

	it("rejects a truncated entry type", () => {
		const bundle = goodBundle().subarray(0, 9);
		expect(() => ctBundleIDHasher(bundle)).toThrowError("failed to read entry type of entry index 0 of bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError("failed to read entry type of entry index 0 of bundle");
	});

	it("rejects an unknown entry type", () => {
		const bundle = Uint8Array.from(goodBundle());
		// The entry type is the big-endian uint16 immediately after the 8-byte timestamp.
		bundle[9] = 2;
		expect(() => ctBundleIDHasher(bundle)).toThrowError("unknown entry type at entry index 0 of bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError("unknown entry type 0x2 at entry index 0 of bundle");
	});

	it("rejects a truncated certificate", () => {
		const bundle = goodBundle().subarray(0, 14);
		expect(() => ctBundleIDHasher(bundle)).toThrowError("failed to read certificate at entry index 0 of bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError("failed to copy certificate at entry index 0 of bundle");
	});

	it("rejects truncated SCT extensions", () => {
		const good = goodBundle();
		// 8 timestamp + 2 entry type + 3 length prefix + the certificate itself.
		const bundle = good.subarray(0, 13 + testCert.length + 1);
		expect(() => ctBundleIDHasher(bundle)).toThrowError("failed to read SCT extensions at entry index 0 of bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError("failed to copy SCT extensions at entry index 0 of bundle");
	});

	it("rejects a truncated chain fingerprints list", () => {
		const good = goodBundle();
		const bundle = good.subarray(0, good.length - 1);
		expect(() => ctBundleIDHasher(bundle)).toThrowError("failed to read chain fingerprints at entry index 0 of bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError(
			"failed to read chain fingerprints at entry index 0 of bundle",
		);
	});

	it("rejects a truncated precertificate", () => {
		const good = concatBytes(...singlePrecertificate().map((e) => e.leafData(123n)));
		const bundle = good.subarray(0, good.length - (2 + 32 * testFingerprintsChain.length) - 1);
		expect(() => ctBundleIDHasher(bundle)).toThrowError("failed to read precert at entry index 0 of bundle");
		expect(() => ctMerkleLeafHasher(bundle)).toThrowError("failed to read precert at entry index 0 of bundle");
	});

	it("returns nothing for an empty bundle", () => {
		expect(ctBundleIDHasher(new Uint8Array(0))).toEqual([]);
		expect(ctMerkleLeafHasher(new Uint8Array(0))).toEqual([]);
	});
});

// ctEntryCase mirrors the struct fixtures/gen/ctonly.go emits. The bundle parsers below
// are fed entry bundles assembled from Go-produced leaf data, and must reproduce the
// leaf hashes and identity hashes Go recorded alongside it.
interface CTEntryCase {
	readonly desc: string;
	readonly index: string;
	readonly leafData: string;
	readonly merkleLeafHash: string;
	readonly identity: string;
}

interface CTOnlyFixture {
	readonly cases: readonly CTEntryCase[];
}

const fixture = await loadFixture<CTOnlyFixture>("ctonly");

describe("bundle parsers against golden fixtures", () => {
	it("recovers the identity hash of every fixture entry", () => {
		const bundle = concatBytes(...fixture.cases.map((c) => hexToBytes(c.leafData)));
		const got = ctBundleIDHasher(bundle);
		expect(got.map(toHex)).toEqual(fixture.cases.map((c) => c.identity));
	});

	it("recovers the Merkle leaf hash of every fixture entry", () => {
		const bundle = concatBytes(...fixture.cases.map((c) => hexToBytes(c.leafData)));
		const got = ctMerkleLeafHasher(bundle);
		expect(got.map(toHex)).toEqual(fixture.cases.map((c) => c.merkleLeafHash));
	});

	it("handles a bundle holding a single entry of each shape", () => {
		for (const c of fixture.cases) {
			const bundle = hexToBytes(c.leafData);
			expect(ctBundleIDHasher(bundle).map(toHex), c.desc).toEqual([c.identity]);
			expect(ctMerkleLeafHasher(bundle).map(toHex), c.desc).toEqual([c.merkleLeafHash]);
		}
	});
});

// convertCTEntry has no upstream test (ct_only_test.go has none), but it is no longer
// deferred — see this file's header and docs/decisions/0044-ct-only-partial-port.md — so
// its wiring is pinned here: the identity is set eagerly, and the leaf hash/data are only
// populated once marshalForBundle actually runs, mirroring the real Entry's two-phase
// construction (docs/decisions/0036-state-test-inlines-bundle-encoding.md's sibling
// entry_test.ts covers the base Entry type itself).
describe("convertCTEntry", () => {
	it("sets identity from the ctonly.Entry immediately", () => {
		const src = new Entry({ timestamp: 1234n, certificate: toUTF8("AB") });
		const got = convertCTEntry(src);
		expect(got).toBeInstanceOf(RootEntry);
		expect(got.internal.identity).toEqual(src.identity());
	});

	it("leaves leafHash/data at their zero value until marshalForBundle runs", () => {
		const src = new Entry({ timestamp: 1234n, certificate: toUTF8("AB") });
		const got = convertCTEntry(src);
		expect(got.internal.leafHash).toEqual(new Uint8Array(0));
		expect(got.internal.data).toEqual(new Uint8Array(0));
	});

	it("marshalForBundle populates leafHash/data from the ctonly.Entry at the given index, and returns data", () => {
		const src = new Entry({ timestamp: 1234n, certificate: toUTF8("AB") });
		const got = convertCTEntry(src);

		const idx = 42n;
		const returned = got.marshalForBundle(idx);

		expect(got.internal.leafHash).toEqual(src.merkleLeafHash(idx));
		expect(got.internal.data).toEqual(src.leafData(idx));
		expect(returned).toEqual(src.leafData(idx));
	});

	it("marshalBundleData both assigns the index and returns the bundle data, for a precert entry", () => {
		const src = new Entry({
			timestamp: 5678n,
			isPrecert: true,
			certificate: toUTF8("TT"),
			precertificate: toUTF8("PP"),
			issuerKeyHash: new Uint8Array(32).fill(0xab),
		});
		const got = convertCTEntry(src);

		const idx = 7n;
		const returned = got.marshalBundleData(idx);

		expect(got.index()).toBe(idx);
		expect(got.internal.leafHash).toEqual(src.merkleLeafHash(idx));
		expect(returned).toEqual(src.leafData(idx));
	});

	it("recomputes leafHash/data if marshalForBundle is called again with a different index", () => {
		// entry.go's own doc comment: marshalForBundle _may_ be called multiple times with
		// different indices before the assignment is durable.
		const src = new Entry({ timestamp: 1234n, certificate: toUTF8("AB") });
		const got = convertCTEntry(src);

		got.marshalForBundle(1n);
		const firstHash = got.internal.leafHash;
		got.marshalForBundle(2n);

		expect(got.internal.leafHash).toEqual(src.merkleLeafHash(2n));
		expect(got.internal.leafHash).not.toEqual(firstHash);
	});
});

// withCTLayout closes the TODO(gustavo) that named this file and
// docs/decisions/0044-ct-only-partial-port.md, once src/migrate_lifecycle.ts's
// MigrationOptions existed for it to configure. Go: `(*MigrationOptions).WithCTLayout`.
describe("withCTLayout", () => {
	it("installs ctEntriesPath, ctBundleIDHasher and ctMerkleLeafHasher, and returns the same options for chaining", () => {
		const o = newMigrationOptions();

		const returned = withCTLayout(o);

		expect(returned).toBe(o);
		expect(o.internal.entriesPath).toBe(ctEntriesPath);
		expect(o.internal.bundleIDHasher).toBe(ctBundleIDHasher);
		expect(o.internal.bundleLeafHasher).toBe(ctMerkleLeafHasher);
	});
});
