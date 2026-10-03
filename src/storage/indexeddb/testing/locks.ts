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

// Test-only. An IndexedDBObjectStore refuses to open without a Web Locks LockManager
// unless it is told it is the only writer (docs/decisions/0201-indexeddb-locks-fail-closed.md).
// Node has no `navigator.locks`; a test process that wants to run code written for a
// browser unchanged (the README's IndexedDB example, say) can install this in its place.
// Within one process it is exactly as strong as Web Locks are within one origin.

import { NamedLocks } from "../../objectstore/namedlocks.ts";

/**
 * newInProcessLockManager returns a LockManager whose exclusive locks exclude every
 * holder in the current JavaScript realm, serving waiters in arrival order and
 * rejecting an abandoned wait with the signal's reason, as the Web Locks spec does.
 * Only the exclusive mode that IndexedDBObjectStore uses is supported.
 */
export function newInProcessLockManager(): LockManager {
	return new inProcessLockManager();
}

class inProcessLockManager implements LockManager {
	readonly #locks = new NamedLocks();

	request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
	request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
	request<T>(
		name: string,
		optionsOrCallback: LockOptions | LockGrantedCallback<T>,
		maybeCallback?: LockGrantedCallback<T>,
	): Promise<T> {
		const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
		const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
		if (callback === undefined) {
			return Promise.reject(new TypeError("missing callback"));
		}
		if (options.mode === "shared" || options.ifAvailable === true || options.steal === true) {
			return Promise.reject(new TypeError("only exclusive, waiting lock requests are supported"));
		}
		const lock: Lock = { name, mode: "exclusive" };
		return this.#locks.run(name, async () => await callback(lock), options.signal);
	}

	query(): Promise<LockManagerSnapshot> {
		return Promise.resolve({ held: [], pending: [] });
	}
}
