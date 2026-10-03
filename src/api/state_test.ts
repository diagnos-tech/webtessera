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
// Ported from tessera/api/state_test.go @ 4a6d9f9

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { appendUint16BE, bytesEqual, concatBytes } from "../internal/gostd/bytes.ts";
import { EntryBundle, HashTile } from "./state.ts";

// marshalBundleData renders data the way an entry is laid out inside an EntryBundle
// by https://c2sp.org/tlog-tiles: a big-endian uint16 length prefix, then the data.
//
// Port note: upstream's test calls `tessera.NewEntry(data).MarshalBundleData(i)` from
// the root package. Go tolerates that upward dependency because `api_test` is a separate
// external test package; TypeScript's module graph has no equivalent, so importing it
// would make `src/api` depend on the root. Instead the test inlines the same two lines of
// encoding that `NewEntry`'s default `marshalForBundle` performs. See
// docs/decisions/0036-state-test-inlines-bundle-encoding.md.
function marshalBundleData(data: Uint8Array): Uint8Array {
	return concatBytes(appendUint16BE(new Uint8Array(0), data.length), data);
}

// randRead fills b with cryptographically random bytes, standing in for `rand.Read`.
function randRead(b: Uint8Array): void {
	if (b.length === 0) {
		return;
	}
	crypto.getRandomValues(b);
}

describe("TestHashTile_MarshalTileRoundtrip", () => {
	const tests: { size: number }[] = [
		{
			size: 1,
		},
		{
			size: 255,
		},
		{
			size: 11,
		},
		{
			size: 42,
		},
	];

	for (const test of tests) {
		it(`tile size ${test.size}`, () => {
			const tile = new HashTile([]);
			for (let i = 0; i < test.size; i++) {
				// Fill in the leaf index
				tile.nodes.push(new Uint8Array(sha256.outputLen));
				randRead(tile.nodes[i] as Uint8Array);
			}

			const raw = tile.marshalText();

			const tile2 = new HashTile();
			tile2.unmarshalText(raw);

			expect(tile2.nodes.length).toBe(tile.nodes.length);
			for (let i = 0; i < tile.nodes.length; i++) {
				expect(bytesEqual(tile2.nodes[i] as Uint8Array, tile.nodes[i] as Uint8Array)).toBe(true);
			}
		});
	}
});

describe("TestLeafBundle_MarshalTileRoundtrip", () => {
	const tests: { size: number }[] = [
		{
			size: 1,
		},
		{
			size: 255,
		},
		{
			size: 11,
		},
		{
			size: 42,
		},
	];

	for (const test of tests) {
		it(`tile size ${test.size}`, () => {
			const parts: Uint8Array[] = [];
			const want: Uint8Array[] = new Array<Uint8Array>(test.size);
			for (let i = 0; i < test.size; i++) {
				// Fill in the leaf index
				const entry = new Uint8Array(i * 100);
				randRead(entry);
				want[i] = entry;
				parts.push(marshalBundleData(entry));
			}
			const bundleRaw = concatBytes(...parts);

			const tile2 = new EntryBundle();
			tile2.unmarshalText(bundleRaw);

			for (let i = 0; i < test.size; i++) {
				const got = tile2.entries[i] as Uint8Array;
				const w = want[i] as Uint8Array;
				expect(bytesEqual(got, w)).toBe(true);
			}
		});
	}
});

describe("TestLeafBundle_UnmarshalText", () => {
	const tests: { desc: string; input: Uint8Array; wantErr: boolean }[] = [
		{
			desc: "no data",
			input: new Uint8Array([]),
			wantErr: false,
		},
		{
			desc: "insufficient data",
			input: new Uint8Array([0x0, 0x02, 0x61 /* 'a' */]),
			wantErr: true,
		},
		{
			desc: "empty nodes",
			input: new Uint8Array([0x0, 0x0, 0x0, 0x1, 0x61 /* 'a' */, 0x0, 0x0]),
			wantErr: false,
		},
		{
			desc: "insufficient integer bytes",
			input: new Uint8Array([0x1]),
			wantErr: true,
		},
	];

	for (const test of tests) {
		it(test.desc, () => {
			const tile = new EntryBundle();
			let gotErr = false;
			try {
				tile.unmarshalText(test.input);
			} catch {
				gotErr = true;
			}
			expect(gotErr).toBe(test.wantErr);
		});
	}
});

// Port addition. Upstream's table above only checks that an error was returned, but the
// rejection messages are part of what a driver reports back to a client, so the port
// pins their exact text against the format strings in api/state.go.
describe("Port addition: UnmarshalText rejection messages", () => {
	it("HashTile: length is not a multiple of the hash size", () => {
		const tile = new HashTile();
		expect(() => tile.unmarshalText(new Uint8Array(5))).toThrow("5 is not a multiple of 32");
	});

	it("EntryBundle: dangling bytes before a length prefix", () => {
		const bundle = new EntryBundle();
		expect(() => bundle.unmarshalText(new Uint8Array([0x1]))).toThrow(
			"dangling bytes at byte index 0 in data of 1 bytes",
		);
	});

	it("EntryBundle: length prefix runs past the end of the data", () => {
		const bundle = new EntryBundle();
		expect(() => bundle.unmarshalText(new Uint8Array([0x0, 0x02, 0x61]))).toThrow(
			"require 2 bytes from byte index 2, but size is 3",
		);
	});
});

// Port addition: hardening with no Go counterpart (docs/decisions/0194). The tlog-tiles
// maximum is 256 hashes per tile and 256 entries per bundle; anything beyond is rejected.
describe("Port addition: tlog-tiles maxima", () => {
	it("HashTile: accepts 256 hashes and rejects 257", () => {
		const tile = new HashTile();
		tile.unmarshalText(new Uint8Array(256 * 32));
		expect(tile.nodes).toHaveLength(256);
		expect(() => tile.unmarshalText(new Uint8Array(257 * 32))).toThrow("tile of 257 hashes exceeds the maximum of 256");
	});

	it("EntryBundle: accepts 256 entries and stops at the 257th", () => {
		const bundle = new EntryBundle();
		bundle.unmarshalText(new Uint8Array(256 * 2));
		expect(bundle.entries).toHaveLength(256);
		expect(() => bundle.unmarshalText(new Uint8Array(257 * 2))).toThrow(
			"entry bundle holds more than the maximum of 256 entries",
		);
	});
});
