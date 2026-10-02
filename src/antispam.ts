// Copyright 2024 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/antispam.go @ 4a6d9f9

import type { AddFn, Index, IndexFuture } from "./append_lifecycle.ts";
import type { Entry } from "./entry.ts";
import { toHex } from "./internal/gostd/bytes.ts";

/**
 * newInMemoryDedup wraps an Add function to prevent duplicate entries being written to the underlying
 * storage by keeping an in-memory cache of recently seen entries.
 * Where an existing entry has already been `Add`ed, the previous `IndexFuture` will be returned.
 * When no entry is found in the cache, the delegate method will be called to store the entry, and
 * the result will be registered in the cache.
 *
 * Internally this uses a cache with a max size configured by the size parameter.
 * If the entry being `Add`ed is not found in the cache, then it calls the delegate.
 *
 * This object can be used in isolation, or in conjunction with a persistent dedup implementation.
 * When using this with a persistent dedup, the persistent layer should be the delegate of this
 * InMemoryDedup. This allows recent duplicates to be deduplicated in memory, reducing the need to
 * make calls to a persistent storage.
 */
export function newInMemoryDedup(size: number): (af: AddFn) => AddFn {
	return (af: AddFn): AddFn => {
		let c: LRUCache<() => IndexFuture>;
		try {
			c = new LRUCache<() => IndexFuture>(size);
		} catch (err) {
			// Port note: Go panics; the port throws (docs/decisions/0004-errors-context-and-concurrency.md),
			// preserving the `lru.New(%d): %v` message text.
			throw new Error(`lru.New(${size}): ${messageOf(err)}`);
		}
		const dedup = new inMemoryDedup(af, c);
		return (e: Entry, signal?: AbortSignal): IndexFuture => dedup.add(e, signal);
	};
}

class inMemoryDedup {
	private readonly delegate: (e: Entry, signal?: AbortSignal) => IndexFuture;
	private readonly cache: LRUCache<() => IndexFuture>;

	constructor(delegate: (e: Entry, signal?: AbortSignal) => IndexFuture, cache: LRUCache<() => IndexFuture>) {
		this.delegate = delegate;
		this.cache = cache;
	}

	/**
	 * add adds the entry to the underlying delegate only if e hasn't been recently seen. In either case,
	 * an IndexFuture will be returned that the client can use to get the sequence number of this entry.
	 */
	add(e: Entry, signal?: AbortSignal): IndexFuture {
		// Port note: Go keys the cache on `string(e.Identity())` — the raw identity bytes
		// reinterpreted as a string. The port keys on the hex encoding of the same bytes;
		// both are a deterministic, collision-free mapping from the 32-byte identity to a
		// stable string cache key, which is all this use requires.
		const id = toHex(e.identity());

		// sync.OnceValue: build the IndexFuture at most once, caching it. Port note: the Go
		// `sync.OnceValue` critical section is synchronous (building the future does not
		// await), so per docs/decisions/0004-errors-context-and-concurrency.md a plain
		// captured variable suffices and no lock is taken — JavaScript's run-to-completion
		// semantics guarantee the build cannot interleave with itself.
		let built: IndexFuture | undefined;
		let f: () => IndexFuture = (): IndexFuture => {
			if (built === undefined) {
				// However many calls with the same entry come in and are deduplicated, we should only call delegate
				// once for each unique entry:
				const df = this.delegate(e, signal);

				built = async (): Promise<Index> => {
					try {
						return await df();
					} catch (err) {
						// If things went wrong we shouldn't cache the error, but rather let the request be retried as the error
						// may be transient (including ErrPushback).
						this.cache.remove(id);
						throw err;
					}
				};
			}
			return built;
		};

		// if we've seen this entry before, discard our f and replace
		// with the one we created last time, otherwise store f against id.
		const { previous, ok } = this.cache.peekOrAdd(id, f);
		if (ok && previous !== undefined) {
			const prev = previous;
			f = (): IndexFuture => {
				return async (): Promise<Index> => {
					const i = await prev()();
					return { index: i.index, isDup: true };
				};
			};
		}

		return f();
	}
}

/**
 * LRUCache is the subset of `github.com/hashicorp/golang-lru/v2` that inMemoryDedup uses:
 * a fixed-capacity cache exposing `PeekOrAdd` and `Remove`. It is not a general-purpose LRU
 * port — see docs/decisions/0081-antispam-lru-subset-not-hashicorp.md.
 *
 * Port note: a JavaScript `Map` preserves insertion order, so eviction of the
 * least-recently-*inserted* key is `delete` of the map's first key. inMemoryDedup never calls
 * a recency-updating `Get`/`Add` (only `PeekOrAdd`, which by definition does not update
 * recency, and `Remove`), so insertion order *is* the recency order for this usage, and the
 * eviction behaviour is byte-for-byte identical to the Go cache's for every operation
 * inMemoryDedup performs.
 */
class LRUCache<V> {
	readonly #size: number;
	readonly #entries = new Map<string, V>();

	constructor(size: number) {
		if (size <= 0) {
			// Matches hashicorp/golang-lru/v2's `lru.New` error text.
			throw new Error("must provide a positive size");
		}
		this.#size = size;
	}

	/**
	 * peekOrAdd checks if a key is in the cache without updating its recency, and if not, adds
	 * the value, evicting the least-recently-inserted entry if the cache is over capacity.
	 * Returns the existing value and whether the key was already present.
	 */
	peekOrAdd(key: string, value: V): { previous: V | undefined; ok: boolean } {
		const existing = this.#entries.get(key);
		if (existing !== undefined) {
			return { previous: existing, ok: true };
		}
		this.#entries.set(key, value);
		if (this.#entries.size > this.#size) {
			const oldest = this.#entries.keys().next().value;
			if (oldest !== undefined) {
				this.#entries.delete(oldest);
			}
		}
		return { previous: undefined, ok: false };
	}

	/** remove removes the provided key from the cache. */
	remove(key: string): void {
		this.#entries.delete(key);
	}
}

// messageOf renders a caught value the way Go's `%v` renders an error.
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
