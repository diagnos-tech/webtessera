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

// This file has no upstream counterpart. It is the in-process half of the
// ObjectStore.lock contract, shared by every backend that needs one. See
// docs/decisions/0142-shared-named-locks.md.

/**
 * NamedLocks grants exclusive locks by name, within one JavaScript realm, in arrival
 * order. It implements the in-process part of ObjectStore.lock, so a custom store can
 * delegate to it:
 *
 *	readonly #locks = new NamedLocks();
 *	lock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
 *		return this.#locks.run(name, fn, signal);
 *	}
 *
 * It excludes only callers that share the instance. A backend reachable from several
 * realms or processes (an IndexedDB database open in several tabs, say) needs a lock
 * that spans them as well.
 *
 * Each held lock maps to the queue of waiters behind its holder. Releasing hands the lock
 * straight to the first waiter, so a lock is never observably free while someone is
 * waiting for it. A waiter whose signal aborts leaves the queue, and the lock is later
 * handed past it. A name with no holder keeps no state, so any number of distinct names
 * may be used.
 */
export class NamedLocks {
	readonly #waiters = new Map<string, (() => void)[]>();

	/**
	 * run runs fn while holding the lock called name, and resolves to its result once
	 * the lock has been released. If signal aborts before the lock is granted, run
	 * rejects with the signal's reason and fn is never called.
	 */
	async run<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		signal?.throwIfAborted();
		await this.#acquire(name, signal);
		try {
			return await fn();
		} finally {
			this.#release(name);
		}
	}

	#acquire(name: string, signal: AbortSignal | undefined): Promise<void> {
		const queue = this.#waiters.get(name);
		if (queue === undefined) {
			this.#waiters.set(name, []);
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				queue.splice(queue.indexOf(grant), 1);
				reject(signal?.reason);
			};
			const grant = (): void => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			queue.push(grant);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	#release(name: string): void {
		const next = this.#waiters.get(name)?.shift();
		if (next === undefined) {
			this.#waiters.delete(name);
		} else {
			next();
		}
	}
}
