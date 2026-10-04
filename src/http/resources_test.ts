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

import { describe, expect, it } from "vitest";
import { trimToWidth } from "./partial.ts";
import { DefaultCacheControl, type LogResource, parseLogPath, resourceHeaders, resourcePath } from "./resources.ts";

describe("parseLogPath", () => {
	const valid: { path: string; want: LogResource }[] = [
		{ path: "checkpoint", want: { kind: "checkpoint" } },
		{ path: "tile/0/000", want: { kind: "tile", level: 0n, index: 0n, width: 0 } },
		{ path: "tile/0/x001/x234/067", want: { kind: "tile", level: 0n, index: 1234067n, width: 0 } },
		{ path: "tile/63/999.p/255", want: { kind: "tile", level: 63n, index: 999n, width: 255 } },
		{ path: "tile/1/000.p/1", want: { kind: "tile", level: 1n, index: 0n, width: 1 } },
		{ path: "tile/entries/000", want: { kind: "entries", index: 0n, width: 0 } },
		{ path: "tile/entries/x001/234.p/7", want: { kind: "entries", index: 1234n, width: 7 } },
	];
	for (const { path, want } of valid) {
		it(`parses ${path}`, () => {
			expect(parseLogPath(path)).toEqual(want);
			expect(resourcePath(want)).toBe(path);
		});
	}

	// Each of these is inside the tlog-tiles namespace but is not the URL of a resource.
	const malformed: { path: string; reason: RegExp }[] = [
		{ path: "tile/64/000", reason: /tile level/ },
		{ path: "tile/-1/000", reason: /tile level/ },
		{ path: "tile/0/0000", reason: /tile index/ },
		{ path: "tile/0/1", reason: /tile index/ },
		{ path: "tile/0/000.p/0", reason: /tile width/ },
		{ path: "tile/0/000.p/256", reason: /tile width/ },
		{ path: "tile/0", reason: /expected tile/ },
		{ path: "tile/", reason: /expected tile/ },
		{ path: "tile/entries/abc", reason: /tile index/ },
		// Accepted by the upstream parsers, but not the spec's spelling of the resource.
		{ path: "tile/00/000", reason: /canonical encoding of this resource, which is tile\/0\/000/ },
		{ path: "tile/0/x000/001", reason: /which is tile\/0\/001$/ },
		{ path: "tile/0/000.p/08", reason: /which is tile\/0\/000\.p\/8$/ },
		{ path: "tile/entries/x000/x000/005", reason: /which is tile\/entries\/005$/ },
		{ path: `tile/0/${"x000/".repeat(30)}000`, reason: /longer than 96 characters/ },
		{ path: `tile/${"9".repeat(10000)}/000`, reason: /longer than 96 characters/ },
	];
	for (const { path, reason } of malformed) {
		it(`rejects ${path}`, () => {
			const got = parseLogPath(path);
			expect(got?.kind).toBe("malformed");
			expect(got?.kind === "malformed" ? got.reason : "").toMatch(reason);
		});
	}

	for (const path of ["", "/checkpoint", "checkpoint/", "checkpoints", "add", "tiles/0/000", "entries/000"]) {
		it(`leaves ${JSON.stringify(path)} to other handlers`, () => {
			expect(parseLogPath(path)).toBeUndefined();
		});
	}
});

it("accepts the longest resource paths", () => {
	const longest = "tile/entries/x018/x446/x744/x073/x709/x551/615.p/255";
	expect(longest.length).toBe(52);
	expect(parseLogPath(longest)).toEqual({ kind: "entries", index: 18446744073709551615n, width: 255 });
	const longestTile = "tile/63/x018/x446/x744/x073/x709/x551/615.p/255";
	expect(longestTile.length).toBe(47);
	expect(parseLogPath(longestTile)).toEqual({ kind: "tile", level: 63n, index: 18446744073709551615n, width: 255 });
});

describe("resourceHeaders", () => {
	it("gives the checkpoint text/plain and no-cache", () => {
		const h = resourceHeaders("checkpoint");
		expect(h?.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(h?.get("Cache-Control")).toBe("no-cache");
	});

	it("gives full tiles and bundles a year's immutable caching", () => {
		for (const p of ["tile/0/000", "tile/entries/x001/000"]) {
			const h = resourceHeaders(p);
			expect(h?.get("Content-Type")).toBe("application/octet-stream");
			expect(h?.get("Cache-Control")).toBe(DefaultCacheControl.full);
		}
	});

	it("gives partial tiles and bundles short caching", () => {
		for (const p of ["tile/2/000.p/3", "tile/entries/000.p/1"]) {
			expect(resourceHeaders(p)?.get("Cache-Control")).toBe("public, max-age=60");
		}
	});

	it("honours a custom policy and ignores other paths", () => {
		const policy = { checkpoint: "max-age=5", full: "max-age=1", partial: "max-age=2" };
		expect(resourceHeaders("checkpoint", policy)?.get("Cache-Control")).toBe("max-age=5");
		expect(resourceHeaders(".state/treeState")).toBeUndefined();
		expect(resourceHeaders("tile/0/0")).toBeUndefined();
	});
});

describe("trimToWidth", () => {
	const fullTile = new Uint8Array(256 * 32).map((_, i) => i & 0xff);

	it("cuts a full tile served for a partial down to the partial's hashes", () => {
		const got = trimToWidth({ kind: "tile", level: 0n, index: 0n, width: 5 }, fullTile);
		expect(got).toEqual(fullTile.subarray(0, 5 * 32));
	});

	it("leaves full and already-exact resources alone", () => {
		expect(trimToWidth({ kind: "tile", level: 0n, index: 0n, width: 0 }, fullTile)).toBe(fullTile);
		const exact = fullTile.subarray(0, 64);
		expect(trimToWidth({ kind: "tile", level: 0n, index: 0n, width: 2 }, exact)).toBe(exact);
	});

	it("leaves a tile that is not a whole number of hashes alone", () => {
		const odd = new Uint8Array(100);
		expect(trimToWidth({ kind: "tile", level: 0n, index: 0n, width: 1 }, odd)).toBe(odd);
	});

	it("cuts an entry bundle down to the partial's entries", () => {
		// Three entries of lengths 1, 2 and 0.
		const bundle = new Uint8Array([0, 1, 0xaa, 0, 2, 0xbb, 0xcc, 0, 0]);
		expect(trimToWidth({ kind: "entries", index: 0n, width: 2 }, bundle)).toEqual(bundle.subarray(0, 7));
		expect(trimToWidth({ kind: "entries", index: 0n, width: 3 }, bundle)).toBe(bundle);
		expect(trimToWidth({ kind: "entries", index: 0n, width: 4 }, bundle)).toBe(bundle);
	});

	it("leaves a bundle whose length prefixes overrun it alone", () => {
		const bad = new Uint8Array([0, 9, 1, 2]);
		expect(trimToWidth({ kind: "entries", index: 0n, width: 1 }, bad)).toBe(bad);
	});
});
