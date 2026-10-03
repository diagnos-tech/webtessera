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

// This file has no upstream counterpart. It adapts a Fetch API handler to Node's
// `http.createServer` callback without importing anything from Node: the request and response
// objects are described structurally, so the library stays free of Node built-ins (PORTING.md
// §7) and the same code typechecks for browsers and Workers. See
// docs/decisions/0170-http-log-handler.md.

import { concatBytes } from "../internal/gostd/bytes.ts";
import { positiveInteger } from "./handler.ts";

/**
 * NodeIncomingMessage is the part of Node's `http.IncomingMessage` the adapter reads:
 * the request line, the headers and the body, which Node exposes as an async iterable of
 * chunks.
 */
export interface NodeIncomingMessage extends AsyncIterable<Uint8Array | string> {
	readonly method?: string | undefined;
	readonly url?: string | undefined;
	readonly headers: { readonly [name: string]: string | readonly string[] | undefined };
}

/** NodeServerResponse is the part of Node's `http.ServerResponse` the adapter writes. */
export interface NodeServerResponse {
	writeHead(statusCode: number, headers: Record<string, string | string[]>): unknown;
	end(chunk?: Uint8Array): unknown;
}

/** NodeListenerOptions configures toNodeListener. */
export interface NodeListenerOptions {
	/**
	 * origin is the scheme and authority requests are taken to be addressed to, used to
	 * build each Request's absolute URL. Defaults to `http://` followed by the request's
	 * `Host` header; a request whose `Host` is not a bare authority is answered with 400.
	 * Handlers in this package look only at the path.
	 */
	readonly origin?: string;

	/**
	 * maxBodyBytes caps the request bodies the adapter buffers; a larger one is answered
	 * with 413 Content Too Large without reaching the handler. Defaults to 1 MiB, which is
	 * far above anything the log, witness or `POST /add` protocols exchange.
	 */
	readonly maxBodyBytes?: number;

	/** onError is told about every handler failure that turns into a 500 response. */
	readonly onError?: (err: unknown) => void;
}

const defaultMaxBodyBytes = 1 << 20;

/**
 * toNodeListener adapts a Fetch API handler (a {@link Handler}, or anything that takes a
 * Request and resolves to a Response) to the callback Node's `http.createServer` and
 * `https.createServer` take. A handler that resolves to undefined is answered with 404.
 *
 * ```ts
 * import { createServer } from "node:http";
 * import { newLogHandler, toNodeListener } from "webtessera/http";
 *
 * createServer(toNodeListener(newLogHandler({ reader }))).listen(8080);
 * ```
 *
 * Request bodies are buffered (up to `maxBodyBytes`) and responses are written in one
 * piece: every resource these protocols serve is small and already in memory.
 *
 * Only a request-target in origin form (`/path?query`, which is what clients send to an
 * origin server) reaches the handler, and it is taken as the path and query it is, never
 * resolved against the origin as a reference: `//host/path` is the path `//host/path`.
 * Any other form (absolute, authority) is answered with 400, except `*` with OPTIONS, the
 * server-wide form RFC 9110 allows, which is answered with 204 and reaches no handler.
 * It throws a RangeError if maxBodyBytes is not a positive integer, and a TypeError if
 * origin is not a scheme and authority alone.
 */
export function toNodeListener(
	handler: (request: Request) => Promise<Response | undefined>,
	options: NodeListenerOptions = {},
): (req: NodeIncomingMessage, res: NodeServerResponse) => void {
	const maxBodyBytes = positiveInteger("toNodeListener: maxBodyBytes", options.maxBodyBytes ?? defaultMaxBodyBytes);
	if (options.origin !== undefined && requestURL("/", options.origin) === undefined) {
		throw new TypeError(
			`toNodeListener: origin must be a scheme and authority alone, got ${JSON.stringify(options.origin)}`,
		);
	}
	return (req: NodeIncomingMessage, res: NodeServerResponse): void => {
		serve(handler, req, res, maxBodyBytes, options).catch((err: unknown) => {
			options.onError?.(err);
			writeText(res, 500, "internal server error");
		});
	};
}

async function serve(
	handler: (request: Request) => Promise<Response | undefined>,
	req: NodeIncomingMessage,
	res: NodeServerResponse,
	maxBodyBytes: number,
	options: NodeListenerOptions,
): Promise<void> {
	const method = req.method ?? "GET";
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) {
			continue;
		}
		for (const v of typeof value === "string" ? [value] : value) {
			headers.append(name, v);
		}
	}
	const target = req.url ?? "/";
	if (target === "*" && method === "OPTIONS") {
		res.writeHead(204, {});
		res.end();
		return;
	}
	const url = requestURL(target, options.origin ?? `http://${headers.get("Host") ?? "localhost"}`);
	if (url === undefined) {
		writeText(res, 400, "bad request target");
		return;
	}
	const init: RequestInit = { method, headers };
	if (method !== "GET" && method !== "HEAD") {
		const body = await readBody(req, maxBodyBytes);
		if (body === undefined) {
			writeText(res, 413, "request body too large");
			return;
		}
		init.body = body as BodyInit;
	}

	let response: Response | undefined;
	try {
		response = await handler(new Request(url, init));
	} catch (err) {
		options.onError?.(err);
		writeText(res, 500, "internal server error");
		return;
	}
	if (response === undefined) {
		writeText(res, 404, "not found");
		return;
	}

	const out: Record<string, string | string[]> = {};
	for (const [name, value] of response.headers) {
		out[name] = value;
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) {
		out["set-cookie"] = cookies;
	}
	const body = response.body === null ? undefined : new Uint8Array(await response.arrayBuffer());
	res.writeHead(response.status, out);
	res.end(body);
}

/**
 * requestURL returns the absolute URL of a request whose request-target is target, or
 * undefined if target is not in origin form or origin is not a bare scheme and authority.
 *
 * The target is set as the URL's path and query rather than resolved against origin: as a
 * relative reference, `//host/path` would name another authority, and its path would lose
 * the host's segment.
 */
function requestURL(target: string, origin: string): URL | undefined {
	if (!target.startsWith("/")) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return undefined;
	}
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
		return undefined;
	}
	const q = target.indexOf("?");
	url.pathname = q < 0 ? target : target.slice(0, q);
	url.search = q < 0 ? "" : target.slice(q);
	return url;
}

/** readBody buffers the request body, or returns undefined once it exceeds max bytes. */
async function readBody(req: NodeIncomingMessage, max: number): Promise<Uint8Array | undefined> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const encoder = new TextEncoder();
	for await (const chunk of req) {
		const c = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
		size += c.length;
		if (size > max) {
			return undefined;
		}
		chunks.push(c);
	}
	return concatBytes(...chunks);
}

function writeText(res: NodeServerResponse, status: number, message: string): void {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(new TextEncoder().encode(`${message}\n`));
}
