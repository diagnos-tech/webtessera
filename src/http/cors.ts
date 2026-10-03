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

// This file has no upstream counterpart. See docs/decisions/0170-http-log-handler.md.

/** CorsOptions configures the CORS headers a handler adds when asked to. */
export interface CorsOptions {
	/** origin is the value of `Access-Control-Allow-Origin`. Defaults to `*`. */
	readonly origin?: string;
	/** maxAgeSeconds is how long a browser may cache a preflight answer. Defaults to one day. */
	readonly maxAgeSeconds?: number;
}

/**
 * Cors is the precomputed form of CorsOptions.
 *
 * @internal Shared by the handlers in this package and webtessera/witness.
 */
export interface Cors {
	/** simple holds the headers added to every response. */
	readonly simple: Headers;
	readonly maxAgeSeconds: number;
}

/**
 * corsConfig precomputes the CORS headers for an option value, or returns undefined when
 * CORS is off. expose names response headers beyond the CORS-safelisted ones that scripts
 * may read.
 *
 * @internal
 */
export function corsConfig(cors: boolean | CorsOptions | undefined, expose: readonly string[]): Cors | undefined {
	if (cors === undefined || cors === false) {
		return undefined;
	}
	const o: CorsOptions = cors === true ? {} : cors;
	const simple = new Headers({ "Access-Control-Allow-Origin": o.origin ?? "*" });
	if (expose.length > 0) {
		simple.set("Access-Control-Expose-Headers", expose.join(", "));
	}
	return { simple, maxAgeSeconds: o.maxAgeSeconds ?? 86400 };
}

/**
 * preflight answers a CORS preflight request for a resource allowing the given methods. A
 * simple request needs none, but one with a non-safelisted header (an `Authorization`, say)
 * triggers one.
 *
 * @internal
 */
export function preflight(request: Request, cors: Cors, methods: string): Response {
	const headers = new Headers(cors.simple);
	headers.set("Access-Control-Allow-Methods", methods);
	const requested = request.headers.get("Access-Control-Request-Headers");
	if (requested !== null) {
		headers.set("Access-Control-Allow-Headers", requested);
	}
	headers.set("Access-Control-Max-Age", String(cors.maxAgeSeconds));
	headers.set("Allow", `${methods}, OPTIONS`);
	return new Response(null, { status: 204, headers });
}

/**
 * withCors returns r with the CORS headers added, or r itself when CORS is off.
 *
 * @internal
 */
export function withCors(r: Response, cors: Cors | undefined): Response {
	if (cors === undefined) {
		return r;
	}
	const headers = new Headers(r.headers);
	for (const [k, v] of cors.simple) {
		headers.set(k, v);
	}
	return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
}
