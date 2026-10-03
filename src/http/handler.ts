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

// This file has no upstream counterpart. See docs/decisions/0170-http-log-handler.md.

import { concatBytes } from "../internal/gostd/bytes.ts";

/**
 * Handler answers the requests it owns and returns undefined for every other one, so that
 * handlers compose: a log, a witness and an application's own routes can share one server
 * without any of them knowing about the others.
 *
 * It is the Fetch API's request/response shape, which browsers (service workers), Deno,
 * Bun and Cloudflare Workers serve natively and Node serves through {@link toNodeListener}.
 */
export type Handler = (request: Request) => Promise<Response | undefined>;

/**
 * combineHandlers returns a fetch-style function that asks each handler in turn and
 * answers with the first response, or with 404 Not Found if none of them owns the request.
 *
 * Its result is what `Deno.serve`, `Bun.serve({ fetch })`, a Worker's `fetch` export or a
 * service worker's `respondWith` expect:
 *
 * ```ts
 * Deno.serve(combineHandlers(newLogHandler({ reader }), witness.handle));
 * ```
 */
export function combineHandlers(...handlers: readonly Handler[]): (request: Request) => Promise<Response> {
	return async (request: Request): Promise<Response> => {
		for (const h of handlers) {
			const r = await h(request);
			if (r !== undefined) {
				return r;
			}
		}
		return textResponse(404, "not found");
	};
}

/**
 * textResponse returns a plain-text response with a one-line body.
 *
 * @internal Shared by the handlers in this package and webtessera/witness; not exported
 * from the barrel.
 */
export function textResponse(status: number, message: string, headers?: HeadersInit): Response {
	const h = new Headers(headers);
	h.set("Content-Type", "text/plain; charset=utf-8");
	return new Response(`${message}\n`, { status, headers: h });
}

/**
 * methodNotAllowed returns the 405 response for a method the resource does not support,
 * with the `Allow` header RFC 9110 requires.
 *
 * @internal Shared by the handlers in this package and webtessera/witness; not exported
 * from the barrel.
 */
export function methodNotAllowed(allow: string, headers?: HeadersInit): Response {
	const h = new Headers(headers);
	h.set("Allow", allow);
	return textResponse(405, "method not allowed", h);
}

/**
 * normalizePrefix turns a mount prefix into the form path matching uses: a leading and a
 * trailing slash, so that "logs/a", "/logs/a" and "/logs/a/" all mount at "/logs/a/".
 *
 * @internal Shared by the handlers in this package and webtessera/witness.
 */
export function normalizePrefix(prefix: string | undefined): string {
	let p = prefix ?? "/";
	if (!p.startsWith("/")) {
		p = `/${p}`;
	}
	if (!p.endsWith("/")) {
		p = `${p}/`;
	}
	return p;
}

/**
 * readBodyCapped reads a request body, or returns undefined as soon as it is known to exceed
 * max bytes: from a declared `Content-Length`, or while streaming, without ever buffering
 * more than max bytes.
 *
 * @internal Shared by the handlers in this package and webtessera/witness.
 */
export async function readBodyCapped(request: Request, max: number): Promise<Uint8Array | undefined> {
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > max) {
		return undefined;
	}
	if (request.body === null) {
		return new Uint8Array(0);
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		size += value.length;
		if (size > max) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	return concatBytes(...chunks);
}

/**
 * errorText renders a caught value for an error callback or a response body.
 *
 * @internal
 */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
