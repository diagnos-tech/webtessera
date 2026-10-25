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

// This file has no upstream counterpart. Upstream's object-storage drivers (storage/aws,
// storage/gcp) publish a log into a bucket with vendor SDKs; this sink publishes one into a
// Cloudflare R2 bucket through a Worker's own binding, with the metadata, immutability and
// checkpoint ordering that make the bucket a correct static tlog-tiles log. See
// docs/decisions/0248-r2-binding-sink.md.

import { CheckpointPath } from "../api/layout/index.ts";
import { positiveInteger } from "../http/handler.ts";
import { type CacheControlPolicy, DefaultCacheControl, resourceHeaders } from "../http/resources.ts";
import { bytesEqual } from "../internal/gostd/bytes.ts";
import { checkpointUnsafe } from "../internal/parse/parse.ts";
import { MaxResourceBytes } from "./fetch.ts";
import { unrecoverable } from "./retry.ts";
import type { Sink } from "./sink.ts";

/** R2ObjectLike is the part of R2's R2Object the sink reads: the entity tag of what is stored. */
export interface R2ObjectLike {
	readonly etag: string;
	readonly size: number;
}

/** R2ObjectBodyLike is the part of R2's R2ObjectBody the sink reads. */
export interface R2ObjectBodyLike extends R2ObjectLike {
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** R2PutOptionsLike is the part of R2's R2PutOptions the sink sets. */
export interface R2PutOptionsLike {
	onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
	httpMetadata?: { contentType?: string; cacheControl?: string };
}

/**
 * R2BucketLike is the part of a Cloudflare Workers R2 binding (`R2Bucket`) newR2Sink uses. It
 * is declared structurally, so that this package does not depend on
 * @cloudflare/workers-types: a Worker passes its binding (`env.LOGS`) as it is.
 *
 * `put` resolves to null when its `onlyIf` condition does not hold, as R2's does.
 */
export interface R2BucketLike {
	get(key: string): Promise<R2ObjectBodyLike | null>;
	put(key: string, value: Uint8Array, options?: R2PutOptionsLike): Promise<R2ObjectLike | null>;
}

/** R2SinkOptions configures newR2Sink. */
export interface R2SinkOptions {
	/** prefix is prepended to every key, to keep several logs in one bucket: `logs/a/`. Defaults to "". */
	readonly prefix?: string;
	/** cacheControl overrides the `Cache-Control` stored with each object; see DefaultCacheControl. */
	readonly cacheControl?: Partial<CacheControlPolicy>;
	/**
	 * conditionalWrites creates every tile and entry bundle, which never change once written,
	 * only if nothing is stored under its key yet, and accepts an object already there only
	 * if it holds exactly the bytes being written; anything else fails the put, with an
	 * error marked unrecoverable, since the bucket then holds part of a different tree.
	 * Defaults to true.
	 */
	readonly conditionalWrites?: boolean;
	/**
	 * checkpointAttempts bounds how many times a checkpoint write retries its compare-and-swap
	 * when another writer replaced the checkpoint in between. Defaults to 5.
	 */
	readonly checkpointAttempts?: number;
	/** maxObjectBytes caps the objects get reads. Defaults to the largest possible entry bundle. */
	readonly maxObjectBytes?: number;
}

/**
 * newR2Sink returns a Sink that stores a log in a Cloudflare R2 bucket through a Worker's R2
 * binding, so that the bucket, served by a custom domain or a public bucket URL, is the log's
 * tlog-tiles read API as it is.
 *
 * ```ts
 * const target = newSinkTarget(newR2Sink(env.TRANSPARENCY, { prefix: "audit/v1/" }));
 * await new Mirror({ source: log.reader, target, numWorkers: 4 }).run();
 * ```
 *
 * A bare R2 binding is already a Sink; this one adds what a published log needs:
 *
 *   - each object is stored with the `Content-Type` and `Cache-Control` tlog-tiles
 *     prescribes for its path, which R2 serves back as response headers;
 *   - tiles and entry bundles are created, never overwritten, and an object already there
 *     must hold the same bytes (see {@link R2SinkOptions.conditionalWrites});
 *   - the checkpoint only ever grows: it is replaced by compare-and-swap on its entity tag,
 *     and a checkpoint for a smaller tree than the one stored is not written at all, so two
 *     mirror runs that overlap (a retried queue message, a cron next to a request) can never
 *     publish an older checkpoint over a newer one, which every client and witness would see
 *     as the log going back in time.
 */
export function newR2Sink(bucket: R2BucketLike, options: R2SinkOptions = {}): R2Sink {
	return new R2Sink(bucket, options);
}

/** R2Sink is a Sink backed by a Cloudflare R2 binding. Construct it with {@link newR2Sink}. */
export class R2Sink implements Sink {
	readonly #bucket: R2BucketLike;
	readonly #o: R2SinkOptions;
	readonly #policy: CacheControlPolicy;
	readonly #attempts: number;
	readonly #maxObjectBytes: number;

	/** @internal Construct via {@link newR2Sink}. */
	constructor(bucket: R2BucketLike, options: R2SinkOptions) {
		const has = (name: string): boolean =>
			typeof (bucket as unknown as Record<string, unknown> | null)?.[name] === "function";
		if (!has("get") || !has("put")) {
			throw new TypeError("newR2Sink takes a Workers R2 binding (env.BUCKET), or an object with its get and put");
		}
		this.#bucket = bucket;
		this.#o = options;
		this.#policy = { ...DefaultCacheControl, ...options.cacheControl };
		this.#attempts = positiveInteger("R2 sink: checkpointAttempts", options.checkpointAttempts ?? 5);
		this.#maxObjectBytes = positiveInteger("R2 sink: maxObjectBytes", options.maxObjectBytes ?? MaxResourceBytes);
	}

	/** put stores data under key (after the sink's prefix). */
	async put(key: string, data: Uint8Array): Promise<void> {
		const headers = resourceHeaders(key, this.#policy);
		const httpMetadata =
			headers === undefined
				? undefined
				: {
						contentType: headers.get("Content-Type") ?? "application/octet-stream",
						cacheControl: headers.get("Cache-Control") ?? "no-cache",
					};
		const full = this.#key(key);
		if (key === CheckpointPath) {
			return this.#putCheckpoint(full, data, httpMetadata);
		}
		// Every tlog-tiles resource but the checkpoint is immutable. Anything else (a key that
		// is not a log resource) is the caller's, and is simply written.
		if (headers === undefined || this.#o.conditionalWrites === false) {
			await this.#bucket.put(full, data, httpMetadata === undefined ? {} : { httpMetadata });
			return;
		}
		const created = await this.#bucket.put(full, data, {
			onlyIf: { etagDoesNotMatch: "*" },
			...(httpMetadata === undefined ? {} : { httpMetadata }),
		});
		if (created === null) {
			await this.#checkStored(full, data);
		}
	}

	/** get returns the object stored under key (after the sink's prefix), or undefined if there is none. */
	async get(key: string): Promise<Uint8Array | undefined> {
		return (await this.#readCapped(this.#key(key), this.#maxObjectBytes))?.bytes;
	}

	/**
	 * _withPrefix returns a sink over the same bucket that puts extra after this sink's
	 * prefix, so that newSinkTarget can hand it keys relative to the log, from which the
	 * metadata, immutability and checkpoint handling of each object are derived.
	 *
	 * @internal
	 */
	_withPrefix(extra: string): R2Sink {
		return new R2Sink(this.#bucket, { ...this.#o, prefix: `${this.#o.prefix ?? ""}${extra}` });
	}

	/**
	 * putCheckpoint replaces the stored checkpoint with data unless the stored one is for a
	 * larger tree, by compare-and-swap on the stored checkpoint's entity tag: another writer
	 * that replaced it in between makes the swap fail, and the decision is taken again
	 * against what that writer stored.
	 */
	async #putCheckpoint(
		full: string,
		data: Uint8Array,
		httpMetadata: R2PutOptionsLike["httpMetadata"] | undefined,
	): Promise<void> {
		// A sink publishes checkpoints, not arbitrary bytes under the checkpoint's key: one
		// that does not parse is refused before anything is read or written.
		const { size } = checkpointUnsafe(data);
		for (let attempt = 0; attempt < this.#attempts; attempt++) {
			const stored = await this.#readCapped(full, this.#maxObjectBytes);
			if (stored !== undefined) {
				if (bytesEqual(stored.bytes, data)) {
					return;
				}
				// Larger wins; at the same size the newer write wins (a checkpoint republished
				// with fresh cosignatures, say). A stored object that is no checkpoint at all is
				// replaced.
				if (storedSize(stored.bytes) > size) {
					return;
				}
			}
			const swapped = await this.#bucket.put(full, data, {
				onlyIf: stored === undefined ? { etagDoesNotMatch: "*" } : { etagMatches: stored.etag },
				...(httpMetadata === undefined ? {} : { httpMetadata }),
			});
			if (swapped !== null) {
				return;
			}
		}
		throw new Error(
			`R2 PUT ${full}: the stored checkpoint changed under each of ${this.#attempts} attempts to replace it; ` +
				"another writer is publishing this log at the same time",
		);
	}

	/**
	 * checkStored makes sure that the object a conditional write found under key holds
	 * exactly data. A resource is the same at a path in every copy of one log, so different
	 * bytes mean that what the bucket holds belongs to another tree, which trying again
	 * cannot repair.
	 */
	async #checkStored(full: string, data: Uint8Array): Promise<void> {
		// An object larger than data cannot hold data: it is not read beyond that.
		const stored = await this.#read(full, data.length);
		if (stored === undefined) {
			// Deleted since the write found it: the next attempt writes it afresh.
			throw new Error(`R2 PUT ${full}: the object already stored there has since been deleted`);
		}
		if (stored === "too large" || !bytesEqual(stored.bytes, data)) {
			throw unrecoverable(
				new Error(
					`R2 PUT ${full}: a different object is already stored there, and tlog-tiles resources are immutable; ` +
						"the bucket holds part of another tree, which must be removed by hand",
				),
			);
		}
	}

	/**
	 * read returns what is stored under full, "too large" if that is more than max bytes, or
	 * undefined if nothing is.
	 */
	async #read(full: string, max: number): Promise<{ bytes: Uint8Array; etag: string } | "too large" | undefined> {
		const o = await this.#bucket.get(full);
		if (o === null) {
			return undefined;
		}
		if (o.size > max) {
			return "too large";
		}
		return { bytes: new Uint8Array(await o.arrayBuffer()), etag: o.etag };
	}

	/** readCapped is read, failing for an object larger than max. */
	async #readCapped(full: string, max: number): Promise<{ bytes: Uint8Array; etag: string } | undefined> {
		const o = await this.#read(full, max);
		if (o === "too large") {
			throw new RangeError(`R2 GET ${full}: the object is larger than the ${max} bytes this sink reads`);
		}
		return o;
	}

	#key(key: string): string {
		const full = `${this.#o.prefix ?? ""}${key}`;
		if (full === "" || full.split("/").some((s) => s === "." || s === "..")) {
			// R2 would store such a key as it is, but every HTTP client resolves the dot
			// segments away, so the object could never be read back at its URL.
			throw new Error(`invalid object key ${JSON.stringify(full.slice(0, 96))}`);
		}
		return full;
	}
}

/** storedSize is the tree size of the stored checkpoint, or -1 if it does not parse. */
function storedSize(cp: Uint8Array): bigint {
	try {
		return checkpointUnsafe(cp).size;
	} catch {
		return -1n;
	}
}
