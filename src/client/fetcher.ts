// Copyright 2024 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/client/fetcher.go @ 4a6d9f9
//
// Port note: only HTTPFetcher is ported. FileFetcher reads a POSIX filesystem
// (`os.ReadFile`, `path.Join`), which this library cannot do: library code must run
// unmodified in browsers and edge runtimes, where there is no filesystem and no Node
// built-ins (PORTING.md §7). The in-memory storage driver, `src/storage/memory`, fills the
// role of local data that FileFetcher plays upstream. See
// docs/decisions/0064-filefetcher-not-ported.md.
//
// klog request-logging and the `net/http`/`net/url` types are likewise dropped in
// favour of the standard `fetch` and `URL` globals, which are what let this code run
// unmodified in a browser tab, Node, and a Cloudflare Worker alike. Where `fetch`
// behaves differently from `net/http` in a way that matters at runtime (the receiver it
// is called with, the response body it leaves open), the port accommodates it; see
// docs/decisions/0131-httpfetcher-fetch-runtime-fidelity.md.

import { CheckpointPath, EntryBundleWidth, entriesPath, TileWidth, tilePath } from "../api/layout/index.ts";
import { partialOrFullResource } from "../internal/fetcher/fallback.ts";
import { concatBytes } from "../internal/gostd/bytes.ts";
import { ErrNotExist, wrapError } from "../internal/gostd/errors.ts";
import { quote } from "../internal/gostd/strconv.ts";

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * discardBody releases the connection behind a response whose body will never be read.
 *
 * Port note: upstream returns from the 404 and unexpected-status cases before it registers
 * `defer r.Body.Close()`, so those bodies are never closed. Go tolerates that; the Fetch API
 * does not. A response body that is neither read nor cancelled keeps its connection
 * occupied until it is garbage collected, and workerd allows only a small, fixed number of
 * simultaneous open connections, so a handful of unread 404 bodies (which the partial-tile
 * fallback produces routinely) can hold later requests back. Any failure to cancel is
 * ignored: the status error the caller is about to receive is the one that matters. See
 * docs/decisions/0131-httpfetcher-fetch-runtime-fidelity.md.
 */
function discardBody(r: Response): void {
	r.body?.cancel().catch(() => undefined);
}

/**
 * FetchFn is the shape of the global `fetch` function. HTTPFetcher takes one of these
 * in place of Go's `*http.Client`.
 */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * HTTPFetcherOptions configures the requests an HTTPFetcher makes.
 *
 * Port note: has no Go counterpart, where the `*http.Client` carries this policy; see
 * docs/decisions/0197-fetch-credentials-and-redirects.md.
 */
export interface HTTPFetcherOptions {
	/**
	 * redirect is the Fetch API redirect mode for every request; "follow" when unset,
	 * which is what Go's http.Client does and what logs served from a CDN rely on. A
	 * server-side caller that fetches logs named by untrusted input should consider
	 * "manual": a followed redirect can lead to an address the caller did not choose.
	 * workerd accepts only "follow" and "manual".
	 */
	readonly redirect?: RequestInit["redirect"];
}

/**
 * newHTTPFetcher creates a new HTTPFetcher for the log rooted at the given URL, using
 * the provided fetch function.
 *
 * rootURL should end in a trailing slash.
 * c may be undefined, in which case the platform's global `fetch` will be used.
 *
 * Port note: Go returns `(*HTTPFetcher, error)`, but the error is always nil — nothing
 * in this function can fail. Dropped, matching the precedent set by
 * `HashTile.marshalText` (api/state.ts) for a Go error return that can never actually
 * occur. `opts` has no Go counterpart; see HTTPFetcherOptions.
 */
export function newHTTPFetcher(rootURL: URL, c?: FetchFn, opts?: HTTPFetcherOptions): HTTPFetcher {
	if (!rootURL.toString().endsWith("/")) {
		rootURL.pathname += "/";
	}
	return new HTTPFetcher(c ?? fetch, rootURL, opts?.redirect ?? "follow");
}

/**
 * Port note: hardening with no Go counterpart: each response body is read with a cap,
 * where Go's io.ReadAll reads whatever the server sends. A full tile is TileWidth hashes
 * of 32 bytes; an entry bundle at most EntryBundleWidth entries of a two-byte length and
 * up to 65535 bytes of data; a checkpoint is a small signed note. See
 * docs/decisions/0195-response-size-caps.md.
 */
const maxCheckpointBytes = 1 << 20;
const maxTileBytes = TileWidth * 32 + 1024;
const maxEntryBundleBytes = EntryBundleWidth * (2 + 65535);

/** HTTPFetcher knows how to fetch log artifacts from a log being served via HTTP. */
export class HTTPFetcher {
	readonly #c: FetchFn;
	readonly #rootURL: URL;
	readonly #redirect: NonNullable<RequestInit["redirect"]>;
	#authHeader = "";

	/** @internal Stands in for Go's `&HTTPFetcher{...}` composite literal; construct via {@link newHTTPFetcher}. */
	constructor(c: FetchFn, rootURL: URL, redirect: NonNullable<RequestInit["redirect"]> = "follow") {
		this.#c = c;
		this.#rootURL = rootURL;
		this.#redirect = redirect;
	}

	/** setAuthorizationHeader sets the value to be used with an Authorization: header for every request made by this fetcher. */
	setAuthorizationHeader(v: string): void {
		this.#authHeader = v;
	}

	/**
	 * Port note: `limit` caps the response body (see maxTileBytes and its neighbours);
	 * Go's fetch reads the whole body.
	 */
	async #fetch(p: string, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
		let u: URL;
		try {
			u = new URL(p, this.#rootURL);
		} catch (err) {
			throw new Error(`invalid URL: ${errText(err)}`);
		}
		const headers: Record<string, string> = {};
		if (this.#authHeader !== "") {
			headers.Authorization = this.#authHeader;
		}

		// Port note: credentials are always omitted, so a log fetched from a browser never
		// carries the page's cookies or HTTP authentication for that origin; the
		// Authorization header set above is the only credential sent. See
		// docs/decisions/0197-fetch-credentials-and-redirects.md.
		const init: omitCredentials = { method: "GET", headers, credentials: "omit", redirect: this.#redirect };
		if (signal !== undefined) {
			init.signal = signal;
		}

		// Port note: `fetch` is called through a local so that it has no receiver. Calling
		// `this.#c(...)` would pass the HTTPFetcher as `this`, and browsers and workerd reject
		// that for the global `fetch` with "Illegal invocation". Go's `h.c.Do(req)` has no such
		// constraint.
		const c = this.#c;
		let r: Response;
		try {
			r = await c(u.toString(), init);
		} catch (err) {
			throw new Error(`get(${quote(u.toString())}): ${errText(err)}`);
		}

		switch (r.status) {
			case 200:
				// All good, continue below
				break;
			case 404:
				// Need to throw ErrNotExist here, by contract.
				discardBody(r);
				throw wrapError(`get(${quote(u.toString())})`, ErrNotExist);
			default:
				discardBody(r);
				throw new Error(`get(${quote(u.toString())}): ${r.status}`);
		}

		// Port note: Go defers r.Body.Close() and logs any error from it via klog.
		// The Fetch API has no equivalent manual close step -- the body stream is
		// fully consumed and released by readAllLimited() below, or cancelled by it
		// when over the limit -- and klog is not an allowed dependency (PORTING.md §7),
		// so there is nothing to port here.
		try {
			return await readAllLimited(r, limit);
		} catch (err) {
			if (err instanceof bodyTooLargeError) {
				throw new Error(`get(${quote(u.toString())}): ${err.message}`);
			}
			throw err;
		}
	}

	async readCheckpoint(signal?: AbortSignal): Promise<Uint8Array> {
		return this.#fetch(CheckpointPath, maxCheckpointBytes, signal);
	}

	async readTile(l: bigint, i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return partialOrFullResource(
			p,
			(pp: number, sig?: AbortSignal) => this.#fetch(tilePath(l, i, pp), maxTileBytes, sig),
			signal,
		);
	}

	async readEntryBundle(i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return partialOrFullResource(
			p,
			(pp: number, sig?: AbortSignal) => this.#fetch(entriesPath(i, pp), maxEntryBundleBytes, sig),
			signal,
		);
	}
}

/**
 * omitCredentials is a RequestInit that sets `credentials`. workerd's RequestInit type has no
 * `credentials` member (the runtime ignores it), so the property is declared here for code
 * that type-checks against both the DOM and the Workers types.
 *
 * @internal Has no Go counterpart; also used by internal/witness. See
 * docs/decisions/0197-fetch-credentials-and-redirects.md.
 */
export type omitCredentials = RequestInit & { credentials: "omit" };

/** bodyTooLargeError is what readAllLimited throws for a body over its limit. */
class bodyTooLargeError extends Error {
	constructor(limit: number) {
		super(`response body exceeds the limit of ${limit} bytes`);
		this.name = "bodyTooLargeError";
	}
}

/**
 * readAllLimited reads r's body in full, like Go's io.ReadAll, but stops and throws as
 * soon as more than limit bytes have arrived (or a Content-Length header announces
 * more), cancelling the rest of the body.
 *
 * @internal Has no Go counterpart; also used by internal/witness. See
 * docs/decisions/0195-response-size-caps.md.
 */
export async function readAllLimited(r: Response, limit: number): Promise<Uint8Array> {
	const announced = Number(r.headers.get("Content-Length") ?? Number.NaN);
	if (announced > limit) {
		discardBody(r);
		throw new bodyTooLargeError(limit);
	}
	if (r.body === null) {
		return new Uint8Array(0);
	}
	const reader = r.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.length;
		if (total > limit) {
			reader.cancel().catch(() => undefined);
			throw new bodyTooLargeError(limit);
		}
		chunks.push(value);
	}
	return concatBytes(...chunks);
}
