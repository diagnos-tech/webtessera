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

// This file has no upstream counterpart. It implements the ObjectStore contract on
// Cloudflare Durable Object storage so that the shared storage driver can keep a log
// inside a Durable Object. See docs/decisions/0120-durable-object-object-store.md,
// docs/decisions/0121-durable-object-in-process-locks.md,
// docs/decisions/0122-durable-object-durability-and-timers.md and
// docs/decisions/0123-durable-object-public-api.md.

import type { FetchFn } from "../../client/fetcher.ts";
import { toHex } from "../../internal/gostd/bytes.ts";
import { Mutex } from "../../internal/gostd/sync.ts";
import { newObjectStoreDriver, type ObjectStoreDriver } from "../objectstore/driver.ts";
import { NamedLocks } from "../objectstore/namedlocks.ts";
import type { ObjectInfo, ObjectStore } from "../objectstore/objectstore.ts";

/**
 * DefaultMaxValueBytes is the default for DurableObjectObjectStoreOptions.maxValueBytes.
 *
 * KV-backed Durable Objects reject values whose serialized form exceeds 128 KiB, and
 * SQLite-backed ones accept about 2 MB, so the default fits both. The 1 KiB below the
 * KV limit is headroom for the serialization framing and the record fields stored
 * next to an object's bytes, which together come to well under 200 bytes.
 */
export const DefaultMaxValueBytes = 127 * 1024;

// maxKeysPerCall is the most keys a single Durable Object storage get, put or delete
// call may name. The runtime rejects larger calls in production, although local
// workerd does not enforce the limit. deletePrefix also lists keys in pages of this
// size, so that each page is deleted by one call.
const maxKeysPerCall = 128;

// chunkSeparator separates an object's key from the suffix that names one of its
// chunks. Keys may not contain it, exactly as POSIX paths may not contain NUL, which
// is what guarantees that a prefix selects an object's chunks if and only if it
// selects the object: a prefix longer than the key would have to contain it.
const chunkSeparator = "\u0000";

// torn is what DurableObjectObjectStore's read reports when it raced with a write.
const torn = Symbol("torn");

/**
 * DurableObjectListOptionsLike is the subset of the runtime's DurableObjectListOptions
 * that DurableObjectObjectStore passes to list.
 */
export interface DurableObjectListOptionsLike {
	readonly prefix?: string;
	readonly startAfter?: string;
	readonly limit?: number;
	readonly noCache?: boolean;
}

/**
 * DurableObjectTransactionLike is the subset of the runtime's DurableObjectTransaction
 * that DurableObjectObjectStore uses.
 */
export interface DurableObjectTransactionLike {
	get(key: string): Promise<unknown>;
	put(entries: Record<string, unknown>): Promise<void>;
	delete(keys: string[]): Promise<number>;
	list(options: DurableObjectListOptionsLike): Promise<Map<string, unknown>>;
}

/**
 * DurableObjectStorageLike is the subset of the runtime's DurableObjectStorage that
 * DurableObjectObjectStore uses.
 *
 * It is declared structurally so that this package does not depend on
 * @cloudflare/workers-types: a Durable Object passes its `ctx.storage`, which
 * satisfies this interface whether the object is KV-backed or SQLite-backed.
 */
export interface DurableObjectStorageLike {
	get(key: string): Promise<unknown>;
	get(keys: string[]): Promise<Map<string, unknown>>;
	transaction<T>(closure: (txn: DurableObjectTransactionLike) => Promise<T>): Promise<T>;
}

/** DurableObjectObjectStoreOptions configures a DurableObjectObjectStore. */
export interface DurableObjectObjectStoreOptions {
	/**
	 * storage is the Durable Object's storage, `ctx.storage`.
	 *
	 * The store assumes it owns every key in it: keep any other state the object has
	 * in a different Durable Object. Stores built over the same storage object share
	 * their locks and exclude one another, so pass `ctx.storage` itself, or a single
	 * wrapper of it, rather than a new wrapper for each store.
	 */
	readonly storage: DurableObjectStorageLike;

	/**
	 * maxValueBytes is the largest number of an object's bytes the store keeps in a
	 * single storage value. Larger objects are split across several values, which is
	 * invisible to readers. It defaults to DefaultMaxValueBytes, which is safe for
	 * both KV-backed and SQLite-backed objects; a SQLite-backed object may raise it to
	 * store large entry bundles in fewer rows, keeping it at least 1 KiB below the
	 * runtime's per-value limit.
	 */
	readonly maxValueBytes?: number;
}

/** DurableObjectDriverConfig configures newDurableObjectDriver. */
export interface DurableObjectDriverConfig extends DurableObjectObjectStoreOptions {
	/** fetch is used for outgoing HTTP requests, e.g. to witnesses. If unset, the global fetch is used. */
	readonly fetch?: FetchFn;
}

/**
 * newDurableObjectDriver returns a storage driver which keeps the log in a Durable
 * Object's storage, for newAppender, newMigrationTarget and the like.
 *
 * Create one driver, and one appender on it, per Durable Object instance, typically
 * in the constructor under `ctx.blockConcurrencyWhile`, and keep both for the life of
 * the instance: the appender's batching, checkpoint publication and garbage
 * collection run on timers while the instance is in memory, and keep it from
 * hibernating until newAppender's signal aborts. When the runtime discards the
 * instance (on a deploy, a crash or a move), those timers stop with it, and the next
 * instance's appender resumes from storage, publishing a checkpoint for anything
 * integrated but not yet published within one checkpoint interval. An entry whose
 * index the appender has returned is already integrated and survives the restart.
 *
 * It is a shorthand for `newObjectStoreDriver({ store: new DurableObjectObjectStore(cfg), fetch })`;
 * use that form to reach the store itself.
 */
export function newDurableObjectDriver(cfg: DurableObjectDriverConfig): ObjectStoreDriver {
	const store = new DurableObjectObjectStore(cfg);
	return newObjectStoreDriver(cfg.fetch === undefined ? { store } : { store, fetch: cfg.fetch });
}

/** head is the record stored under an object's own key. */
type head = inlineHead | chunkedHead;

/** inlineHead is the head of an object of at most maxValueBytes, which holds its bytes. */
interface inlineHead {
	/** size is the length of the object's contents in bytes. */
	readonly size: number;
	/** modTime is when the object was written, in milliseconds since the Unix epoch. */
	readonly modTime: number;
	readonly data: Uint8Array;
}

/**
 * chunkedHead is the head of a larger object, whose bytes are split in order across
 * chunks values stored under chunkKey(key, gen, 0) to chunkKey(key, gen, chunks-1).
 */
interface chunkedHead {
	readonly size: number;
	readonly modTime: number;
	/**
	 * gen names this version of the object's chunks. It is random, so chunks written
	 * for different versions of an object never share a key, even when one version
	 * was deleted and its key later reused.
	 */
	readonly gen: string;
	readonly chunks: number;
}

/**
 * encodedObject is an object's contents as the values that will be stored: its bytes
 * for an inline object, or its chunks.
 *
 * Every value owns its buffer. Storage serializes a view by copying its entire
 * underlying ArrayBuffer, so storing chunks as subarrays of the caller's array would
 * store the whole array once per chunk.
 */
type encodedObject =
	| { readonly size: number; readonly data: Uint8Array }
	| { readonly size: number; readonly chunks: readonly Uint8Array[] };

/**
 * DurableObjectObjectStore is an ObjectStore kept in a Durable Object's storage,
 * through the key/value API that both KV-backed and SQLite-backed objects provide.
 *
 * Each object is a record under its own key. An object larger than maxValueBytes is
 * split into chunks stored under keys that extend the object's key, so it can be far
 * larger than the runtime's per-value limit, and deletePrefix removes chunks along
 * with the objects they belong to.
 *
 * Every put, create and deletePrefix commits as a single storage transaction, however
 * many values it writes or deletes, so it is atomic. Writes are additionally
 * serialized by a mutex shared by every store over the same storage object, which is
 * what makes create's check-then-write and put's replacement of a previous version's
 * chunks race-free. Reads take no lock: chunks are immutable and named by a random
 * per-version generation, so a read that loses a race with an overwrite finds chunks
 * missing, rather than mixing two versions, and retries under the mutex.
 *
 * A write resolves once committed to the object's storage. The runtime may still be
 * confirming it with the storage service, but its output gate withholds every
 * response, fetch and RPC the object makes until the write is durable, and resets
 * the object instead if it fails. No observer outside the object can therefore see
 * the effect of a write that is later lost, which is the durability the ObjectStore
 * contract requires. See docs/decisions/0122-durable-object-durability-and-timers.md.
 *
 * Locks are held in memory and exclude every holder in the Durable Object, which is
 * sufficient because the runtime runs at most one instance of a Durable Object at a
 * time: see docs/decisions/0121-durable-object-in-process-locks.md.
 */
export class DurableObjectObjectStore implements ObjectStore {
	readonly #storage: DurableObjectStorageLike;
	readonly #maxValueBytes: number;
	readonly #shared: sharedState;

	constructor(opts: DurableObjectObjectStoreOptions) {
		const maxValueBytes = opts.maxValueBytes ?? DefaultMaxValueBytes;
		if (!Number.isSafeInteger(maxValueBytes) || maxValueBytes < 1) {
			throw new RangeError(`durableobject: maxValueBytes must be a positive integer, got ${maxValueBytes}`);
		}
		this.#storage = opts.storage;
		this.#maxValueBytes = maxValueBytes;
		this.#shared = sharedStateFor(opts.storage);
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		checkKey(key);
		const data = await this.#read(key);
		if (data !== torn) {
			return data;
		}
		// The object was overwritten or deleted between reading its head and its chunks.
		// Writers hold the mutex, so a second attempt under it cannot race again.
		return this.#shared.writes.do(async () => {
			const data = await this.#read(key);
			if (data === torn) {
				throw corrupt(key, "chunks are missing");
			}
			return data;
		});
	}

	async stat(key: string): Promise<ObjectInfo | undefined> {
		checkKey(key);
		const h = await readHead(this.#storage, key);
		return h === undefined ? undefined : { modTime: h.modTime, size: h.size };
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		checkKey(key);
		const obj = this.#encode(data);
		await this.#shared.writes.do(() =>
			this.#storage.transaction(async (txn) => {
				await writeObject(txn, key, obj, await readHead(txn, key));
			}),
		);
	}

	async create(key: string, data: Uint8Array): Promise<boolean> {
		checkKey(key);
		const obj = this.#encode(data);
		return this.#shared.writes.do(() =>
			this.#storage.transaction(async (txn) => {
				if ((await readHead(txn, key)) !== undefined) {
					return false;
				}
				await writeObject(txn, key, obj, undefined);
				return true;
			}),
		);
	}

	async deletePrefix(prefix: string): Promise<void> {
		checkKey(prefix);
		await this.#shared.writes.do(() =>
			this.#storage.transaction(async (txn) => {
				// Listing by prefix returns chunk keys too, since they extend their object's
				// key. noCache keeps the chunk values the listing has to load out of the
				// runtime's in-memory cache.
				let startAfter: string | undefined;
				for (;;) {
					const page = await txn.list({
						prefix,
						limit: maxKeysPerCall,
						noCache: true,
						...(startAfter === undefined ? {} : { startAfter }),
					});
					const keys = [...page.keys()];
					if (keys.length > 0) {
						await txn.delete(keys);
					}
					if (keys.length < maxKeysPerCall) {
						return;
					}
					startAfter = keys[keys.length - 1];
				}
			}),
		);
	}

	lock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#shared.locks.run(name, fn, signal);
	}

	/**
	 * encode splits data into the values to store, copying it so that the caller may
	 * reuse its array as soon as put or create returns, even before the write commits.
	 */
	#encode(data: Uint8Array): encodedObject {
		const max = this.#maxValueBytes;
		if (data.length <= max) {
			return { size: data.length, data: data.slice() };
		}
		const chunks: Uint8Array[] = [];
		for (let off = 0; off < data.length; off += max) {
			chunks.push(data.slice(off, off + max));
		}
		return { size: data.length, chunks };
	}

	/**
	 * read returns the contents of the object stored at key, undefined if there is
	 * none, or torn if it is chunked and a concurrent write replaced or deleted the
	 * version whose head it read before it could read that version's chunks.
	 */
	async #read(key: string): Promise<Uint8Array | undefined | typeof torn> {
		const h = await readHead(this.#storage, key);
		if (h === undefined) {
			return undefined;
		}
		if ("data" in h) {
			return h.data;
		}
		const keys = chunkKeys(key, h);
		const found = new Map<string, unknown>();
		for (const page of await Promise.all(batches(keys).map((b) => this.#storage.get(b)))) {
			for (const [k, v] of page) {
				found.set(k, v);
			}
		}
		const out = new Uint8Array(h.size);
		let off = 0;
		for (const k of keys) {
			const chunk = found.get(k);
			if (chunk === undefined) {
				return torn;
			}
			if (!(chunk instanceof Uint8Array) || off + chunk.length > h.size) {
				throw corrupt(key, `chunk ${JSON.stringify(k)} does not match its record`);
			}
			out.set(chunk, off);
			off += chunk.length;
		}
		if (off !== h.size) {
			throw corrupt(key, `its chunks hold ${off} bytes, want ${h.size}`);
		}
		return out;
	}
}

/**
 * writeObject stores obj under key within txn, replacing old, the head currently
 * stored there (if any), and deleting the chunks old no longer needs.
 */
async function writeObject(
	txn: DurableObjectTransactionLike,
	key: string,
	obj: encodedObject,
	old: head | undefined,
): Promise<void> {
	const modTime = Date.now();
	const stale = old !== undefined && "gen" in old ? old : undefined;
	const entries: [string, unknown][] = [];
	if ("data" in obj) {
		entries.push([key, { size: obj.size, modTime, data: obj.data } satisfies inlineHead]);
	} else {
		let gen = newGeneration();
		while (gen === stale?.gen) {
			gen = newGeneration();
		}
		for (const [i, chunk] of obj.chunks.entries()) {
			entries.push([chunkKey(key, gen, i), chunk]);
		}
		entries.push([key, { size: obj.size, modTime, gen, chunks: obj.chunks.length } satisfies chunkedHead]);
	}
	for (const b of batches(entries)) {
		await txn.put(Object.fromEntries(b));
	}
	if (stale !== undefined) {
		for (const b of batches(chunkKeys(key, stale))) {
			await txn.delete(b);
		}
	}
}

/**
 * readHead returns the head stored under key, or undefined if there is none. It
 * rejects values this store did not write, which means something else shares the
 * Durable Object's storage.
 */
async function readHead(from: { get(key: string): Promise<unknown> }, key: string): Promise<head | undefined> {
	const v = await from.get(key);
	if (v === undefined) {
		return undefined;
	}
	if (!isHead(v)) {
		throw corrupt(key, "the stored value was not written by DurableObjectObjectStore");
	}
	return v;
}

function isHead(v: unknown): v is head {
	if (typeof v !== "object" || v === null) {
		return false;
	}
	const h = v as Record<string, unknown>;
	if (!Number.isSafeInteger(h.size) || typeof h.modTime !== "number") {
		return false;
	}
	if ("data" in h) {
		return h.data instanceof Uint8Array && h.data.length === h.size;
	}
	return typeof h.gen === "string" && Number.isSafeInteger(h.chunks) && (h.chunks as number) > 0;
}

/** chunkKey returns the key of the i'th chunk of the version gen of the object at key. */
function chunkKey(key: string, gen: string, i: number): string {
	return `${key}${chunkSeparator}${gen}.${i}`;
}

/** chunkKeys returns the keys of the chunks h describes, in order. */
function chunkKeys(key: string, h: chunkedHead): string[] {
	return Array.from({ length: h.chunks }, (_, i) => chunkKey(key, h.gen, i));
}

function newGeneration(): string {
	return toHex(crypto.getRandomValues(new Uint8Array(8)));
}

function checkKey(key: string): void {
	if (key.includes(chunkSeparator)) {
		throw new Error(`durableobject: ${JSON.stringify(key)} contains NUL, which is reserved`);
	}
}

function corrupt(key: string, why: string): Error {
	return new Error(`durableobject: object ${JSON.stringify(key)} is corrupt: ${why}`);
}

/** batches splits items into runs short enough for a single storage call. */
function batches<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += maxKeysPerCall) {
		out.push(items.slice(i, i + maxKeysPerCall));
	}
	return out;
}

/**
 * sharedState is what every DurableObjectObjectStore over the same storage object
 * shares, so that two stores, or two drivers, built over one `ctx.storage` exclude
 * each other exactly as two holders of one store do.
 */
interface sharedState {
	/** writes serializes put, create and deletePrefix. */
	readonly writes: Mutex;
	/** locks holds the named locks behind ObjectStore.lock. */
	readonly locks: NamedLocks;
}

// sharedStates maps each storage object to its sharedState. The runtime hands a
// Durable Object the same storage object for its whole life, and weak keys let the
// state go with the object, since several Durable Objects may share an isolate.
const sharedStates = new WeakMap<DurableObjectStorageLike, sharedState>();

function sharedStateFor(storage: DurableObjectStorageLike): sharedState {
	let s = sharedStates.get(storage);
	if (s === undefined) {
		s = { writes: new Mutex(), locks: new NamedLocks() };
		sharedStates.set(storage, s);
	}
	return s;
}
