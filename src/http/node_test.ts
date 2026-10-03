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

// The adapter is exercised with objects shaped like Node's IncomingMessage and ServerResponse,
// which is all it relies on; the repository's typecheck has no Node typings to build a real
// server against.

import { describe, expect, it, vi } from "vitest";
import { type NodeIncomingMessage, type NodeServerResponse, toNodeListener } from "./node.ts";

interface written {
	status: number;
	headers: Record<string, string | string[]>;
	body: Uint8Array | undefined;
}

function fakeRequest(
	method: string,
	url: string,
	headers: Record<string, string | string[]>,
	chunks: readonly (Uint8Array | string)[] = [],
): NodeIncomingMessage {
	return {
		method,
		url,
		headers,
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) {
				yield c;
			}
		},
	};
}

function fakeResponse(): { res: NodeServerResponse; done: Promise<written> } {
	let resolve: (w: written) => void = () => undefined;
	const done = new Promise<written>((r) => {
		resolve = r;
	});
	let status = 0;
	let headers: Record<string, string | string[]> = {};
	const res: NodeServerResponse = {
		writeHead(s, h) {
			status = s;
			headers = h;
		},
		end(chunk) {
			resolve({ status, headers, body: chunk });
		},
	};
	return { res, done };
}

describe("toNodeListener", () => {
	it("builds the Request from the request line, headers and body, and writes the Response back", async () => {
		const seen: { url?: string; method?: string; body?: string; via?: string | null } = {};
		const listener = toNodeListener(async (request) => {
			seen.url = request.url;
			seen.method = request.method;
			seen.body = await request.text();
			seen.via = request.headers.get("x-multi");
			return new Response("created", { status: 201, headers: { "X-Answer": "42" } });
		});
		const { res, done } = fakeResponse();
		listener(
			fakeRequest("POST", "/add?x=1", { host: "log.example:8080", "x-multi": ["a", "b"] }, [
				new TextEncoder().encode("hel"),
				"lo",
			]),
			res,
		);
		const w = await done;
		expect(seen).toEqual({ url: "http://log.example:8080/add?x=1", method: "POST", body: "hello", via: "a, b" });
		expect(w.status).toBe(201);
		expect(w.headers["x-answer"]).toBe("42");
		expect(new TextDecoder().decode(w.body)).toBe("created");
	});

	it("answers 404 when the handler owns nothing", async () => {
		const { res, done } = fakeResponse();
		toNodeListener(async () => undefined)(fakeRequest("GET", "/nope", {}), res);
		const w = await done;
		expect(w.status).toBe(404);
		expect(new TextDecoder().decode(w.body)).toBe("not found\n");
	});

	it("answers 413 without calling the handler when the body is too large", async () => {
		const handler = vi.fn(async () => new Response("ok"));
		const { res, done } = fakeResponse();
		toNodeListener(handler, { maxBodyBytes: 4 })(fakeRequest("POST", "/", {}, ["abc", "de"]), res);
		expect((await done).status).toBe(413);
		expect(handler).not.toHaveBeenCalled();
	});

	it("answers 500 and reports a handler that throws", async () => {
		const onError = vi.fn();
		const { res, done } = fakeResponse();
		toNodeListener(
			async () => {
				throw new Error("boom");
			},
			{ onError },
		)(fakeRequest("GET", "/", {}), res);
		expect((await done).status).toBe(500);
		expect(onError).toHaveBeenCalledWith(new Error("boom"));
	});

	it("takes an origin-form request-target as the path it is, and refuses other forms", async () => {
		const seen: string[] = [];
		const listener = toNodeListener(async (r) => {
			seen.push(r.url);
			return new Response("ok");
		});
		const serve = async (method: string, target: string, headers: Record<string, string> = { host: "log.example" }) => {
			const { res, done } = fakeResponse();
			listener(fakeRequest(method, target, headers), res);
			return (await done).status;
		};
		expect(await serve("GET", "//x/checkpoint")).toBe(200);
		expect(await serve("GET", "//admin/witness/add-checkpoint?a=b")).toBe(200);
		expect(seen).toEqual(["http://log.example//x/checkpoint", "http://log.example//admin/witness/add-checkpoint?a=b"]);
		for (const target of ["http://other.example/checkpoint", "other.example:443", "checkpoint", "*", ""]) {
			expect(await serve("GET", target), target).toBe(400);
		}
		expect(await serve("OPTIONS", "*")).toBe(204);
		// A Host header that is not a bare authority cannot move the request elsewhere.
		for (const host of ["log.example/admin", "user@log.example", "log.example?x", "log example"]) {
			expect(await serve("GET", "/checkpoint", { host }), host).toBe(400);
		}
		expect(seen).toHaveLength(2);
	});

	it("refuses a body limit that is not a positive integer, and an origin with a path", () => {
		for (const maxBodyBytes of [Number.NaN, Number(undefined), -1, 0, 1.5, Number.POSITIVE_INFINITY]) {
			expect(() => toNodeListener(async () => undefined, { maxBodyBytes }), String(maxBodyBytes)).toThrow(RangeError);
		}
		for (const origin of ["https://public.example/base", "https://public.example/?q", "not a url"]) {
			expect(() => toNodeListener(async () => undefined, { origin }), origin).toThrow(TypeError);
		}
	});

	it("writes no body for a bodiless response and honours a fixed origin", async () => {
		let url = "";
		const { res, done } = fakeResponse();
		toNodeListener(
			async (r) => {
				url = r.url;
				return new Response(null, { status: 204 });
			},
			{ origin: "https://public.example" },
		)(fakeRequest("HEAD", "/checkpoint", { host: "internal:1234" }), res);
		const w = await done;
		expect(url).toBe("https://public.example/checkpoint");
		expect(w.status).toBe(204);
		expect(w.body).toBeUndefined();
	});
});
