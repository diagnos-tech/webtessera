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

// StrictStorage holds DurableObjectObjectStore to Cloudflare's production storage
// limits, which local workerd does not enforce: in workerd a KV-backed object accepts
// multi-megabyte values and multi-key calls of any length, so a store that would fail
// in production passes there unless something checks. Test-only.

import type {
	DurableObjectListOptionsLike,
	DurableObjectStorageLike,
	DurableObjectTransactionLike,
} from "../durableobject.ts";

/** StorageLimits are the production limits of one Durable Object storage backend. */
export interface StorageLimits {
	/** maxValueBytes bounds the serialized size of a single value. */
	readonly maxValueBytes: number;
	/** keyCountsTowardValue says whether maxValueBytes bounds a key and its value together. */
	readonly keyCountsTowardValue: boolean;
	/** maxKeyBytes bounds the UTF-8 length of a key. */
	readonly maxKeyBytes: number;
	/** maxKeysPerCall bounds the keys a single get, put or delete call may name. */
	readonly maxKeysPerCall: number;
}

/** KVBackedLimits are the limits of a KV-backed Durable Object. */
export const KVBackedLimits: StorageLimits = {
	maxValueBytes: 128 * 1024,
	keyCountsTowardValue: false,
	maxKeyBytes: 2048,
	maxKeysPerCall: 128,
};

/** SQLiteBackedLimits are the limits of the key/value API of a SQLite-backed Durable Object. */
export const SQLiteBackedLimits: StorageLimits = {
	maxValueBytes: 2_000_000,
	keyCountsTowardValue: true,
	maxKeyBytes: 2048,
	maxKeysPerCall: 128,
};

const enc = new TextEncoder();

/**
 * serializedSize over-estimates the size of v once serialized with the structured
 * clone algorithm, as Durable Object storage does. Like V8's serializer, it counts a
 * typed array's whole underlying buffer, not just the bytes the view covers.
 */
function serializedSize(v: unknown): number {
	const framing = 16;
	if (v instanceof Uint8Array) {
		return v.buffer.byteLength + framing;
	}
	if (typeof v === "string") {
		return enc.encode(v).length + framing;
	}
	if (typeof v === "object" && v !== null) {
		let n = framing;
		for (const [k, field] of Object.entries(v)) {
			n += serializedSize(k) + serializedSize(field);
		}
		return n;
	}
	return framing;
}

/**
 * StrictStorage wraps a Durable Object's storage, rejecting every call that the
 * production runtime would reject for exceeding limits, and counting calls.
 */
export class StrictStorage implements DurableObjectStorageLike {
	/** calls is the number of storage calls made so far, transactions included. */
	calls = 0;

	/**
	 * beforeGetMany, if set, runs before every multi-key get is passed on, so that a
	 * test can interleave a write between a store reading an object's head and its
	 * chunks.
	 */
	beforeGetMany: ((keys: readonly string[]) => Promise<void>) | undefined;

	readonly #storage: DurableObjectStorageLike;
	readonly #limits: StorageLimits;

	constructor(storage: DurableObjectStorageLike, limits: StorageLimits) {
		this.#storage = storage;
		this.#limits = limits;
	}

	get(key: string): Promise<unknown>;
	get(keys: string[]): Promise<Map<string, unknown>>;
	async get(keyOrKeys: string | string[]): Promise<unknown> {
		this.calls++;
		if (typeof keyOrKeys === "string") {
			this.#checkKey(keyOrKeys);
			return this.#storage.get(keyOrKeys);
		}
		this.#checkKeys("get", keyOrKeys);
		await this.beforeGetMany?.(keyOrKeys);
		return this.#storage.get(keyOrKeys);
	}

	transaction<T>(closure: (txn: DurableObjectTransactionLike) => Promise<T>): Promise<T> {
		this.calls++;
		return this.#storage.transaction((txn) => closure(this.#wrap(txn)));
	}

	#wrap(txn: DurableObjectTransactionLike): DurableObjectTransactionLike {
		return {
			get: (key: string) => {
				this.calls++;
				this.#checkKey(key);
				return txn.get(key);
			},
			put: (entries: Record<string, unknown>) => {
				this.calls++;
				this.#checkKeys("put", Object.keys(entries));
				for (const [k, v] of Object.entries(entries)) {
					const size = serializedSize(v) + (this.#limits.keyCountsTowardValue ? enc.encode(k).length : 0);
					if (size > this.#limits.maxValueBytes) {
						throw new Error(`strict storage: value of ${JSON.stringify(k)} serializes to ~${size} bytes`);
					}
				}
				return txn.put(entries);
			},
			delete: (keys: string[]) => {
				this.calls++;
				this.#checkKeys("delete", keys);
				return txn.delete(keys);
			},
			list: (options: DurableObjectListOptionsLike) => {
				this.calls++;
				return txn.list(options);
			},
		};
	}

	#checkKeys(op: string, keys: readonly string[]): void {
		if (keys.length > this.#limits.maxKeysPerCall) {
			throw new Error(`strict storage: ${op} of ${keys.length} keys`);
		}
		for (const k of keys) {
			this.#checkKey(k);
		}
	}

	#checkKey(key: string): void {
		if (enc.encode(key).length > this.#limits.maxKeyBytes) {
			throw new Error(`strict storage: key ${JSON.stringify(key)} is too long`);
		}
	}
}

/**
 * LooseStorage wraps a Durable Object's storage with transactions that commit
 * atomically but are not isolated from one another: reads go straight to storage,
 * writes are buffered and applied in one real transaction once the closure returns,
 * and closures run concurrently. workerd happens to serialize transactions, so this
 * is what shows that DurableObjectObjectStore does not depend on it.
 */
export class LooseStorage implements DurableObjectStorageLike {
	readonly #storage: DurableObjectStorageLike;

	constructor(storage: DurableObjectStorageLike) {
		this.#storage = storage;
	}

	get(key: string): Promise<unknown>;
	get(keys: string[]): Promise<Map<string, unknown>>;
	get(keyOrKeys: string | string[]): Promise<unknown> {
		return typeof keyOrKeys === "string" ? this.#storage.get(keyOrKeys) : this.#storage.get(keyOrKeys);
	}

	async transaction<T>(closure: (txn: DurableObjectTransactionLike) => Promise<T>): Promise<T> {
		const writes: ((txn: DurableObjectTransactionLike) => Promise<unknown>)[] = [];
		const result = await closure({
			get: async (key: string) => {
				// Read at once, then yield long enough for every closure started alongside
				// this one to read too, so that all of them read before any commits.
				const v = await this.#storage.get(key);
				await new Promise((r) => setTimeout(r, 10));
				return v;
			},
			put: async (entries: Record<string, unknown>) => {
				writes.push((txn) => txn.put(entries));
			},
			delete: async (keys: string[]) => {
				writes.push((txn) => txn.delete(keys));
				return keys.length;
			},
			list: (options: DurableObjectListOptionsLike) => this.#storage.transaction((txn) => txn.list(options)),
		});
		await this.#storage.transaction(async (txn) => {
			for (const w of writes) {
				await w(txn);
			}
		});
		return result;
	}
}
