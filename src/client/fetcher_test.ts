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
// There is no client/fetcher_test.go upstream (client/fetcher.go is mostly HTTP/file
// I/O plumbing that PORTING.md §4's TDD workflow has nothing to port a test *from*). Per
// the mission brief for this work package, this covers what upstream's own path-building
// logic does: HTTPFetcher.readCheckpoint/readTile/readEntryBundle resolve the exact
// tlog-tiles resource path (layout.CheckpointPath/tilePath/entriesPath, already
// exhaustively covered by paths_fixtures_test.ts) against the fetcher's root URL, apply
// the partial-then-full-resource fallback, map a 404 to ErrNotExist, and surface any
// other non-200 status or transport failure as an error. FileFetcher is not ported; see
// docs/decisions/0064-filefetcher-not-ported.md.

import { describe, expect, it } from "vitest";
import { CheckpointPath, entriesPath, tilePath } from "../api/layout/index.ts";
import { ErrNotExist, errorIs } from "../internal/gostd/errors.ts";
import { type FetchFn, HTTPFetcher, newHTTPFetcher } from "./fetcher.ts";

/** call records one invocation of a mocked FetchFn. */
interface Call {
	readonly url: string;
	readonly headers: Record<string, string>;
}

/** toArrayBuffer copies bytes into a freshly allocated, non-shared ArrayBuffer, which is what Response's constructor wants. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(bytes.length);
	new Uint8Array(buf).set(bytes);
	return buf;
}

/** mockFetch returns a FetchFn that records every call and answers from responses, keyed by exact URL. */
function mockFetch(responses: Map<string, { status: number; body?: Uint8Array }>): { fetch: FetchFn; calls: Call[] } {
	const calls: Call[] = [];
	const fetch: FetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
		const headers: Record<string, string> = {};
		if (init?.headers !== undefined) {
			for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
				headers[k] = v;
			}
		}
		calls.push({ url: input, headers });
		const r = responses.get(input);
		if (r === undefined) {
			throw new Error(`mockFetch: no response configured for ${input}`);
		}
		return new Response(toArrayBuffer(r.body ?? new Uint8Array(0)), { status: r.status });
	};
	return { fetch, calls };
}

describe("newHTTPFetcher", () => {
	it("appends a trailing slash to a root URL that lacks one", async () => {
		const { fetch, calls } = mockFetch(
			new Map([["https://log.example/root/checkpoint", { status: 200, body: new Uint8Array([1]) }]]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root"), fetch);
		await h.readCheckpoint();
		expect(calls[0]?.url).toBe("https://log.example/root/checkpoint");
	});

	it("leaves a root URL that already ends in a trailing slash unchanged", async () => {
		const { fetch, calls } = mockFetch(
			new Map([["https://log.example/root/checkpoint", { status: 200, body: new Uint8Array([1]) }]]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await h.readCheckpoint();
		expect(calls[0]?.url).toBe("https://log.example/root/checkpoint");
	});
});

describe("HTTPFetcher.readCheckpoint", () => {
	it("fetches layout.CheckpointPath relative to the root URL and returns the body", async () => {
		const want = new Uint8Array([1, 2, 3]);
		const { fetch, calls } = mockFetch(
			new Map([["https://log.example/root/" + CheckpointPath, { status: 200, body: want }]]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		const got = await h.readCheckpoint();
		expect(got).toEqual(want);
		expect(calls).toHaveLength(1);
	});

	it("throws ErrNotExist on a 404", async () => {
		const { fetch } = mockFetch(new Map([["https://log.example/root/" + CheckpointPath, { status: 404 }]]));
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		let caught: unknown;
		try {
			await h.readCheckpoint();
		} catch (err) {
			caught = err;
		}
		expect(errorIs(caught, ErrNotExist)).toBe(true);
	});

	it("throws an error naming the status code for any other non-200 response", async () => {
		const { fetch } = mockFetch(new Map([["https://log.example/root/" + CheckpointPath, { status: 500 }]]));
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await expect(h.readCheckpoint()).rejects.toThrow("500");
	});

	it("wraps a transport-level failure", async () => {
		const fetch: FetchFn = async (): Promise<Response> => {
			throw new Error("network down");
		};
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await expect(h.readCheckpoint()).rejects.toThrow("network down");
	});

	it("sends the Authorization header set via setAuthorizationHeader", async () => {
		const { fetch, calls } = mockFetch(
			new Map([["https://log.example/root/" + CheckpointPath, { status: 200, body: new Uint8Array(0) }]]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		h.setAuthorizationHeader("Bearer topsecret");
		await h.readCheckpoint();
		expect(calls[0]?.headers.Authorization).toBe("Bearer topsecret");
	});

	it("sends no Authorization header when none was set", async () => {
		const { fetch, calls } = mockFetch(
			new Map([["https://log.example/root/" + CheckpointPath, { status: 200, body: new Uint8Array(0) }]]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await h.readCheckpoint();
		expect(calls[0]?.headers.Authorization).toBeUndefined();
	});
});

describe("HTTPFetcher.readTile", () => {
	it("requests the full tile path when p is 0", async () => {
		const path = tilePath(1n, 2n, 0);
		const { fetch, calls } = mockFetch(
			new Map([[`https://log.example/root/${path}`, { status: 200, body: new Uint8Array([9]) }]]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		const got = await h.readTile(1n, 2n, 0);
		expect(got).toEqual(new Uint8Array([9]));
		expect(calls[0]?.url).toBe(`https://log.example/root/${path}`);
	});

	it("requests the partial tile path when p is non-zero", async () => {
		const path = tilePath(1n, 2n, 5);
		const { fetch, calls } = mockFetch(
			new Map([[`https://log.example/root/${path}`, { status: 200, body: new Uint8Array([9]) }]]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await h.readTile(1n, 2n, 5);
		expect(calls[0]?.url).toBe(`https://log.example/root/${path}`);
	});

	it("falls back to the full tile when the partial one 404s", async () => {
		const partialPath = tilePath(1n, 2n, 5);
		const fullPath = tilePath(1n, 2n, 0);
		const want = new Uint8Array([7, 8]);
		const { fetch, calls } = mockFetch(
			new Map([
				[`https://log.example/root/${partialPath}`, { status: 404 }],
				[`https://log.example/root/${fullPath}`, { status: 200, body: want }],
			]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		const got = await h.readTile(1n, 2n, 5);
		expect(got).toEqual(want);
		expect(calls.map((c) => c.url)).toEqual([
			`https://log.example/root/${partialPath}`,
			`https://log.example/root/${fullPath}`,
		]);
	});

	it("throws when neither the partial nor the full tile exists", async () => {
		const partialPath = tilePath(1n, 2n, 5);
		const fullPath = tilePath(1n, 2n, 0);
		const { fetch } = mockFetch(
			new Map([
				[`https://log.example/root/${partialPath}`, { status: 404 }],
				[`https://log.example/root/${fullPath}`, { status: 404 }],
			]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await expect(h.readTile(1n, 2n, 5)).rejects.toThrow();
	});
});

describe("HTTPFetcher.readEntryBundle", () => {
	it("requests the entry bundle path for the given index and partial width", async () => {
		const path = entriesPath(3n, 12);
		const want = new Uint8Array([1, 1, 1]);
		const { fetch, calls } = mockFetch(new Map([[`https://log.example/root/${path}`, { status: 200, body: want }]]));
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		const got = await h.readEntryBundle(3n, 12);
		expect(got).toEqual(want);
		expect(calls[0]?.url).toBe(`https://log.example/root/${path}`);
	});

	it("falls back to the full bundle when the partial one 404s", async () => {
		const partialPath = entriesPath(3n, 12);
		const fullPath = entriesPath(3n, 0);
		const want = new Uint8Array([2, 2, 2]);
		const { fetch } = mockFetch(
			new Map([
				[`https://log.example/root/${partialPath}`, { status: 404 }],
				[`https://log.example/root/${fullPath}`, { status: 200, body: want }],
			]),
		);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		const got = await h.readEntryBundle(3n, 12);
		expect(got).toEqual(want);
	});
});

describe("HTTPFetcher construction", () => {
	it("can be constructed directly with the HTTPFetcher class, matching Go's exported type", () => {
		// HTTPFetcher itself is exported (Go: `type HTTPFetcher struct`), even though
		// newHTTPFetcher (Go: NewHTTPFetcher) is the normal way to build one.
		const { fetch } = mockFetch(new Map());
		const h = new HTTPFetcher(fetch, new URL("https://log.example/root/"));
		expect(h).toBeInstanceOf(HTTPFetcher);
	});
});
