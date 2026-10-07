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

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	addErrorResponse,
	addResponse,
	combineHandlers,
	ErrMethodNotAllowed,
	MaxEntryBytes,
	newLogHandler,
	readEntryBody,
} from "webtessera/http";
import { fetchCheckpoint, newHTTPFetcher, newProofBuilder } from "../client/index.ts";
import { newFsck } from "../fsck/index.ts";
import { ErrNotExist, errorIs, wrapError } from "../internal/gostd/errors.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";
import { ErrPushback } from "../log.ts";
import { verifyInclusion } from "../vendor/merkle/proof/index.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import { entriesOf, fetchVia, newTestLog, type TestLog } from "./testing/testlog.ts";

// 300 entries: one full level-0 tile and bundle, a partial one of width 44, and a partial
// level-1 tile of width 1.
const logSize = 300;
let log: TestLog;

beforeAll(async () => {
	log = await newTestLog({ origin: "example.com/http-test" });
	await log.add(entriesOf(logSize));
});

afterAll(async () => {
	await log.shutdown();
});

function get(path: string, init?: RequestInit): Request {
	return new Request(`https://log.example${path}`, init);
}

describe("newLogHandler", () => {
	it("serves the checkpoint as the spec asks", async () => {
		const h = newLogHandler({ reader: log.reader });
		const r = await h(get("/checkpoint"));
		expect(r?.status).toBe(200);
		expect(r?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(r?.headers.get("Cache-Control")).toBe("no-cache");
		expect(new Uint8Array(await (r as Response).arrayBuffer())).toEqual(await log.reader.readCheckpoint());
	});

	it("serves full and partial tiles and bundles with their caching", async () => {
		const h = newLogHandler({ reader: log.reader });
		const cases = [
			{ path: "/tile/0/000", bytes: 256 * 32, cache: "public, max-age=31536000, immutable" },
			{ path: "/tile/0/001.p/44", bytes: 44 * 32, cache: "public, max-age=60" },
			{ path: "/tile/1/000.p/1", bytes: 32, cache: "public, max-age=60" },
			{ path: "/tile/entries/000", bytes: undefined, cache: "public, max-age=31536000, immutable" },
			{ path: "/tile/entries/001.p/44", bytes: undefined, cache: "public, max-age=60" },
		];
		for (const c of cases) {
			const r = await h(get(c.path));
			expect(r?.status, c.path).toBe(200);
			expect(r?.headers.get("Content-Type"), c.path).toBe("application/octet-stream");
			expect(r?.headers.get("Cache-Control"), c.path).toBe(c.cache);
			const body = new Uint8Array(await (r as Response).arrayBuffer());
			if (c.bytes !== undefined) {
				expect(body.length, c.path).toBe(c.bytes);
			}
			expect(body.length).toBeGreaterThan(0);
		}
	});

	it("answers HEAD with the headers and length but no body", async () => {
		const h = newLogHandler({ reader: log.reader });
		const r = await h(get("/tile/0/000", { method: "HEAD" }));
		expect(r?.status).toBe(200);
		expect(r?.headers.get("Content-Length")).toBe(String(256 * 32));
		expect(r?.body).toBeNull();
	});

	it("answers 404 for resources the reader does not have", async () => {
		const h = newLogHandler({ reader: log.reader });
		for (const p of ["/tile/0/005", "/tile/entries/x001/000", "/tile/3/000"]) {
			const r = await h(get(p));
			expect(r?.status, p).toBe(404);
		}
	});

	it("answers 400 with the reason for malformed and non-canonical tile paths", async () => {
		const h = newLogHandler({ reader: log.reader });
		const r = await h(get("/tile/0/x000/001"));
		expect(r?.status).toBe(400);
		expect(await r?.text()).toBe("Malformed URL: not the canonical encoding of this resource, which is tile/0/001\n");
		expect((await h(get("/tile/64/000")))?.status).toBe(400);
		expect((await h(get("/tile/0")))?.status).toBe(400);
	});

	it("leaves paths outside the log, or outside its prefix, to other handlers", async () => {
		const h = newLogHandler({ reader: log.reader, prefix: "logs/a" });
		expect(await h(get("/checkpoint"))).toBeUndefined();
		expect(await h(get("/logs/a"))).toBeUndefined();
		expect(await h(get("/logs/a/add", { method: "POST" }))).toBeUndefined();
		expect((await h(get("/logs/a/checkpoint")))?.status).toBe(200);
		expect((await h(get("/logs/a/tile/0/000?cachebust=1")))?.status).toBe(200);
	});

	it("never reaches storage for anything but a tlog-tiles resource", async () => {
		const seen: string[] = [];
		const record = <T>(what: string, p: Promise<T>): Promise<T> => {
			seen.push(what);
			return p;
		};
		const spy = {
			readCheckpoint: () => record("checkpoint", log.reader.readCheckpoint()),
			readTile: (l: bigint, i: bigint, p: number) => record(`tile ${l} ${i} ${p}`, log.reader.readTile(l, i, p)),
			readEntryBundle: (i: bigint, p: number) => record(`entries ${i} ${p}`, log.reader.readEntryBundle(i, p)),
		};
		const h = newLogHandler({ reader: spy });
		for (const p of ["/.state/treeState", "/tile/%2e%2e/.state/treeState", "/tile/0/../../.state/x", "/", "/tile"]) {
			const r = await h(get(p));
			expect(r === undefined || r.status === 400, p).toBe(true);
		}
		expect((await h(get(`/tile/0/${"x001/".repeat(500)}000`)))?.status).toBe(400);
		expect(seen).toEqual([]);
	});

	it("answers 405 with Allow for other methods", async () => {
		const h = newLogHandler({ reader: log.reader });
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
			const r = await h(get("/checkpoint", { method }));
			expect(r?.status, method).toBe(405);
			expect(r?.headers.get("Allow")).toBe("GET, HEAD");
		}
	});

	it("adds CORS headers and answers preflights only when asked to", async () => {
		const plain = await newLogHandler({ reader: log.reader })(get("/checkpoint"));
		expect(plain?.headers.get("Access-Control-Allow-Origin")).toBeNull();

		const h = newLogHandler({ reader: log.reader, cors: { origin: "https://app.example", maxAgeSeconds: 60 } });
		const r = await h(get("/checkpoint"));
		expect(r?.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
		expect(r?.headers.get("Access-Control-Expose-Headers")).toBe("ETag");
		expect((await h(get("/tile/9/000")))?.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");

		const pre = await h(
			get("/tile/0/000", {
				method: "OPTIONS",
				headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
			}),
		);
		expect(pre?.status).toBe(204);
		expect(pre?.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD");
		expect(pre?.headers.get("Access-Control-Allow-Headers")).toBe("authorization");
		expect(pre?.headers.get("Access-Control-Max-Age")).toBe("60");

		const star = await newLogHandler({ reader: log.reader, cors: true })(get("/checkpoint"));
		expect(star?.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("serves an ETag and answers a matching If-None-Match with 304", async () => {
		const h = newLogHandler({ reader: log.reader });
		const first = await h(get("/checkpoint"));
		const etag = first?.headers.get("ETag");
		expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
		for (const inm of [etag as string, `W/${etag}`, `"nope", ${etag}`, "*"]) {
			const r = await h(get("/checkpoint", { headers: { "If-None-Match": inm } }));
			expect(r?.status, inm).toBe(304);
			expect(r?.headers.get("ETag")).toBe(etag);
			expect(r?.body).toBeNull();
		}
		expect((await h(get("/checkpoint", { headers: { "If-None-Match": '"nope"' } })))?.status).toBe(200);
		expect((await newLogHandler({ reader: log.reader, etag: false })(get("/checkpoint")))?.headers.has("ETag")).toBe(
			false,
		);
	});

	it("honours cache-control overrides", async () => {
		const h = newLogHandler({ reader: log.reader, cacheControl: { checkpoint: "max-age=2" } });
		expect((await h(get("/checkpoint")))?.headers.get("Cache-Control")).toBe("max-age=2");
		expect((await h(get("/tile/0/000")))?.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
	});

	it("answers 500 and reports reader failures other than ErrNotExist", async () => {
		const onError = vi.fn();
		const failing = {
			readCheckpoint: () => Promise.reject(new Error("disk on fire")),
			readTile: () => Promise.reject(wrapError("gone", ErrNotExist)),
			readEntryBundle: () => Promise.reject(new Error("disk on fire")),
		};
		const h = newLogHandler({ reader: failing, onError });
		const r = await h(get("/checkpoint"));
		expect(r?.status).toBe(500);
		expect(await r?.text()).toBe("internal server error\n");
		expect(onError).toHaveBeenCalledTimes(1);
		expect((await h(get("/tile/0/000")))?.status).toBe(404);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("never reads request.signal, whose first read prints a warning on Deno 2, nor passes a signal on", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const h = newLogHandler({
			reader: {
				readCheckpoint: (signal) => {
					signals.push(signal);
					return log.reader.readCheckpoint();
				},
				readTile: (l, i, p, signal) => {
					signals.push(signal);
					return log.reader.readTile(l, i, p);
				},
				readEntryBundle: (i, p, signal) => {
					signals.push(signal);
					return log.reader.readEntryBundle(i, p);
				},
			},
			cors: true,
		});
		for (const [path, method, status] of [
			["/checkpoint", "GET", 200],
			["/tile/0/000", "HEAD", 200],
			["/tile/entries/001.p/44", "GET", 200],
			["/tile/entries/009", "GET", 404],
			["/tile/0/x", "GET", 400],
			["/checkpoint", "OPTIONS", 204],
		] as const) {
			const r = get(path, {
				method,
				headers: { Origin: "https://app.example", "Access-Control-Request-Method": "GET" },
			});
			Object.defineProperty(r, "signal", {
				get: () => {
					throw new Error("the handler read request.signal");
				},
			});
			expect((await h(r))?.status, path).toBe(status);
		}
		expect(signals).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("serves exactly W hashes when the reader substitutes a full tile for a partial one", async () => {
		const full = await log.reader.readTile(0n, 0n, 0);
		const substituting = {
			readCheckpoint: () => log.reader.readCheckpoint(),
			readTile: () => Promise.resolve(full),
			readEntryBundle: () => log.reader.readEntryBundle(0n, 0),
		};
		const h = newLogHandler({ reader: substituting });
		const r = await h(get("/tile/0/000.p/7"));
		expect(new Uint8Array(await (r as Response).arrayBuffer())).toEqual(full.subarray(0, 7 * 32));
		const b = await h(get("/tile/entries/000.p/3"));
		const bundle = new Uint8Array(await (b as Response).arrayBuffer());
		// "entry 0", "entry 1", "entry 2": 3 × (2 + 7) bytes.
		expect(bundle.length).toBe(27);
	});

	it("is a tlog-tiles server webtessera's client and fsck can verify the whole log through", async () => {
		const fetch = fetchVia(newLogHandler({ reader: log.reader, prefix: "/log/" }));
		const remote = newHTTPFetcher(new URL("https://log.example/log/"), fetch);

		const { checkpoint } = await fetchCheckpoint((s) => remote.readCheckpoint(s), log.verifier, log.origin);
		expect(checkpoint.size).toBe(BigInt(logSize));
		const pb = await newProofBuilder(checkpoint.size, (l, i, p, s) => remote.readTile(l, i, p, s));
		// Index 271 is the 16th entry of the partial bundle 1, of width 300 % 256 = 44.
		const index = 271n;
		const proof = await pb.inclusionProof(index);
		const leaf = defaultMerkleLeafHasher(await remote.readEntryBundle(1n, 44))[15] as Uint8Array;
		verifyInclusion(DefaultHasher, index, checkpoint.size, leaf, proof, checkpoint.hash);

		await newFsck(log.origin, log.verifier, remote, defaultMerkleLeafHasher, { n: 4 }).check();
	});
});

describe("combineHandlers", () => {
	it("answers with the first handler that owns the request, else 404", async () => {
		const serve = combineHandlers(
			async () => undefined,
			async (r) => (new URL(r.url).pathname === "/a" ? new Response("a") : undefined),
			async (r) => (new URL(r.url).pathname === "/a" ? new Response("shadowed") : undefined),
		);
		expect(await (await serve(get("/a"))).text()).toBe("a");
		const nf = await serve(get("/b"));
		expect(nf.status).toBe(404);
		expect(nf.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
	});
});

describe("POST /add answers", () => {
	it("is the bare decimal index, as upstream's personalities write it", async () => {
		const r = addResponse(12345678901234567890n);
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("12345678901234567890");
		expect(await addResponse({ index: 7n }).text()).toBe("7");
	});

	it("is 503 with Retry-After on pushback, and 500 with the error text only when asked", async () => {
		const p = addErrorResponse(wrapError("antispam", ErrPushback));
		expect(p.status).toBe(503);
		expect(p.headers.get("Retry-After")).toBe("1");
		const err = new Error('sqlite: put "tile/0/000": disk I/O error at /var/lib/log.db');
		const e = addErrorResponse(err);
		expect(e.status).toBe(500);
		expect(await e.text()).toBe("internal server error\n");
		const detailed = addErrorResponse(err, { detail: true });
		expect(detailed.status).toBe(500);
		expect(await detailed.text()).toBe(err.message);
	});

	it("reads an entry of up to 65535 bytes and refuses a larger one while it streams", async () => {
		const post = (body: BodyInit): Request =>
			new Request("https://log.example/add", { method: "POST", body, duplex: "half" } as RequestInit);
		expect(MaxEntryBytes).toBe(65535);
		expect((await readEntryBody(post(new Uint8Array(65535))))?.length).toBe(65535);
		expect(await readEntryBody(post(new Uint8Array(65536)))).toBeUndefined();
		expect(await readEntryBody(post(new Uint8Array(11)), 10)).toBeUndefined();

		// A stream with no declared length is cut off once it passes the limit.
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(c) {
				pulled++;
				c.enqueue(new Uint8Array(4096));
			},
		});
		expect(await readEntryBody(post(endless))).toBeUndefined();
		expect(pulled).toBeLessThan(40);
	});

	it("refuses a request that is not a POST, which addErrorResponse answers with 405", async () => {
		for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]) {
			const err = (await readEntryBody(new Request("https://log.example/add", { method })).catch(
				(e: unknown) => e,
			)) as Error;
			expect(errorIs(err, ErrMethodNotAllowed), method).toBe(true);
			expect(err.message, method).toBe(
				"readEntryBody: only a POST request carries an entry, as its body; answer other methods with 405 Method " +
					"Not Allowed",
			);
			const r = addErrorResponse(err);
			expect([r.status, r.headers.get("Allow")], method).toEqual([405, "POST"]);
		}
		// A GET with a query string, as a link preview might send, is refused the same way.
		await expect(readEntryBody(new Request("https://log.example/add?x=1"))).rejects.toThrow(/only a POST request/);
	});

	it("refuses a size limit that is not a positive integer", async () => {
		const post = (): Request => new Request("https://log.example/add", { method: "POST", body: new Uint8Array(70000) });
		for (const maxBytes of [Number.NaN, Number(undefined), -1, 0, 1.5, Number.POSITIVE_INFINITY]) {
			await expect(readEntryBody(post(), maxBytes), String(maxBytes)).rejects.toThrow(RangeError);
		}
	});
});
