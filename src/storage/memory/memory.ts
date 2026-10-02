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

// This file has no upstream counterpart. It is the in-memory backend for the ObjectStore
// driver (../objectstore/driver.ts): the reference implementation of the ObjectStore
// contract, and the browser's stand-in for the POSIX driver's directory on disk. Nothing
// it holds survives the JavaScript realm. See docs/decisions/0100-objectstore-driver.md
// and docs/decisions/0104-objectstore-public-api.md.

import type { FetchFn } from "../../client/fetcher.ts";
import { newObjectStoreDriver, type ObjectStoreDriver, type ObjectStoreDriverConfig } from "../objectstore/driver.ts";
import { NamedLocks } from "../objectstore/namedlocks.ts";
import type { ObjectInfo, ObjectStore } from "../objectstore/objectstore.ts";

/** storedObject is a stored value together with its metadata. */
interface storedObject {
	readonly data: Uint8Array;
	readonly modTime: number;
}

/**
 * MemoryObjectStore is an ObjectStore that keeps every object in a Map.
 *
 * Each method completes synchronously before its Promise settles, so every operation is
 * atomic with respect to every other: JavaScript runs one task at a time, and nothing here
 * awaits between reading and writing the Map. Locks exclude every caller sharing this
 * instance, which is everything that can reach its data.
 *
 * Objects are copied on the way in and on the way out, so neither the store nor its callers
 * can observe the other mutating a shared array.
 */
export class MemoryObjectStore implements ObjectStore {
	readonly #objects = new Map<string, storedObject>();
	readonly #locks = new NamedLocks();

	async get(key: string): Promise<Uint8Array | undefined> {
		const o = this.#objects.get(key);
		return o === undefined ? undefined : new Uint8Array(o.data);
	}

	async stat(key: string): Promise<ObjectInfo | undefined> {
		const o = this.#objects.get(key);
		return o === undefined ? undefined : { modTime: o.modTime, size: o.data.length };
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		this.#objects.set(key, { data: new Uint8Array(data), modTime: Date.now() });
	}

	async create(key: string, data: Uint8Array): Promise<boolean> {
		if (this.#objects.has(key)) {
			return false;
		}
		this.#objects.set(key, { data: new Uint8Array(data), modTime: Date.now() });
		return true;
	}

	async deletePrefix(prefix: string): Promise<void> {
		for (const key of [...this.#objects.keys()]) {
			if (key.startsWith(prefix)) {
				this.#objects.delete(key);
			}
		}
	}

	lock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.#locks.run(name, fn, signal);
	}

	/**
	 * keys returns the keys of every stored object that starts with prefix, in ascending
	 * order. It is not part of the ObjectStore contract: it exists so that callers can
	 * enumerate a log held in memory, to export it as static files, say, or to inspect it in
	 * a test.
	 */
	keys(prefix = ""): string[] {
		return [...this.#objects.keys()].filter((k) => k.startsWith(prefix)).sort();
	}
}

/** MemoryDriverConfig configures newMemoryDriver. */
export interface MemoryDriverConfig {
	/**
	 * store holds the log. If unset, a new, empty MemoryObjectStore is used. Passing the
	 * same store to several drivers is how a single realm runs several appenders, or
	 * restarts one, against the same log.
	 */
	readonly store?: MemoryObjectStore;

	/** fetch is used for outgoing HTTP requests, e.g. to witnesses. If unset, the global fetch is used. */
	readonly fetch?: FetchFn;
}

/** newMemoryDriver returns a storage driver which keeps the log in memory. */
export function newMemoryDriver(cfg: MemoryDriverConfig = {}): ObjectStoreDriver {
	const c: ObjectStoreDriverConfig = { store: cfg.store ?? new MemoryObjectStore() };
	return newObjectStoreDriver(cfg.fetch === undefined ? c : { ...c, fetch: cfg.fetch });
}
