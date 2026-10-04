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

// This file has no upstream counterpart. Its nearest relative is `configureTilesReadAPI` in
// tessera/cmd/conformance/mysql/main.go, whose comment observes that it "could be moved
// into the storage API as it's likely this will be the same for any implementation of a
// personality"; this is that move, for every LogReader and every Fetch API runtime. See
// docs/decisions/0170-http-log-handler.md.

import { sha256 } from "@noble/hashes/sha2.js";
import { toHex } from "../internal/gostd/bytes.ts";
import { ErrNotExist, errorIs } from "../internal/gostd/errors.ts";
import type { LogReader } from "../lifecycle.ts";
import { type CorsOptions, corsConfig, preflight } from "./cors.ts";
import { type Handler, methodNotAllowed, normalizePrefix, textResponse } from "./handler.ts";
import { trimToWidth } from "./partial.ts";
import {
	type CacheControlPolicy,
	DefaultCacheControl,
	headersFor,
	type LogResource,
	parseLogPath,
} from "./resources.ts";

/**
 * LogResourceReader is the part of a LogReader the handler reads from. Every LogReader
 * returned by `newAppender` satisfies it, and so does an `HTTPFetcher` from
 * `webtessera/client`, which makes the handler a proxy for a remote log.
 *
 * Such a proxy verifies nothing: it re-serves whatever the remote log answers, and serves
 * full tiles and bundles as immutable for a year, so a single wrong answer from upstream is
 * kept by every cache in front of it. To re-serve a log you do not operate, copy it with
 * newVerifiedMirror from `webtessera/mirror` into storage of your own, which writes only
 * what it has proven against the log's signed checkpoint, and serve that.
 */
export type LogResourceReader = Pick<LogReader, "readCheckpoint" | "readTile" | "readEntryBundle">;

/** LogHandlerOptions configures newLogHandler. */
export interface LogHandlerOptions {
	/** reader is where the handler reads the log's resources from. */
	readonly reader: LogResourceReader;

	/**
	 * prefix is the path the log is mounted at, the tlog-tiles "URL prefix" without its
	 * origin: with `/logs/a`, the checkpoint is served at `/logs/a/checkpoint`. Defaults to
	 * `/`.
	 */
	readonly prefix?: string;

	/**
	 * cors adds the headers that let scripts on other origins read the log, which is what
	 * webtessera's own client needs to verify the log from a browser tab. It is off by
	 * default because whether a log is readable cross-origin is the operator's decision;
	 * `true` allows every origin.
	 */
	readonly cors?: boolean | CorsOptions;

	/** cacheControl overrides some or all of {@link DefaultCacheControl}. */
	readonly cacheControl?: Partial<CacheControlPolicy>;

	/**
	 * etag adds an `ETag` (a SHA-256 of the body) to every response and answers a matching
	 * `If-None-Match` with 304 Not Modified, so that a poller re-reading an unchanged
	 * checkpoint transfers nothing. Defaults to true.
	 */
	readonly etag?: boolean;

	/**
	 * onError is told about every failure that turns into a 500 response, which carries no
	 * detail. A missing resource is not a failure: it is a 404.
	 */
	readonly onError?: (err: unknown, request: Request) => void;
}

const allowedMethods = "GET, HEAD";

/**
 * newLogHandler returns a {@link Handler} that serves a log over the tlog-tiles read API
 * (https://c2sp.org/tlog-tiles): `GET` and `HEAD` on `<prefix>/checkpoint`,
 * `<prefix>/tile/<L>/<N>[.p/<W>]` and `<prefix>/tile/entries/<N>[.p/<W>]`.
 *
 * Requests for any other path resolve to undefined, so the handler composes with others
 * (see {@link combineHandlers}). Inside the tlog-tiles namespace it answers 400 for a
 * malformed or non-canonical tile path (with the canonical spelling in the body), 404 when
 * the reader reports `ErrNotExist`, 405 for other methods, and 500, reported to `onError`,
 * for anything else. It never redirects: "The resources defined in this document MUST NOT
 * serve redirect responses."
 *
 * Writing to the log is the personality's business and is not served here; see
 * {@link addResponse} for the conventional answer to `POST /add`.
 */
export function newLogHandler(options: LogHandlerOptions): Handler {
	const prefix = normalizePrefix(options.prefix);
	const policy: CacheControlPolicy = { ...DefaultCacheControl, ...definedOnly(options.cacheControl) };
	const cors = corsConfig(options.cors, ["ETag"]);
	const useETag = options.etag ?? true;
	const reader = options.reader;

	return async (request: Request): Promise<Response | undefined> => {
		const pathname = new URL(request.url).pathname;
		if (!pathname.startsWith(prefix)) {
			return undefined;
		}
		const r = parseLogPath(pathname.slice(prefix.length));
		if (r === undefined) {
			return undefined;
		}

		if (request.method === "OPTIONS" && cors !== undefined) {
			return preflight(request, cors, allowedMethods);
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return methodNotAllowed(allowedMethods, cors?.simple);
		}
		if (r.kind === "malformed") {
			return textResponse(400, `Malformed URL: ${r.reason}`, cors?.simple);
		}

		let data: Uint8Array;
		try {
			// Not request.signal: see the note on read.
			data = trimToWidth(r, await read(reader, r));
		} catch (err) {
			if (errorIs(err, ErrNotExist)) {
				return textResponse(404, "not found", cors?.simple);
			}
			options.onError?.(err, request);
			return textResponse(500, "internal server error", cors?.simple);
		}

		const headers = headersFor(r, policy);
		for (const [k, v] of cors?.simple ?? []) {
			headers.set(k, v);
		}
		if (useETag) {
			const etag = `"${toHex(sha256(data).subarray(0, 16))}"`;
			headers.set("ETag", etag);
			if (etagMatches(request.headers.get("If-None-Match"), etag)) {
				return new Response(null, { status: 304, headers });
			}
		}
		if (request.method === "HEAD") {
			headers.set("Content-Length", String(data.length));
			return new Response(null, { status: 200, headers });
		}
		// The DOM typings only accept a Uint8Array backed by a plain ArrayBuffer as a
		// BodyInit, a typing limitation rather than a runtime one: every Fetch API runtime
		// accepts any ArrayBufferView.
		return new Response(data as BodyInit, { status: 200, headers });
	};
}

/**
 * read reads r from the log, throwing an error caused by ErrNotExist if it does not exist.
 *
 * It is not given the request's signal, and the handler never reads `request.signal`: what
 * that signal means differs by runtime (behind toNodeListener it never aborts; on Deno 2 it
 * aborts once every response is sent, and the first read of it prints a warning about that
 * legacy behaviour; on Bun and workerd it aborts when the client goes away), and one read
 * of one resource is too little work to be worth cancelling. A client that leaves costs at
 * most the read in flight.
 */
function read(reader: LogResourceReader, r: LogResource): Promise<Uint8Array> {
	switch (r.kind) {
		case "checkpoint":
			return reader.readCheckpoint();
		case "tile":
			return reader.readTile(r.level, r.index, r.width);
		case "entries":
			return reader.readEntryBundle(r.index, r.width);
	}
}

/**
 * etagMatches implements the weak comparison RFC 9110 §13.1.2 specifies for
 * `If-None-Match`: any listed tag, or `*`, that matches ignoring a `W/` prefix.
 */
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
	if (ifNoneMatch === null) {
		return false;
	}
	for (const raw of ifNoneMatch.split(",")) {
		const tag = raw.trim();
		if (tag === "*" || (tag.startsWith("W/") ? tag.slice(2) : tag) === etag) {
			return true;
		}
	}
	return false;
}

/** definedOnly drops the properties of o that are undefined, so they do not override defaults. */
function definedOnly<T extends object>(o: T | undefined): Partial<T> {
	if (o === undefined) {
		return {};
	}
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
