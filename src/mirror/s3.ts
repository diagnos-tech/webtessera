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

// This file has no upstream counterpart. Upstream's own object-storage drivers (storage/aws,
// storage/gcp) use vendor SDKs, which cannot run in a browser or a Worker; this sink speaks
// the S3 REST API's two calls it needs, PutObject and GetObject, over fetch, signed with
// ./sigv4.ts. See docs/decisions/0175-mirror-sinks.md.

import { sha256 } from "@noble/hashes/sha2.js";
import type { FetchFn, omitCredentials } from "../client/fetcher.ts";
import { positiveInteger } from "../http/handler.ts";
import { type CacheControlPolicy, DefaultCacheControl, resourceHeaders } from "../http/resources.ts";
import { bytesEqual, toHex } from "../internal/gostd/bytes.ts";
import { errorIs } from "../internal/gostd/errors.ts";
import { errResponseTooLarge, isRedirect, MaxResourceBytes, readCapped } from "./fetch.ts";
import { isRecoverable, retry, unrecoverable } from "./retry.ts";
import { signV4, uriEncode } from "./sigv4.ts";
import type { Sink } from "./sink.ts";

/** S3SinkOptions configures newS3Sink. */
export interface S3SinkOptions {
	/**
	 * endpoint is the service's base URL, without the bucket: for example
	 * `https://s3.us-east-1.amazonaws.com` (AWS S3), `https://<account>.r2.cloudflarestorage.com`
	 * (Cloudflare R2), `https://storage.googleapis.com` (Google Cloud Storage's XML API),
	 * `https://s3.<region>.backblazeb2.com` (Backblaze B2) or `http://localhost:9000` (MinIO).
	 */
	readonly endpoint: string | URL;
	readonly bucket: string;
	/** region is the signing region: the bucket's region for AWS and B2, `auto` for R2 and GCS. */
	readonly region: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	/** sessionToken accompanies temporary credentials (AWS STS, for example). */
	readonly sessionToken?: string;
	/** prefix is prepended to every key, to keep several logs in one bucket: `logs/a/`. */
	readonly prefix?: string;
	/**
	 * addressing chooses between path-style URLs (`<endpoint>/<bucket>/<key>`), which every
	 * S3-compatible service accepts and which need no DNS for the bucket, and virtual-hosted
	 * ones (`<bucket>.<endpoint host>/<key>`), which AWS prefers. Defaults to `path`.
	 */
	readonly addressing?: "path" | "virtual-host";
	/** fetch makes the requests. Defaults to the global fetch. */
	readonly fetch?: FetchFn;
	/** attempts is how many times a request that fails transiently is tried. Defaults to 3. */
	readonly attempts?: number;
	/**
	 * conditionalWrites sends `If-None-Match: *` with every tile and entry bundle, which
	 * never change once written, so that the service refuses to overwrite one that is
	 * already there. The sink then reads the stored object back and accepts the refusal
	 * only if it holds exactly the bytes being written; anything else fails the put, with
	 * an error marked unrecoverable, since the bucket then holds part of a different tree.
	 * AWS S3, Cloudflare R2 and MinIO honour the header; services that ignore it simply
	 * overwrite. Set it to false for a service that rejects the header outright. Defaults
	 * to true. The checkpoint, which does change, is always overwritten.
	 */
	readonly conditionalWrites?: boolean;
	/** cacheControl overrides the `Cache-Control` stored with each object; see DefaultCacheControl. */
	readonly cacheControl?: Partial<CacheControlPolicy>;
	/** maxObjectBytes caps the objects get reads. Defaults to the largest possible entry bundle. */
	readonly maxObjectBytes?: number;
	/** now is the clock requests are signed with. Defaults to the system clock. */
	readonly now?: () => Date;
}

/**
 * S3Error reports a request the service refused. It carries the HTTP status and the S3
 * error code, and never the request's credentials, signature or the service's full answer.
 */
export class S3Error extends Error {
	readonly status: number;
	/** code is the S3 error code (`AccessDenied`, `SignatureDoesNotMatch`, ...), if the service sent one. */
	readonly code: string | undefined;

	constructor(operation: string, status: number, code: string | undefined) {
		super(`${operation}: ${status}${code === undefined ? "" : ` ${code}`}`);
		this.name = "S3Error";
		this.status = status;
		this.code = code;
	}
}

/**
 * newS3Sink returns a Sink that stores objects in a bucket of any service that speaks the S3
 * API, signing requests with AWS Signature Version 4: AWS S3, Cloudflare R2, Google Cloud
 * Storage (XML API, with HMAC keys), Backblaze B2, MinIO, Ceph, Wasabi and the like.
 *
 * ```ts
 * const sink = newS3Sink({
 *   endpoint: "https://s3.eu-west-1.amazonaws.com",
 *   bucket: "my-log-mirror",
 *   region: "eu-west-1",
 *   accessKeyId,
 *   secretAccessKey,
 * });
 * ```
 *
 * Each object is stored with the `Content-Type` and `Cache-Control` tlog-tiles prescribes for
 * its path, so a bucket served publicly (directly, through a CDN, or as a website) serves the
 * log correctly as it is. Bodies are signed (`x-amz-content-sha256` is their SHA-256), and
 * requests never follow redirects, so credentials are only ever sent to the endpoint
 * configured, and carry no ambient credentials (cookies). Network failures, 429s and 5xx
 * answers are retried.
 */
export function newS3Sink(options: S3SinkOptions): S3Sink {
	return new S3Sink(options);
}

/** S3Sink is a Sink backed by an S3-compatible bucket. Construct it with {@link newS3Sink}. */
export class S3Sink implements Sink {
	readonly #o: S3SinkOptions;
	readonly #endpoint: URL;
	readonly #policy: CacheControlPolicy;
	readonly #attempts: number;
	readonly #maxObjectBytes: number;

	/** @internal Construct via {@link newS3Sink}. */
	constructor(options: S3SinkOptions) {
		this.#o = options;
		this.#endpoint = new URL(options.endpoint);
		if (this.#endpoint.search !== "" || this.#endpoint.hash !== "") {
			throw new Error("the S3 endpoint must not have a query or fragment");
		}
		if (options.bucket === "" || options.bucket.includes("/")) {
			throw new Error("the S3 bucket name must be non-empty and contain no slash");
		}
		this.#policy = { ...DefaultCacheControl, ...options.cacheControl };
		this.#attempts = positiveInteger("S3 sink: attempts", options.attempts ?? 3);
		this.#maxObjectBytes = positiveInteger("S3 sink: maxObjectBytes", options.maxObjectBytes ?? MaxResourceBytes);
	}

	/** put stores data under key (after the sink's prefix). */
	async put(key: string, data: Uint8Array): Promise<void> {
		const headers = resourceHeaders(key, this.#policy);
		const h: [string, string][] = [
			["content-type", headers?.get("Content-Type") ?? "application/octet-stream"],
			["x-amz-content-sha256", toHex(sha256(data))],
		];
		const cacheControl = headers?.get("Cache-Control");
		if (cacheControl !== null && cacheControl !== undefined) {
			h.push(["cache-control", cacheControl]);
		}
		// Every tlog-tiles resource but the checkpoint is immutable.
		const conditional = (this.#o.conditionalWrites ?? true) && headers !== undefined && key !== "checkpoint";
		if (conditional) {
			h.push(["if-none-match", "*"]);
		}
		let exists = false;
		await this.#request("PUT", key, h, data, async (r) => {
			// "Precondition Failed": an object is already stored under the key.
			if (r.status === 200 || (conditional && r.status === 412)) {
				exists = r.status === 412;
				await discard(r);
				return true;
			}
			return false;
		});
		if (exists) {
			await this.#checkStored(key, data);
		}
	}

	/** get returns the object stored under key (after the sink's prefix), or undefined if there is none. */
	get(key: string): Promise<Uint8Array | undefined> {
		return this.#get(key, this.#maxObjectBytes);
	}

	/**
	 * _withPrefix returns a sink over the same bucket that puts extra after this sink's
	 * prefix, so that newSinkTarget can hand it keys relative to the log, from which the
	 * metadata and conditional writes of each object are derived.
	 *
	 * @internal
	 */
	_withPrefix(extra: string): S3Sink {
		return new S3Sink({ ...this.#o, prefix: `${this.#o.prefix ?? ""}${extra}` });
	}

	/**
	 * checkStored makes sure that the object a conditional write found under key holds
	 * exactly data. A resource is the same at a path in every copy of one log, so different
	 * bytes mean that what the bucket holds belongs to another tree: an earlier run copied
	 * from a source that has since served a different history. That cannot be repaired by
	 * trying again, and the error says so.
	 */
	async #checkStored(key: string, data: Uint8Array): Promise<void> {
		let stored: Uint8Array | undefined;
		try {
			stored = await this.#get(key, data.length);
		} catch (err) {
			// An object larger than data cannot hold data.
			throw errorIs(err, errResponseTooLarge) ? this.#conflict(key) : err;
		}
		if (stored === undefined) {
			// Deleted since the write found it: the next attempt writes it afresh.
			throw new Error(`${this.#operation("PUT", key)}: the object already stored there has since been deleted`);
		}
		if (!bytesEqual(stored, data)) {
			throw this.#conflict(key);
		}
	}

	#conflict(key: string): Error {
		return unrecoverable(
			new Error(
				`${this.#operation("PUT", key)}: a different object is already stored there, and tlog-tiles resources ` +
					"are immutable; the bucket holds part of another tree, which must be removed by hand",
			),
		);
	}

	async #get(key: string, max: number): Promise<Uint8Array | undefined> {
		let body: Uint8Array | undefined;
		await this.#request("GET", key, [["x-amz-content-sha256", emptyHash]], undefined, async (r) => {
			if (r.status === 404) {
				await discard(r);
				body = undefined;
				return true;
			}
			if (r.status === 200) {
				body = await readCapped(r, max);
				return true;
			}
			return false;
		});
		return body;
	}

	#operation(method: "PUT" | "GET", key: string): string {
		return `S3 ${method} ${this.#o.bucket}/${this.#o.prefix ?? ""}${key}`;
	}

	/**
	 * request signs and sends one request, retrying transient failures. accept handles a
	 * response it understands and returns true; anything else is an error.
	 */
	async #request(
		method: "PUT" | "GET",
		key: string,
		headers: [string, string][],
		body: Uint8Array | undefined,
		accept: (r: Response) => Promise<boolean>,
	): Promise<void> {
		const url = this.#url(key);
		const operation = this.#operation(method, key);
		const f = this.#o.fetch ?? fetch;
		await retry(
			async () => {
				const now = (this.#o.now ?? (() => new Date()))();
				const signed = signV4({
					method,
					url,
					headers,
					payloadHash: headers.find(([k]) => k === "x-amz-content-sha256")?.[1] ?? emptyHash,
					credentials: {
						accessKeyId: this.#o.accessKeyId,
						secretAccessKey: this.#o.secretAccessKey,
						...(this.#o.sessionToken === undefined ? {} : { sessionToken: this.#o.sessionToken }),
					},
					region: this.#o.region,
					service: "s3",
					now,
				});
				const init: omitCredentials = {
					method,
					headers: [...headers, ...signed.headers] as [string, string][],
					// Never follow a redirect: it would carry the signed request, credentials
					// and all, somewhere other than the endpoint configured. And send no
					// ambient credentials either: a page's cookies for the endpoint's origin
					// have no place in a signed request. See
					// docs/decisions/0213-rqlite-and-s3-requests-omit-credentials-and-refuse-redirects.md.
					credentials: "omit",
					redirect: "manual",
				};
				if (body !== undefined) {
					init.body = body as BodyInit;
				}
				let r: Response;
				try {
					r = await f(url.toString(), init);
				} catch (err) {
					throw new Error(`${operation}: ${err instanceof Error ? err.message : String(err)}`);
				}
				if (await accept(r)) {
					return;
				}
				throw await refusal(operation, r);
			},
			{ attempts: this.#attempts, retryIf: isTransient },
		);
	}

	#url(key: string): URL {
		const full = `${this.#o.prefix ?? ""}${key}`;
		const segments = full.split("/");
		if (full === "" || segments.some((s) => s === "." || s === "..")) {
			// fetch would resolve such segments away and address a different object.
			throw new Error(`invalid object key ${JSON.stringify(full.slice(0, 96))}`);
		}
		const u = new URL(this.#endpoint);
		const base = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
		const path = uriEncode(full, true);
		if ((this.#o.addressing ?? "path") === "virtual-host") {
			u.hostname = `${this.#o.bucket}.${u.hostname}`;
			u.pathname = `${base}${path}`;
		} else {
			u.pathname = `${base}${uriEncode(this.#o.bucket, false)}/${path}`;
		}
		return u;
	}
}

const emptyHash = toHex(sha256(new Uint8Array(0)));

/** isTransient reports whether a failed request is worth trying again. */
function isTransient(err: unknown): boolean {
	if (!isRecoverable(err) || errorIs(err, errResponseTooLarge)) {
		return false;
	}
	if (err instanceof S3Error) {
		// 409 is S3's answer to two conditional writes of the same key racing.
		return err.status === 429 || err.status === 409 || err.status >= 500;
	}
	// Anything else is a network failure.
	return true;
}

/**
 * refusal turns a response the sink does not accept into an S3Error, keeping only the S3
 * error code from the body: the rest of an S3 error document can echo the string to sign
 * and the canonical request, which have no business in logs.
 */
async function refusal(operation: string, r: Response): Promise<S3Error> {
	if (isRedirect(r)) {
		await discard(r);
		return new S3Error(`${operation} (redirect refused)`, r.status, undefined);
	}
	let code: string | undefined;
	try {
		const text = new TextDecoder().decode(await readCapped(r, 64 << 10));
		const m = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(text);
		code = m?.[1];
	} catch {
		code = undefined;
	}
	return new S3Error(operation, r.status, code);
}

async function discard(r: Response): Promise<void> {
	await r.body?.cancel().catch(() => undefined);
}
