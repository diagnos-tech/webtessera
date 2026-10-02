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

// A Cloudflare Worker that runs a transparency log in a Durable Object. It appends
// entries over HTTP and serves the log's read API, as https://c2sp.org/tlog-tiles
// specifies it, from the object's storage. See README.md.

import { DurableObject } from "cloudflare:workers";
import {
	type Appender,
	ErrNotExist,
	ErrPushback,
	errorIs,
	type LogReader,
	newAppender,
	newAppendOptions,
	newEntry,
	newPublicationAwaiter,
	type PublicationAwaiter,
} from "webtessera";
import { parseTileIndexPartial, parseTileLevel } from "webtessera/api/layout";
import { newSigner } from "webtessera/note";
import { newDurableObjectDriver } from "webtessera/storage/durableobject";

/** Env holds the bindings wrangler.jsonc and the Worker's secrets declare. */
export interface Env {
	/** LOG is the namespace of the TransparencyLog Durable Object. */
	readonly LOG: DurableObjectNamespace<TransparencyLog>;
	/**
	 * LOG_PRIVATE_KEY is the note signer key the log signs its checkpoints with. The
	 * key's name is the log's origin, the first line of every checkpoint.
	 */
	readonly LOG_PRIVATE_KEY: string;
}

// checkpointIntervalMs is how often the log publishes a checkpoint. POST /add answers
// once a published checkpoint commits to the new entry, so it bounds that latency.
const checkpointIntervalMs = 1000;

// maxEntryBytes is the largest entry a tlog-tiles entry bundle can hold: each entry is
// prefixed with its length as a 16-bit integer, which a larger entry would overflow.
const maxEntryBytes = 0xffff;

// The Cache-Control values follow upstream Tessera's conformance servers: checkpoints
// change with every publication, and a full tile or bundle never changes. A partial
// one does not change either, but once its full successor is written the log may
// garbage collect it and answer for it with the full resource instead.
const checkpointCacheControl = "no-cache";
const fullTileCacheControl = "public, max-age=31536000, immutable";
const partialTileCacheControl = "public, max-age=60";

/**
 * TransparencyLog is a Durable Object holding one transparency log: its entries,
 * tiles and checkpoints all live in the object's storage.
 *
 * Besides answering HTTP requests through fetch, it can be called over RPC by other
 * Workers bound to it: `await env.LOG.getByName("log").add(data)`.
 */
export class TransparencyLog extends DurableObject<Env> {
	// #region durableobject_example
	readonly #log: Promise<{ appender: Appender; reader: LogReader; awaiter: PublicationAwaiter }>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Open the log once per instance, before the object serves its first request.
		// The appender's timers then batch, integrate and publish entries for as long
		// as the instance lives, and the next instance resumes from storage.
		this.#log = ctx.blockConcurrencyWhile(async () => {
			const driver = newDurableObjectDriver({ storage: ctx.storage });
			const opts = newAppendOptions()
				.withCheckpointSigner(newSigner(env.LOG_PRIVATE_KEY))
				.withCheckpointInterval(checkpointIntervalMs);
			const { appender, reader } = await newAppender(driver, opts);
			const awaiter = newPublicationAwaiter((signal) => reader.readCheckpoint(signal), 100);
			return { appender, reader, awaiter };
		});
	}

	/** add appends data to the log and resolves to its index once a published checkpoint commits to it. */
	async add(data: Uint8Array): Promise<bigint> {
		const { appender, awaiter } = await this.#log;
		const [{ index }] = await awaiter.await(appender.add(newEntry(data)));
		return index;
	}
	// #endregion

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/add") {
			return request.method === "POST" ? this.#handleAdd(request) : methodNotAllowed("POST");
		}
		const r = parseResource(url.pathname);
		if (r === undefined) {
			return plain(404, "not found");
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return methodNotAllowed("GET, HEAD");
		}
		if (r.kind === "malformed") {
			return plain(400, `Malformed URL: ${r.reason}`);
		}
		return this.#serve(r, request.method === "HEAD");
	}

	async #handleAdd(request: Request): Promise<Response> {
		// Reject an oversized entry from its declared length when there is one, before
		// buffering it.
		if (Number(request.headers.get("Content-Length") ?? 0) > maxEntryBytes) {
			return plain(413, `entries are limited to ${maxEntryBytes} bytes`);
		}
		const data = new Uint8Array(await request.arrayBuffer());
		if (data.length > maxEntryBytes) {
			return plain(413, `entries are limited to ${maxEntryBytes} bytes`);
		}
		let index: bigint;
		try {
			index = await this.add(data);
		} catch (err) {
			if (errorIs(err, ErrPushback)) {
				return new Response("the log is overloaded; retry later\n", {
					status: 503,
					headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" },
				});
			}
			throw err;
		}
		// The body is the bare decimal index, as Tessera's own personalities answer
		// (`fmt.Fprintf(w, "%d", idx.Index)`), so upstream's hammer and integration test
		// can drive this Worker unmodified.
		return new Response(index.toString(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
	}

	async #serve(r: resource, head: boolean): Promise<Response> {
		const { reader } = await this.#log;
		let data: Uint8Array;
		try {
			data = await read(reader, r);
		} catch (err) {
			if (errorIs(err, ErrNotExist)) {
				return plain(404, "not found");
			}
			throw err;
		}
		const isCheckpoint = r.kind === "checkpoint";
		return new Response(head ? null : data, {
			headers: {
				"Content-Type": isCheckpoint ? "text/plain; charset=utf-8" : "application/octet-stream",
				"Cache-Control": isCheckpoint
					? checkpointCacheControl
					: r.width === 0
						? fullTileCacheControl
						: partialTileCacheControl,
				// The log is public, and webtessera's client verifies it from browsers too.
				"Access-Control-Allow-Origin": "*",
			},
		});
	}
}

/** resource is a tlog-tiles resource the log serves. */
type resource =
	| { readonly kind: "checkpoint" }
	| { readonly kind: "tile"; readonly level: bigint; readonly index: bigint; readonly width: number }
	| { readonly kind: "entries"; readonly index: bigint; readonly width: number };

/** malformed stands for a tile path that does not parse. */
interface malformed {
	readonly kind: "malformed";
	readonly reason: string;
}

/**
 * parseResource returns the resource path names: the checkpoint, a tile at
 * /tile/<L>/<N>[.p/<W>] or an entry bundle at /tile/entries/<N>[.p/<W>], or malformed
 * if a tile path does not parse. It returns undefined for any other path.
 */
function parseResource(path: string): resource | malformed | undefined {
	if (path === "/checkpoint") {
		return { kind: "checkpoint" };
	}
	const m = /^\/tile\/([^/]+)\/(.+)$/.exec(path);
	if (m?.[1] === undefined || m[2] === undefined) {
		return undefined;
	}
	try {
		const { index, width } = parseTileIndexPartial(m[2]);
		if (m[1] === "entries") {
			return { kind: "entries", index, width };
		}
		return { kind: "tile", level: parseTileLevel(m[1]), index, width };
	} catch (err) {
		return { kind: "malformed", reason: err instanceof Error ? err.message : String(err) };
	}
}

/** read reads r from the log, throwing an error caused by ErrNotExist if it does not exist. */
function read(reader: LogReader, r: resource): Promise<Uint8Array> {
	switch (r.kind) {
		case "checkpoint":
			return reader.readCheckpoint();
		case "tile":
			return reader.readTile(r.level, r.index, r.width);
		case "entries":
			return reader.readEntryBundle(r.index, r.width);
	}
}

function plain(status: number, message: string): Response {
	return new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function methodNotAllowed(allow: string): Response {
	return new Response("method not allowed\n", {
		status: 405,
		headers: { "Content-Type": "text/plain; charset=utf-8", Allow: allow },
	});
}

export default {
	/** fetch passes every request to the log, which one Durable Object holds in its entirety. */
	fetch(request, env): Promise<Response> {
		return env.LOG.getByName("log").fetch(request);
	},
} satisfies ExportedHandler<Env>;
