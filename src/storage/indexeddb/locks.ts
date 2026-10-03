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

// This file has no upstream counterpart. It provides the two lock implementations
// behind IndexedDBObjectStore.lock: the Web Locks API, which excludes every tab and
// worker of an origin, and an in-process fallback for runtimes without it, which a
// store uses only when opened with singleWriter: true. See
// docs/decisions/0112-indexeddb-locks-web-locks-with-in-process-fallback.md and
// docs/decisions/0201-indexeddb-locks-fail-closed.md.

import { NamedLocks } from "../objectstore/namedlocks.ts";

/**
 * LockScope says which contexts an IndexedDBObjectStore's locks exclude.
 *
 * "origin" means locks are taken through the Web Locks API and exclude every tab,
 * window and worker of the origin, which is also everything that can open the same
 * IndexedDB database. "realm" means the Web Locks API was unavailable and locks only
 * exclude holders in the current JavaScript realm (the current tab or worker): two
 * contexts that write the same log concurrently would then corrupt it, which is why a
 * store only runs with this scope when opened with singleWriter: true.
 */
export type LockScope = "origin" | "realm";

/**
 * Locker grants exclusive, named locks in arrival order. It is the slice of the Web
 * Locks API that ObjectStore.lock needs.
 */
export interface Locker {
	/** scope is the set of contexts this Locker's locks exclude. */
	readonly scope: LockScope;

	/**
	 * request runs fn while holding the lock called name and resolves to its result
	 * once the lock is released. If signal aborts before the lock is granted, request
	 * rejects with the signal's reason and fn is never called.
	 */
	request<T>(name: string, fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T>;
}

/** newWebLocker returns a Locker backed by a Web Locks LockManager, usually `navigator.locks`. */
export function newWebLocker(manager: LockManager): Locker {
	return {
		scope: "origin",
		async request<T>(name: string, fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
			signal?.throwIfAborted();
			let granted = false;
			try {
				return await manager.request(name, signal === undefined ? {} : { signal }, () => {
					granted = true;
					return fn();
				});
			} catch (err) {
				// The Web Locks spec now rejects an abandoned request with the signal's
				// reason, but implementations that predate that change reject with a
				// generic AbortError instead. The ObjectStore contract promises the
				// caller's reason, so report that whenever the wait, not fn, failed.
				if (!granted && signal?.aborted === true) {
					throw signal.reason;
				}
				throw err;
			}
		},
	};
}

/**
 * localLocker is a Locker whose locks exclude holders in the current realm only. Like
 * Web Locks, NamedLocks serves waiters strictly in arrival order.
 */
class localLocker implements Locker {
	readonly scope = "realm";
	readonly #locks = new NamedLocks();

	request<T>(name: string, fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
		return this.#locks.run(name, fn, signal);
	}
}

// localLockers holds one localLocker per IndexedDB implementation, so that every
// store opened through the same factory in this realm contends on the same locks
// while unrelated factories (an isolated fake-indexeddb instance per test, say)
// never do. Lock names already carry the database name.
const localLockers = new WeakMap<IDBFactory, localLocker>();

/**
 * localLockerFor returns the realm-wide Locker shared by every store opened through
 * factory.
 */
export function localLockerFor(factory: IDBFactory): Locker {
	let l = localLockers.get(factory);
	if (l === undefined) {
		l = new localLocker();
		localLockers.set(factory, l);
	}
	return l;
}
