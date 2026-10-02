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

// Golden-fixture coverage for api/state.ts. See the header of
// api/layout/paths_fixtures_test.ts for why these live outside the Go-mirrored test
// file.
//
// These are the bytes on the wire, so this file is the real compatibility evidence for
// api/state.ts: the marshalled output and every rejection message come from running the
// upstream Go, not from restating the spec. In particular the entry-bundle cases close
// the gap ADR-0036 describes — state_test.ts inlines the bundle encoding, this asserts
// against the encoder Tessera actually ships.

import { beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, type Fixture, hexToBytes, loadFixture } from "../testonly/fixtures.ts";
import { EntryBundle, HashTile } from "./state.ts";

interface ApiHashTileFixture {
	readonly marshal: readonly { desc: string; nodes: readonly string[]; want: string }[];
	readonly unmarshal: readonly {
		desc: string;
		raw: string;
		wantNodes: readonly string[];
		wantErr: boolean;
		wantErrMsg: string;
	}[];
}

interface ApiEntryBundleFixture {
	readonly bundleEncoding: string;
	readonly cases: readonly {
		desc: string;
		raw: string;
		wantEntries: readonly string[];
		wantErr: boolean;
		wantErrMsg: string;
	}[];
}

// errorMessage runs fn and returns the message it threw, or undefined if it returned.
function errorMessage(fn: () => void): string | undefined {
	try {
		fn();
		return undefined;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

describe("golden fixtures: api_hash_tile", () => {
	let fx: Fixture<ApiHashTileFixture>;

	beforeAll(async () => {
		fx = await loadFixture<ApiHashTileFixture>("api_hash_tile");
	});

	it("marshalText", () => {
		expect(fx.marshal.length).toBeGreaterThan(0);
		for (const c of fx.marshal) {
			const tile = new HashTile(c.nodes.map(hexToBytes));
			expect(bytesToHex(tile.marshalText()), c.desc).toBe(c.want);
		}
	});

	it("unmarshalText", () => {
		expect(fx.unmarshal.length).toBeGreaterThan(0);
		for (const c of fx.unmarshal) {
			const tile = new HashTile();
			if (c.wantErr) {
				expect(
					errorMessage(() => tile.unmarshalText(hexToBytes(c.raw))),
					c.desc,
				).toBe(c.wantErrMsg);
				continue;
			}
			tile.unmarshalText(hexToBytes(c.raw));
			expect(tile.nodes.map(bytesToHex), c.desc).toEqual([...c.wantNodes]);
		}
	});

	it("round-trips every marshal case", () => {
		for (const c of fx.marshal) {
			const tile = new HashTile(c.nodes.map(hexToBytes));
			const back = new HashTile();
			back.unmarshalText(tile.marshalText());
			expect(back.nodes.map(bytesToHex), c.desc).toEqual([...c.nodes]);
		}
	});
});

describe("golden fixtures: api_entry_bundle", () => {
	let fx: Fixture<ApiEntryBundleFixture>;

	beforeAll(async () => {
		fx = await loadFixture<ApiEntryBundleFixture>("api_entry_bundle");
	});

	it("unmarshalText", () => {
		expect(fx.cases.length).toBeGreaterThan(0);
		for (const c of fx.cases) {
			const bundle = new EntryBundle();
			if (c.wantErr) {
				expect(
					errorMessage(() => bundle.unmarshalText(hexToBytes(c.raw))),
					c.desc,
				).toBe(c.wantErrMsg);
				continue;
			}
			bundle.unmarshalText(hexToBytes(c.raw));
			expect(bundle.entries.map(bytesToHex), c.desc).toEqual([...c.wantEntries]);
		}
	});
});
