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

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import { bytesToHex, bytesToText, hexList, hexToBytes, loadFixture, textToBytes, u64, u64List } from "./fixtures.ts";

// These tests exercise the loader against real fixture files, and in doing so
// independently re-derive some of the fixture values from @noble/hashes. That
// second part matters: it proves the loader is decoding the bytes the Go
// generator meant, not merely that it can parse JSON.

interface RFC6962Fixture {
	readonly leafHashPrefix: number;
	readonly nodeHashPrefix: number;
	readonly hashSize: number;
	readonly emptyRoot: string;
	readonly hashLeaf: readonly { readonly desc: string; readonly leaf: string; readonly want: string }[];
	readonly hashChildren: readonly {
		readonly desc: string;
		readonly left: string;
		readonly right: string;
		readonly want: string;
	}[];
}

interface LayoutPathsFixture {
	readonly checkpointPath: string;
	readonly nWithSuffix: readonly {
		readonly level: string;
		readonly index: string;
		readonly p: number;
		readonly want: string;
	}[];
}

interface LogFixture {
	readonly origin: string;
	readonly size: string;
	readonly checkpoint: string;
	readonly checkpointText: string;
	readonly checkpointSize: string;
	readonly checkpointHash: string;
	readonly tiles: readonly {
		readonly path: string;
		readonly raw: string;
		readonly level: string;
		readonly index: string;
		readonly partial: number;
		readonly nodes: number;
	}[];
	readonly entryBundles: readonly {
		readonly path: string;
		readonly raw: string;
		readonly entries: number;
	}[];
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

describe("hexToBytes / bytesToHex", () => {
	it("round-trips", () => {
		expect(hexToBytes("")).toEqual(new Uint8Array());
		expect(hexToBytes("00")).toEqual(new Uint8Array([0]));
		expect(hexToBytes("00ff7f")).toEqual(new Uint8Array([0x00, 0xff, 0x7f]));
		expect(bytesToHex(new Uint8Array([0x00, 0xff, 0x7f]))).toBe("00ff7f");
		expect(bytesToHex(new Uint8Array())).toBe("");
	});

	it("rejects malformed hex", () => {
		expect(() => hexToBytes("0")).toThrow(/invalid fixture hex/);
		expect(() => hexToBytes("0g")).toThrow(/invalid fixture hex/);
		// Upper case is rejected on purpose: the fixtures are specified as
		// lower-case, so anything else means the file was not written by the
		// generator.
		expect(() => hexToBytes("00FF")).toThrow(/invalid fixture hex/);
		expect(() => hexToBytes("0x00")).toThrow(/invalid fixture hex/);
	});

	it("decodes lists", () => {
		expect(hexList(["00", "ff"])).toEqual([new Uint8Array([0]), new Uint8Array([255])]);
		expect(hexList([])).toEqual([]);
	});
});

describe("u64", () => {
	it("decodes without precision loss above 2^53", () => {
		expect(u64("0")).toBe(0n);
		expect(u64("1")).toBe(1n);
		expect(u64("9007199254740993")).toBe(9007199254740993n);
		expect(u64("18446744073709551615")).toBe(18446744073709551615n);
	});

	it("rejects anything that is not an unsigned decimal in range", () => {
		expect(() => u64("")).toThrow(/invalid fixture uint64/);
		expect(() => u64("-1")).toThrow(/invalid fixture uint64/);
		expect(() => u64("007")).toThrow(/invalid fixture uint64/);
		expect(() => u64("1.0")).toThrow(/invalid fixture uint64/);
		expect(() => u64("0x10")).toThrow(/invalid fixture uint64/);
		expect(() => u64("18446744073709551616")).toThrow(/exceeds 2\^64-1/);
	});

	it("decodes lists", () => {
		expect(u64List(["0", "18446744073709551615"])).toEqual([0n, 18446744073709551615n]);
	});
});

describe("loadFixture", () => {
	it("rejects names that are not fixture basenames", async () => {
		await expect(loadFixture("../secrets")).rejects.toThrow(/invalid fixture name/);
		await expect(loadFixture("Layout")).rejects.toThrow(/invalid fixture name/);
	});

	it("reports a missing fixture clearly", async () => {
		await expect(loadFixture("no_such_fixture")).rejects.toThrow(/failed to load fixture/);
	});

	it("exposes the header", async () => {
		const f = await loadFixture<RFC6962Fixture>("rfc6962");
		expect(f.commit).toBe("4a6d9f9");
		expect(f.upstream).toBe("github.com/transparency-dev/merkle/rfc6962");
		expect(f.description).toContain("RFC6962");
	});

	it("returns the same object on repeated loads", async () => {
		const a = await loadFixture<RFC6962Fixture>("rfc6962");
		const b = await loadFixture<RFC6962Fixture>("rfc6962");
		expect(a).toBe(b);
	});
});

describe("rfc6962 fixture", () => {
	it("agrees with an independent SHA-256 implementation", async () => {
		const f = await loadFixture<RFC6962Fixture>("rfc6962");

		expect(f.hashSize).toBe(32);
		expect(f.leafHashPrefix).toBe(0);
		expect(f.nodeHashPrefix).toBe(1);

		const emptyRoot = hexToBytes(f.emptyRoot);
		expect(emptyRoot).toHaveLength(32);
		expect(emptyRoot).toEqual(sha256(new Uint8Array()));

		expect(f.hashLeaf.length).toBeGreaterThan(20);
		for (const tc of f.hashLeaf) {
			const got = sha256(concat(new Uint8Array([f.leafHashPrefix]), hexToBytes(tc.leaf)));
			expect(bytesToHex(got), tc.desc).toBe(tc.want);
		}

		expect(f.hashChildren.length).toBeGreaterThan(5);
		for (const tc of f.hashChildren) {
			const got = sha256(concat(new Uint8Array([f.nodeHashPrefix]), hexToBytes(tc.left), hexToBytes(tc.right)));
			expect(bytesToHex(got), tc.desc).toBe(tc.want);
		}
	});
});

describe("layout_paths fixture", () => {
	it("carries uint64 indices as strings that survive the round trip", async () => {
		const f = await loadFixture<LayoutPathsFixture>("layout_paths");
		expect(f.checkpointPath).toBe("checkpoint");

		const maxCase = f.nWithSuffix.find((c) => c.index === "18446744073709551615" && c.p === 0);
		expect(maxCase).toBeDefined();
		expect(u64(maxCase!.index)).toBe(18446744073709551615n);
		// The tlog-tiles path encoding groups the decimal digits in threes, so the
		// rendered path is a direct readout of the index. If the fixture had gone
		// through a JSON number it would read x018/x446/x744/x073/x709/x551/616.
		expect(maxCase!.want).toBe("x018/x446/x744/x073/x709/x551/615");
	});
});

describe("log_1 fixture", () => {
	it("decodes a real log's checkpoint, tile and entry bundle", async () => {
		const f = await loadFixture<LogFixture>("log_1");

		expect(u64(f.size)).toBe(1n);
		expect(u64(f.checkpointSize)).toBe(1n);
		expect(bytesToText(hexToBytes(f.checkpoint))).toBe(f.checkpointText);
		expect(textToBytes(f.checkpointText)).toEqual(hexToBytes(f.checkpoint));
		expect(f.checkpointText.startsWith(`${f.origin}\n1\n`)).toBe(true);

		// A one-entry log has exactly one tile and one entry bundle, both partial.
		expect(f.tiles).toHaveLength(1);
		const tile = f.tiles[0]!;
		expect(tile.path).toBe("tile/0/000.p/1");
		expect(u64(tile.level)).toBe(0n);
		expect(u64(tile.index)).toBe(0n);
		expect(tile.partial).toBe(1);
		expect(hexToBytes(tile.raw)).toHaveLength(32);

		expect(f.entryBundles).toHaveLength(1);
		const bundle = f.entryBundles[0]!;
		expect(bundle.path).toBe("tile/entries/000.p/1");
		expect(bundle.entries).toBe(1);
		const raw = hexToBytes(bundle.raw);
		// uint16 big-endian length prefix, then the entry itself.
		expect((raw[0]! << 8) | raw[1]!).toBe(raw.length - 2);
		expect(bytesToText(raw.subarray(2))).toBe("entry-0");

		// The single leaf's RFC6962 hash is both the tile's only node and the
		// tree's root, so the checkpoint hash must equal it.
		const leafHash = sha256(concat(new Uint8Array([0]), textToBytes("entry-0")));
		expect(bytesToHex(leafHash)).toBe(tile.raw);
		expect(bytesToHex(leafHash)).toBe(f.checkpointHash);
	});
});
