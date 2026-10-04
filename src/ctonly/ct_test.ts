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

// tessera/ctonly/ct.go has no test file upstream: its output is exercised only
// indirectly, through ct_only_test.go. That is not enough for a port. Every byte
// produced here is on the wire of a public CT log, an RFC 6962 MerkleTreeLeaf or a
// c2sp.org/static-ct-api leaf, and a transposed byte in the 40-bit leaf index would
// stay invisible until a third-party monitor failed to verify an inclusion proof. The
// tests below therefore pin the exact encoding. See
// docs/decisions/0043-ctonly-entry-port.md.

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { toHex, toUTF8 } from "../internal/gostd/bytes.ts";
import { hexList, hexToBytes, loadFixture, u64, u64List } from "../testonly/fixtures.ts";
import { Entry } from "./ct.ts";

// timestamp 1234 == 0x00000000000004d2.
const timestampHex = "00000000000004d2";
// The CTExtensions of a leaf at index 5: a uint16-prefixed list holding one extension,
// whose type is leaf_index(0) and whose uint16-prefixed body is the uint40 index.
const extensionsAt5Hex = "0008" + "00" + "0005" + "0000000005";

const testCert = toUTF8("AB");
const testTBS = toUTF8("TT");
const testPrecert = toUTF8("PP");
const testIssuerKeyHash = new Uint8Array(32).fill(0xab);

describe("Entry.leafData", () => {
	it("encodes an x509 entry", () => {
		const e = new Entry({
			timestamp: 1234n,
			certificate: testCert,
		});
		expect(toHex(e.leafData(5n))).toBe(
			timestampHex +
				"0000" + // entry_type = x509_entry
				"000002" + // uint24 certificate length
				"4142" + // the certificate
				extensionsAt5Hex +
				"0000", // uint16-prefixed, empty fingerprints chain
		);
	});

	it("encodes a precert entry", () => {
		const e = new Entry({
			timestamp: 1234n,
			isPrecert: true,
			certificate: testTBS,
			precertificate: testPrecert,
			issuerKeyHash: testIssuerKeyHash,
		});
		expect(toHex(e.leafData(5n))).toBe(
			timestampHex +
				"0001" + // entry_type = precert_entry
				"ab".repeat(32) + // issuer key hash, not length-prefixed
				"000002" + // uint24 TBS length
				"5454" + // the TBS
				extensionsAt5Hex +
				"000002" + // uint24 precertificate length
				"5050" + // the precertificate
				"0000", // uint16-prefixed, empty fingerprints chain
		);
	});

	it("appends the fingerprints chain unprefixed inside its uint16 prefix", () => {
		const e = new Entry({
			timestamp: 1234n,
			certificate: testCert,
			fingerprintsChain: [new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22)],
		});
		expect(toHex(e.leafData(5n))).toBe(
			timestampHex +
				"0000" +
				"000002" +
				"4142" +
				extensionsAt5Hex +
				"0040" + // 2 * 32 bytes
				"11".repeat(32) +
				"22".repeat(32),
		);
	});
});

describe("Entry.merkleTreeLeaf", () => {
	it("encodes an x509 entry", () => {
		const e = new Entry({
			timestamp: 1234n,
			certificate: testCert,
			// The fingerprints chain is part of the entry bundle but NOT of the
			// MerkleTreeLeaf, so it must not appear below.
			fingerprintsChain: [new Uint8Array(32).fill(0x11)],
		});
		expect(toHex(e.merkleTreeLeaf(5n))).toBe(
			"00" + // version = v1
				"00" + // leaf_type = timestamped_entry
				timestampHex +
				"0000" + // entry_type = x509_entry
				"000002" +
				"4142" +
				extensionsAt5Hex,
		);
	});

	it("encodes a precert entry", () => {
		const e = new Entry({
			timestamp: 1234n,
			isPrecert: true,
			certificate: testTBS,
			precertificate: testPrecert,
			issuerKeyHash: testIssuerKeyHash,
		});
		// The precertificate itself is not committed to by the MerkleTreeLeaf either.
		expect(toHex(e.merkleTreeLeaf(5n))).toBe(
			"00" + "00" + timestampHex + "0001" + "ab".repeat(32) + "000002" + "5454" + extensionsAt5Hex,
		);
	});
});

describe("Entry.merkleLeafHash", () => {
	it("is the RFC 6962 leaf hash of the MerkleTreeLeaf", () => {
		const e = new Entry({
			timestamp: 1234n,
			certificate: testCert,
		});
		const leaf = e.merkleTreeLeaf(7n);
		const want = sha256(Uint8Array.from([0, ...leaf]));
		expect(toHex(e.merkleLeafHash(7n))).toBe(toHex(want));
	});
});

describe("Entry.identity", () => {
	it("hashes the certificate for an x509 entry", () => {
		const e = new Entry({ certificate: testCert, precertificate: testPrecert });
		expect(toHex(e.identity())).toBe(toHex(sha256(testCert)));
	});

	it("hashes the precertificate for a precert entry", () => {
		const e = new Entry({ isPrecert: true, certificate: testTBS, precertificate: testPrecert });
		expect(toHex(e.identity())).toBe(toHex(sha256(testPrecert)));
	});
});

describe("the leaf index extension", () => {
	// addUint40 writes a big-endian, 40-bit value. Every case below would still pass
	// with a little-endian or a differently sized encoding if it used only small
	// indices, so each byte position carries a distinct value.
	const cases: { leafIndex: bigint; want: string }[] = [
		{ leafIndex: 0n, want: "0000000000" },
		{ leafIndex: 1n, want: "0000000001" },
		{ leafIndex: 0x0102030405n, want: "0102030405" },
		{ leafIndex: 0xffn, want: "00000000ff" },
		{ leafIndex: 0x100n, want: "0000000100" },
		{ leafIndex: 0xffffffffn, want: "00ffffffff" },
		{ leafIndex: 0x100000000n, want: "0100000000" },
		{ leafIndex: (1n << 40n) - 1n, want: "ffffffffff" },
	];

	for (const c of cases) {
		it(`encodes index ${c.leafIndex} as a big-endian uint40`, () => {
			const e = new Entry({ certificate: testCert });
			const got = toHex(e.merkleTreeLeaf(c.leafIndex));
			expect(got).toBe("00" + "00" + "0000000000000000" + "0000" + "000002" + "4142" + "0008" + "00" + "0005" + c.want);
		});
	}

	it("rejects a leaf index that does not fit in 40 bits", () => {
		const e = new Entry({ certificate: testCert });
		expect(() => e.merkleTreeLeaf(1n << 40n)).toThrowError("leaf_index out of range");
		expect(() => e.leafData(1n << 40n)).toThrowError("leaf_index out of range");
	});
});

// ctEntryCase mirrors the struct fixtures/gen/ctonly.go emits.
interface CTEntryCase {
	readonly desc: string;
	readonly timestamp: string;
	readonly isPrecert: boolean;
	readonly certificate: string;
	readonly precertificate: string;
	readonly issuerKeyHash: string;
	readonly fingerprintsChain: readonly string[];
	readonly index: string;
	readonly leafData: string;
	readonly merkleTreeLeaf: string;
	readonly merkleLeafHash: string;
	readonly identity: string;
}

interface CTOnlyFixture {
	readonly leafIndexLimit: string;
	readonly cases: readonly CTEntryCase[];
	readonly panicIndices: readonly string[];
}

const fixture = await loadFixture<CTOnlyFixture>("ctonly");

// entryFor rebuilds a fixture case's ctonly.Entry from the recorded input fields.
function entryFor(c: CTEntryCase): Entry {
	return new Entry({
		timestamp: u64(c.timestamp),
		isPrecert: c.isPrecert,
		certificate: hexToBytes(c.certificate),
		precertificate: hexToBytes(c.precertificate),
		issuerKeyHash: hexToBytes(c.issuerKeyHash),
		fingerprintsChain: hexList(c.fingerprintsChain),
	});
}

describe("ctonly golden fixtures", () => {
	fixture.cases.forEach((c, n) => {
		it(`case ${n}: ${c.desc} at index ${c.index}`, () => {
			const e = entryFor(c);
			const idx = u64(c.index);
			expect(toHex(e.leafData(idx))).toBe(c.leafData);
			expect(toHex(e.merkleTreeLeaf(idx))).toBe(c.merkleTreeLeaf);
			expect(toHex(e.merkleLeafHash(idx))).toBe(c.merkleLeafHash);
			expect(toHex(e.identity())).toBe(c.identity);
		});
	});

	it("rejects every index Go rejects", () => {
		expect(u64(fixture.leafIndexLimit)).toBe(1n << 40n);
		const first = fixture.cases[0];
		if (first === undefined) {
			throw new Error("the ctonly fixture has no cases");
		}
		const e = entryFor(first);
		for (const idx of u64List(fixture.panicIndices)) {
			expect(() => e.leafData(idx), `index ${idx}`).toThrowError("leaf_index out of range");
			expect(() => e.merkleTreeLeaf(idx), `index ${idx}`).toThrowError("leaf_index out of range");
		}
	});
});

// Port addition: Go's [][32]byte cannot hold a fingerprint of another length; the port refuses
// one rather than write a bundle entry no parser can split (docs/decisions/0043).
describe("Entry.leafData refuses a fingerprint that is not 32 bytes", () => {
	for (const n of [0, 31, 33]) {
		it(`${n} bytes`, () => {
			const e = new Entry({ certificate: toUTF8("cert"), fingerprintsChain: [new Uint8Array(32), new Uint8Array(n)] });
			expect(() => e.leafData(0n)).toThrow(`ctonly: fingerprintsChain[1] is ${n} bytes, want 32`);
		});
	}
	it("accepts 32-byte fingerprints", () => {
		const e = new Entry({ certificate: toUTF8("cert"), fingerprintsChain: [new Uint8Array(32).fill(7)] });
		expect(e.leafData(0n).subarray(-34)).toEqual(Uint8Array.of(0, 32, ...new Uint8Array(32).fill(7)));
	});
});
