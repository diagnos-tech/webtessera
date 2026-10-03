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
// Ported from tessera/entry_test.go @ 4a6d9f9

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { Entry, newEntry } from "./entry.ts";
import { toUTF8 } from "./internal/gostd/bytes.ts";
import { DefaultHasher } from "./vendor/merkle/rfc6962/rfc6962.ts";

it("TestEntryMarshalBundleDelegates", () => {
	const wantIdx = 143n;
	const wantBundle = toUTF8(`Yes ${wantIdx}`);

	const e = newEntry(toUTF8("this is data"));
	e.marshalForBundle = (gotIdx: bigint): Uint8Array => {
		expect(gotIdx, `Got idx ${gotIdx}, want ${wantIdx}`).toBe(wantIdx);
		return wantBundle;
	};

	expect(e.marshalBundleData(wantIdx)).toEqual(wantBundle);
});

// Port additions: entry_test.go only pins the delegation behaviour above, but newEntry's own
// defaults (identity, leaf hash, and the tlog-tiles bundle encoding) are real logic that the
// golden-fixture integration test in storage/internal/integrate_test.ts depends on being correct,
// so they are pinned directly here too, along with the two places the port departs from Go: the
// blank Entry's marshalForBundle, and newEntry's size limit.
describe("entry (port additions)", () => {
	describe("newEntry", () => {
		it("has no assigned index until MarshalBundleData is called", () => {
			const e = newEntry(toUTF8("data"));
			expect(e.index()).toBeUndefined();
		});

		it("returns the raw data unchanged from data()", () => {
			const data = toUTF8("hello world");
			const e = newEntry(data);
			expect(e.data()).toEqual(data);
		});

		it("computes identity as sha256(data)", () => {
			const data = toUTF8("hello world");
			const e = newEntry(data);
			expect(e.identity()).toEqual(sha256(data));
		});

		it("computes leafHash as the RFC6962 leaf hash of data", () => {
			const data = toUTF8("hello world");
			const e = newEntry(data);
			expect(e.leafHash()).toEqual(DefaultHasher.hashLeaf(data));
		});

		it("marshals the default bundle encoding as a big-endian uint16 length prefix followed by data", () => {
			const data = toUTF8("hello world");
			const e = newEntry(data);
			const got = e.marshalBundleData(0n);
			expect(got[0]).toBe(0);
			expect(got[1]).toBe(data.length);
			expect(got.slice(2)).toEqual(data);
		});

		it("sets the index as a side effect of MarshalBundleData", () => {
			const e = newEntry(toUTF8("data"));
			e.marshalBundleData(7n);
			expect(e.index()).toBe(7n);
		});

		// docs/decisions/0182-newentry-rejects-entries-over-65535-bytes.md
		it("accepts the largest entry a uint16 length prefix can describe", () => {
			const data = new Uint8Array(0xffff).fill(1);
			const got = newEntry(data).marshalBundleData(0n);
			expect(got[0]).toBe(0xff);
			expect(got[1]).toBe(0xff);
			expect(got.length).toBe(2 + 0xffff);
		});

		it("rejects an entry longer than a uint16 length prefix can describe", () => {
			expect(() => newEntry(new Uint8Array(0x10000))).toThrow(
				"entry data is 65536 bytes, more than the 65535 a tlog-tiles entry bundle can hold",
			);
		});
	});

	describe("Entry", () => {
		it("throws from marshalBundleData when marshalForBundle was never set, as Go's nil func call panics", () => {
			const e = new Entry();
			expect(() => e.marshalBundleData(3n)).toThrow("Entry.marshalForBundle is nil: construct entries with newEntry");
		});
	});
});
