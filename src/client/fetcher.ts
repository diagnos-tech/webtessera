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

import { CheckpointPath, entriesPath, tilePath } from "../api/layout/index.ts";
import { partialOrFullResource } from "../internal/fetcher/fallback.ts";
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
 * newHTTPFetcher creates a new HTTPFetcher for the log rooted at the given URL, using
 * the provided fetch function.
 *
 * rootURL should end in a trailing slash.
 * c may be undefined, in which case the platform's global `fetch` will be used.
 *
 * Port note: Go returns `(*HTTPFetcher, error)`, but the error is always nil — nothing
 * in this function can fail. Dropped, matching the precedent set by
 * `HashTile.marshalText` (api/state.ts) for a Go error return that can never actually
 * occur.
 */
export function newHTTPFetcher(rootURL: URL, c?: FetchFn): HTTPFetcher {
	if (!rootURL.toString().endsWith("/")) {
		rootURL.pathname += "/";
	}
	return new HTTPFetcher(c ?? fetch, rootURL);
}

/** HTTPFetcher knows how to fetch log artifacts from a log being served via HTTP. */
export class HTTPFetcher {
	readonly #c: FetchFn;
	readonly #rootURL: URL;
	#authHeader = "";

	/** @internal Stands in for Go's `&HTTPFetcher{...}` composite literal; construct via {@link newHTTPFetcher}. */
	constructor(c: FetchFn, rootURL: URL) {
		this.#c = c;
		this.#rootURL = rootURL;
	}

	/** setAuthorizationHeader sets the value to be used with an Authorization: header for every request made by this fetcher. */
	setAuthorizationHeader(v: string): void {
		this.#authHeader = v;
	}

	async #fetch(p: string, signal?: AbortSignal): Promise<Uint8Array> {
		const u = new URL(p, this.#rootURL);
		const headers: Record<string, string> = {};
		if (this.#authHeader !== "") {
			headers.Authorization = this.#authHeader;
		}

		const init: RequestInit = { method: "GET", headers };
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
		// fully consumed and released by arrayBuffer() below -- and klog is not an
		// allowed dependency (PORTING.md §7), so there is nothing to port here.
		return new Uint8Array(await r.arrayBuffer());
	}

	async readCheckpoint(signal?: AbortSignal): Promise<Uint8Array> {
		return this.#fetch(CheckpointPath, signal);
	}

	async readTile(l: bigint, i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return partialOrFullResource(p, (pp: number, sig?: AbortSignal) => this.#fetch(tilePath(l, i, pp), sig), signal);
	}

	async readEntryBundle(i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> {
		return partialOrFullResource(p, (pp: number, sig?: AbortSignal) => this.#fetch(entriesPath(i, pp), sig), signal);
	}
}
