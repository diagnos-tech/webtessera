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

// This file has no upstream counterpart. It maps request paths onto the resources of the
// C2SP tlog-tiles read API (https://c2sp.org/tlog-tiles) and names the HTTP metadata the
// spec prescribes for each, so that the log handler, the S3 mirror sink and any static
// host agree on both. See docs/decisions/0170-http-log-handler.md.

import { CheckpointPath, entriesPath, parseTileIndexPartial, parseTileLevel, tilePath } from "../api/layout/index.ts";

/** MaxResourcePathLength bounds the length of a path parseLogPath will parse. */
export const MaxResourcePathLength = 96;

/** LogResource is one resource of the tlog-tiles read API. */
export type LogResource =
	| { readonly kind: "checkpoint" }
	| { readonly kind: "tile"; readonly level: bigint; readonly index: bigint; readonly width: number }
	| { readonly kind: "entries"; readonly index: bigint; readonly width: number };

/**
 * MalformedPath is what parseLogPath returns for a path inside the tlog-tiles namespace
 * (`tile/...`) that is not a well-formed resource path.
 */
export interface MalformedPath {
	readonly kind: "malformed";
	/** reason explains, for a human, what is wrong with the path. */
	readonly reason: string;
}

/**
 * parseLogPath parses a path relative to the log's prefix, with no leading slash:
 * `checkpoint`, `tile/<L>/<N>[.p/<W>]` or `tile/entries/<N>[.p/<W>]`.
 *
 * It returns undefined for a path outside the tlog-tiles namespace, so that a caller can
 * hand it to some other handler, and a MalformedPath for anything under `tile/` that is
 * not a resource.
 *
 * Only the canonical spelling of a resource is accepted. The spec requires `<L>` and
 * `<W>` to have "no additional leading zeroes" and fixes the encoding of `<N>`; the
 * upstream parsers (`api/layout`) are deliberately lenient about some of that (they read
 * `x000/001` as 1 and `.p/08` as 8), so the parsed resource is formatted again and must
 * reproduce the request path exactly. A client that builds paths with `api/layout`, as
 * every Tessera client does, never notices.
 */
export function parseLogPath(path: string): LogResource | MalformedPath | undefined {
	if (path === CheckpointPath) {
		return { kind: "checkpoint" };
	}
	if (!path.startsWith("tile/")) {
		return undefined;
	}
	// The longest resource path, a partial entry bundle at the largest uint64 index, is 52
	// characters (a level-63 partial tile there is 47). Anything much longer is refused before
	// it reaches the parsers, whose cost grows with the length of what they are given.
	if (path.length > MaxResourcePathLength) {
		return malformed(`longer than ${MaxResourcePathLength} characters`);
	}
	const rest = path.slice("tile/".length);
	const slash = rest.indexOf("/");
	if (slash < 0) {
		return malformed("expected tile/<L>/<N>[.p/<W>] or tile/entries/<N>[.p/<W>]");
	}
	const level = rest.slice(0, slash);
	const index = rest.slice(slash + 1);

	let r: LogResource;
	try {
		const { index: i, width: w } = parseTileIndexPartial(index);
		r =
			level === "entries"
				? { kind: "entries", index: i, width: w }
				: { kind: "tile", level: parseTileLevel(level), index: i, width: w };
	} catch (err) {
		return malformed(err instanceof Error ? err.message : String(err));
	}

	const canonical = resourcePath(r);
	if (canonical !== path) {
		return malformed(`not the canonical encoding of this resource, which is ${canonical}`);
	}
	return r;
}

/** resourcePath returns the path of r relative to the log's prefix, with no leading slash. */
export function resourcePath(r: LogResource): string {
	switch (r.kind) {
		case "checkpoint":
			return CheckpointPath;
		case "tile":
			return tilePath(r.level, r.index, r.width);
		case "entries":
			return entriesPath(r.index, r.width);
	}
}

/**
 * CacheControlPolicy holds the `Cache-Control` values served for the three kinds of
 * resource whose caching differs.
 */
export interface CacheControlPolicy {
	/** checkpoint is used for `checkpoint`, which changes with every publication. */
	readonly checkpoint: string;
	/** full is used for full tiles and entry bundles, which never change. */
	readonly full: string;
	/** partial is used for partial tiles and entry bundles. */
	readonly partial: string;
}

/**
 * DefaultCacheControl is the caching policy the spec asks for.
 *
 * The checkpoint "is mutable, so its headers SHOULD prevent caching beyond a few seconds";
 * `no-cache` is what Tessera's own conformance servers and object-storage drivers send.
 * Tiles and bundles are "immutable, so [their] caching headers SHOULD be long-lived". One
 * year is what Tessera's POSIX conformance server sends; its GCP and AWS drivers send one
 * week (`max-age=604800,immutable`). A full tile or bundle never changes, so the longer
 * lifetime costs nothing and saves the revalidations.
 *
 * A partial resource never changes either, but a log "MAY delete any partial tile once
 * the corresponding full tile is available", and a reader asked for a partial that no
 * published checkpoint implies may answer differently from one moment to the next (see
 * `LogReader.readTile`). A short lifetime keeps a cache from pinning either situation.
 */
export const DefaultCacheControl: CacheControlPolicy = {
	checkpoint: "no-cache",
	full: "public, max-age=31536000, immutable",
	partial: "public, max-age=60",
};

/** CheckpointContentType is the media type the spec gives the checkpoint. */
export const CheckpointContentType = "text/plain; charset=utf-8";

/** TileContentType is the media type the spec gives tiles and entry bundles. */
export const TileContentType = "application/octet-stream";

/**
 * resourceHeaders returns the `Content-Type` and `Cache-Control` headers the tlog-tiles
 * spec prescribes for the resource at path (relative to the log's prefix, with no leading
 * slash), or undefined if path is not a tlog-tiles resource.
 *
 * It is meant for anything that publishes a log's files somewhere other than through
 * newLogHandler: an object-storage upload, a static site generator, a service worker
 * answering from a cache. The S3 sink uses it for every object it writes, and the result
 * can be passed straight to bindings that take HTTP metadata as `Headers` (Cloudflare R2's
 * `httpMetadata`, for one, or a `Response` constructor).
 */
export function resourceHeaders(path: string, policy: CacheControlPolicy = DefaultCacheControl): Headers | undefined {
	const r = parseLogPath(path);
	if (r === undefined || r.kind === "malformed") {
		return undefined;
	}
	return headersFor(r, policy);
}

/** headersFor returns the `Content-Type` and `Cache-Control` headers for r. */
export function headersFor(r: LogResource, policy: CacheControlPolicy): Headers {
	if (r.kind === "checkpoint") {
		return new Headers({ "Content-Type": CheckpointContentType, "Cache-Control": policy.checkpoint });
	}
	return new Headers({
		"Content-Type": TileContentType,
		"Cache-Control": r.width === 0 ? policy.full : policy.partial,
	});
}

function malformed(reason: string): MalformedPath {
	return { kind: "malformed", reason };
}
