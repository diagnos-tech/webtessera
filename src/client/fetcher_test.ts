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
// There is no client/fetcher_test.go upstream: fetcher.go is HTTP and file I/O plumbing, which
// Tessera exercises only through its integration tests against real servers. Every test here is
// therefore a port addition. They pin what the Go code does on its own account:
// HTTPFetcher.readCheckpoint/readTile/readEntryBundle resolve the exact tlog-tiles resource
// path (layout.CheckpointPath/tilePath/entriesPath, already exhaustively covered by
// paths_fixtures_test.ts) against the fetcher's root URL, apply the partial-then-full-resource
// fallback, map a 404 to ErrNotExist, and surface any other non-200 status or transport failure
// as an error with Go's message text. A second group covers the places where the port has to
// differ because `fetch` is not `net/http`: the receiver `fetch` is called with, the global
// default, abort signals and response-body release (docs/decisions/0131-httpfetcher-fetch-runtime-fidelity.md).
// FileFetcher is not ported; see docs/decisions/0064-filefetcher-not-ported.md.

import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("error messages", () => {
	// Go formats every failure as `get(%q): ...` with the absolute URL; callers and logs grep for it.
	const checkpointURL = `https://log.example/root/${CheckpointPath}`;

	it("reports a 404 as get(<url>) wrapping file does not exist", async () => {
		const { fetch } = mockFetch(new Map([[checkpointURL, { status: 404 }]]));
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await expect(h.readCheckpoint()).rejects.toThrowError(`get("${checkpointURL}"): file does not exist`);
	});

	it("reports another status as get(<url>) followed by the status code", async () => {
		const { fetch } = mockFetch(new Map([[checkpointURL, { status: 503 }]]));
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await expect(h.readCheckpoint()).rejects.toThrowError(`get("${checkpointURL}"): 503`);
	});

	it("reports a transport failure as get(<url>) followed by the underlying message", async () => {
		const fetch: FetchFn = async (): Promise<Response> => {
			throw new Error("network down");
		};
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await expect(h.readCheckpoint()).rejects.toThrowError(`get("${checkpointURL}"): network down`);
	});
});

describe("newHTTPFetcher URL handling", () => {
	it("mutates the URL it is given when it appends the trailing slash, as Go does", () => {
		const root = new URL("https://log.example/root");
		newHTTPFetcher(root, mockFetch(new Map()).fetch);
		expect(root.pathname).toBe("/root/");
	});

	it("resolves resource paths against the root path rather than the host", async () => {
		const { fetch, calls } = mockFetch(
			new Map([["https://log.example/a/b/checkpoint", { status: 200, body: new Uint8Array(0) }]]),
		);
		await newHTTPFetcher(new URL("https://log.example/a/b"), fetch).readCheckpoint();
		expect(calls[0]?.url).toBe("https://log.example/a/b/checkpoint");
	});
});

describe("fetch runtime fidelity", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("calls the fetch function detached from the fetcher", async () => {
		// Browsers and workerd throw "Illegal invocation" when the global `fetch` is called with any
		// receiver other than the global object, and `this.#c(...)` would pass the HTTPFetcher.
		// Go's `h.c.Do(req)` is a method call on a client, which has no such constraint.
		let receiver: unknown = "not called";
		const fetch = async function (this: unknown): Promise<Response> {
			receiver = this;
			return new Response(new Uint8Array(0));
		};
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await h.readCheckpoint();
		expect(receiver).toBeUndefined();
	});

	it("uses the global fetch when no fetch function is given", async () => {
		const stub = vi.fn(async (): Promise<Response> => new Response(new Uint8Array([4, 2])));
		vi.stubGlobal("fetch", stub);
		const h = newHTTPFetcher(new URL("https://log.example/root/"));
		expect(await h.readCheckpoint()).toEqual(new Uint8Array([4, 2]));
		expect(stub).toHaveBeenCalledTimes(1);
		expect(stub.mock.calls[0]).toEqual(["https://log.example/root/checkpoint", expect.anything()]);
	});

	it("passes the abort signal to fetch", async () => {
		let got: AbortSignal | null | undefined;
		const fetch: FetchFn = async (_input: string, init?: RequestInit): Promise<Response> => {
			got = init?.signal;
			return new Response(new Uint8Array(0));
		};
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		const ctrl = new AbortController();
		await h.readCheckpoint(ctrl.signal);
		expect(got).toBe(ctrl.signal);
	});

	it("passes no signal to fetch when the caller has none", async () => {
		let init: RequestInit | undefined;
		const fetch: FetchFn = async (_input: string, i?: RequestInit): Promise<Response> => {
			init = i;
			return new Response(new Uint8Array(0));
		};
		await newHTTPFetcher(new URL("https://log.example/root/"), fetch).readCheckpoint();
		expect(init).toBeDefined();
		expect(init && "signal" in init).toBe(false);
	});

	it("fails when the signal is aborted while the request is in flight", async () => {
		const fetch: FetchFn = (_input: string, init?: RequestInit): Promise<Response> =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		const ctrl = new AbortController();
		const pending = h.readCheckpoint(ctrl.signal);
		ctrl.abort();
		await expect(pending).rejects.toThrowError("aborted");
	});

	describe("response body release", () => {
		/**
		 * trackedResponse returns a Response whose body reports whether it was cancelled. The body of a
		 * successful response is complete; that of an error response is still open, as when a server is
		 * partway through sending a large error page, which is the case where an unreleased body matters.
		 */
		function trackedResponse(status: number): { response: Response; cancelled: () => boolean } {
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				start(controller): void {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					if (status === 200) {
						controller.close();
					}
				},
				cancel(): void {
					cancelled = true;
				},
			});
			return { response: new Response(body, { status }), cancelled: () => cancelled };
		}

		it("cancels the unread body of a 404, so the connection is not held open", async () => {
			const { response, cancelled } = trackedResponse(404);
			const fetch: FetchFn = async (): Promise<Response> => response;
			const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
			await expect(h.readCheckpoint()).rejects.toThrow();
			expect(cancelled()).toBe(true);
		});

		it("cancels the unread body of any other non-200 status", async () => {
			const { response, cancelled } = trackedResponse(500);
			const fetch: FetchFn = async (): Promise<Response> => response;
			const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
			await expect(h.readCheckpoint()).rejects.toThrow();
			expect(cancelled()).toBe(true);
		});

		it("reads, rather than cancels, the body of a 200", async () => {
			const { response, cancelled } = trackedResponse(200);
			const fetch: FetchFn = async (): Promise<Response> => response;
			const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
			expect(await h.readCheckpoint()).toEqual(new Uint8Array([1, 2, 3]));
			expect(cancelled()).toBe(false);
		});

		it("is not disturbed by a response with no body", async () => {
			const fetch: FetchFn = async (): Promise<Response> => new Response(null, { status: 404 });
			const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
			await expect(h.readCheckpoint()).rejects.toThrowError("file does not exist");
		});
	});
});

// Port additions: hardening with no Go counterpart (docs/decisions/0195, 0197).
describe("request policy", () => {
	it("omits credentials and follows redirects by default", async () => {
		let init: RequestInit | undefined;
		const fetch: FetchFn = async (_input: string, i?: RequestInit): Promise<Response> => {
			init = i;
			return new Response(new Uint8Array(0));
		};
		await newHTTPFetcher(new URL("https://log.example/root/"), fetch).readCheckpoint();
		expect(init?.credentials).toBe("omit");
		expect(init?.redirect).toBe("follow");
	});

	it("passes the redirect option through", async () => {
		let init: RequestInit | undefined;
		const fetch: FetchFn = async (_input: string, i?: RequestInit): Promise<Response> => {
			init = i;
			return new Response(new Uint8Array(0));
		};
		await newHTTPFetcher(new URL("https://log.example/root/"), fetch, { redirect: "manual" }).readCheckpoint();
		expect(init?.redirect).toBe("manual");
		expect(init?.credentials).toBe("omit");
	});

	it("reports a redirect it was told not to follow as a bad status", async () => {
		const fetch: FetchFn = async (): Promise<Response> =>
			new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } });
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch, { redirect: "manual" });
		await expect(h.readCheckpoint()).rejects.toThrow('get("https://log.example/root/checkpoint"): 302');
	});
});

describe("response size caps", () => {
	/** streamOf returns a body that delivers size bytes in chunks of 1000, reporting whether it was cancelled. */
	function streamOf(size: number): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
		let sent = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller): void {
				if (sent >= size) {
					controller.close();
					return;
				}
				const n = Math.min(1000, size - sent);
				sent += n;
				controller.enqueue(new Uint8Array(n));
			},
			cancel(): void {
				cancelled = true;
			},
		});
		return { body, cancelled: () => cancelled };
	}

	it("accepts a full tile and rejects a tile body beyond the cap", async () => {
		const sizes = new Map<string, number>([
			["https://log.example/root/tile/0/000", 256 * 32],
			["https://log.example/root/tile/0/001", 256 * 32 + 1025],
		]);
		const fetch: FetchFn = async (input: string): Promise<Response> =>
			new Response(streamOf(sizes.get(input) ?? 0).body);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		expect(await h.readTile(0n, 0n, 0)).toHaveLength(256 * 32);
		await expect(h.readTile(0n, 1n, 0)).rejects.toThrow(
			'get("https://log.example/root/tile/0/001"): response body exceeds the limit of 9216 bytes',
		);
	});

	it("stops reading, and cancels, a checkpoint body beyond the cap", async () => {
		const { body, cancelled } = streamOf(4 << 20);
		const fetch: FetchFn = async (): Promise<Response> => new Response(body);
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await expect(h.readCheckpoint()).rejects.toThrow("response body exceeds the limit of 1048576 bytes");
		expect(cancelled()).toBe(true);
	});

	it("rejects an entry bundle whose Content-Length announces more than the cap, without reading it", async () => {
		const { body, cancelled } = streamOf(10);
		const fetch: FetchFn = async (): Promise<Response> =>
			new Response(body, { headers: { "Content-Length": String(256 * 65537 + 1) } });
		const h = newHTTPFetcher(new URL("https://log.example/root/"), fetch);
		await expect(h.readEntryBundle(0n, 0)).rejects.toThrow("response body exceeds the limit of 16777472 bytes");
		expect(cancelled()).toBe(true);
	});
});
