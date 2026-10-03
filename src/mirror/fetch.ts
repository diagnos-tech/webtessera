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

// This file has no upstream counterpart. See docs/decisions/0176-mirror-verification.md.

import type { FetchFn } from "../client/fetcher.ts";
import { concatBytes } from "../internal/gostd/bytes.ts";

/**
 * MaxResourceBytes is the size of the largest resource a tlog-tiles log can serve: a full
 * entry bundle of 256 entries of 65535 bytes, each with its two-byte length prefix.
 */
export const MaxResourceBytes = 256 * (2 + 0xffff);

/** SourceFetchOptions configures newSourceFetch. */
export interface SourceFetchOptions {
	/** fetch makes the requests. Defaults to the global fetch. */
	readonly fetch?: FetchFn;
	/** maxBytes caps every response body. Defaults to {@link MaxResourceBytes}. */
	readonly maxBytes?: number;
}

/**
 * newSourceFetch returns a fetch function for reading a log that is not trusted, to hand
 * to `newHTTPFetcher` as the source of a mirror:
 *
 *   - It does not follow redirects. tlog-tiles says its resources "MUST NOT serve redirect
 *     responses", and following one would let the source send the mirror anywhere.
 *   - It refuses any response body larger than maxBytes, from its declared length or while
 *     streaming, so that a hostile source cannot exhaust the mirror's memory.
 *
 * Responses other than 200 pass through unread, for the fetcher to interpret (a 404 is how
 * a log says a resource does not exist).
 */
export function newSourceFetch(options: SourceFetchOptions = {}): FetchFn {
	const maxBytes = options.maxBytes ?? MaxResourceBytes;
	return async (input: string, init?: RequestInit): Promise<Response> => {
		// Called through a local so that the global fetch has no receiver; see
		// docs/decisions/0131-httpfetcher-fetch-runtime-fidelity.md.
		const f = options.fetch ?? fetch;
		const r = await f(input, { ...init, redirect: "manual" });
		if (isRedirect(r)) {
			r.body?.cancel().catch(() => undefined);
			throw new Error(`refusing redirect (${r.status}) from the source log; tlog-tiles resources must not redirect`);
		}
		if (r.status !== 200) {
			return r;
		}
		const body = await readCapped(r, maxBytes);
		return new Response(body as BodyInit, { status: r.status, statusText: r.statusText, headers: r.headers });
	};
}

/**
 * readCapped reads a response body, throwing as soon as it is known to exceed max bytes.
 *
 * @internal Shared with the S3 sink.
 */
export async function readCapped(r: Response, max: number): Promise<Uint8Array> {
	const declared = Number(r.headers.get("Content-Length") ?? "0");
	if (declared > max) {
		r.body?.cancel().catch(() => undefined);
		throw new Error(`response of ${declared} bytes exceeds the ${max}-byte limit`);
	}
	if (r.body === null) {
		return new Uint8Array(0);
	}
	const reader = r.body.getReader();
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
			throw new Error(`response exceeds the ${max}-byte limit`);
		}
		chunks.push(value);
	}
	return concatBytes(...chunks);
}

/**
 * isRedirect reports whether r answers a `redirect: "manual"` request with a redirect:
 * browsers return an opaque redirect (type `opaqueredirect`, status 0), while Node, Deno,
 * Bun and workerd return the 3xx response itself. The type is compared as a string because
 * some runtimes' typings (Cloudflare's) do not list `opaqueredirect`.
 *
 * @internal Shared with the S3 sink.
 */
export function isRedirect(r: Response): boolean {
	return String(r.type) === "opaqueredirect" || (r.status >= 300 && r.status < 400);
}
