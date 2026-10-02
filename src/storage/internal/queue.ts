// Copyright 2024 Google LLC. All Rights Reserved.
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
// Ported from tessera/storage/internal/queue.go @ 4a6d9f9

// Module storage provides implementations and shared components for tessera storage backends.

import type { Index, IndexFuture } from "../../append_lifecycle.ts";
import type { Entry } from "../../entry.ts";
import { newFutureErr } from "../../internal/future/future.ts";

/**
 * FlushFunc is the signature of a function which will receive the slice of queued entries.
 * Normally, this function would be provided by storage implementations. It's important to note
 * that the implementation MUST call each entry's marshalBundleData function before attempting
 * to integrate it into the tree.
 * See the comment on Entry.marshalBundleData for further info.
 *
 * Port note: Go returns `error`; the port throws instead, per
 * docs/decisions/0004-errors-context-and-concurrency.md.
 */
export type FlushFunc = (entries: readonly Entry[], signal?: AbortSignal) => Promise<void>;

/**
 * Queue knows how to queue up a number of entries in order.
 *
 * When the buffered queue grows past a defined size, or the age of the oldest entry in the
 * queue reaches a defined threshold, the queue will call a provided FlushFunc with
 * a slice containing all queued entries in the same order as they were added.
 *
 * Port note: Go backs the flush hand-off with a buffered `chan []queueItem` (capacity 1)
 * drained by a single background goroutine, blocking the sender if a flush is already
 * pending. JavaScript cannot block a synchronous caller the way Go blocks a goroutine on a
 * full channel, and add() must stay synchronous (its whole point is to return an
 * IndexFuture immediately). This port replaces the channel with an unbounded in-memory
 * queue drained one batch at a time by a re-entrant-safe async loop — see
 * docs/decisions/0053-queue-channel-becomes-async-drain-loop.md.
 */
export class Queue {
	private readonly maxSize: number;
	private readonly maxAgeMs: number;
	private readonly flushFn: FlushFunc;
	private readonly signal: AbortSignal | undefined;

	#timer: ReturnType<typeof setTimeout> | undefined;
	#items: queueItem[] = [];
	#pending: queueItem[][] = [];
	#draining = false;

	/** @internal Use newQueue. */
	constructor(maxAgeMs: number, maxSize: number, f: FlushFunc, signal?: AbortSignal) {
		this.maxAgeMs = maxAgeMs;
		this.maxSize = maxSize;
		this.flushFn = f;
		this.signal = signal;
	}

	/**
	 * add places e into the queue, and returns a func which should be called to retrieve the assigned index.
	 *
	 * Port note: `signal` (Go: `ctx`) is unused here, exactly as upstream's `ctx` is unused
	 * in this method's body — kept for signature fidelity with the rest of the storage
	 * surface.
	 */
	add(e: Entry, _signal?: AbortSignal): IndexFuture {
		const qi = newEntry(e);

		// Port note: Go holds q.mu across this whole section (append, maybe start a
		// timer, maybe flush), but nothing in it awaits — appending to an array,
		// scheduling a timer callback, and building a slice are all synchronous — and
		// JavaScript's run-to-completion semantics mean no other call can interleave
		// with a synchronous function body. Per
		// docs/decisions/0004-errors-context-and-concurrency.md, a critical section like
		// this needs no lock at all, so none is taken here.
		this.#items.push(qi);
		if (this.#items.length === 1) {
			this.#timer = setTimeout(() => this.#flush(), this.maxAgeMs);
		}

		let itemsToFlush: queueItem[] | undefined;
		if (this.#items.length >= this.maxSize) {
			itemsToFlush = this.#flushLocked();
		}

		if (itemsToFlush !== undefined) {
			this.#enqueueFlush(itemsToFlush);
		}

		return qi.f;
	}

	/** flush is called by the timer to flush the buffer. */
	#flush(): void {
		// Port note: same reasoning as add() above — synchronous, so no lock.
		const itemsToFlush = this.#flushLocked();
		if (itemsToFlush !== undefined) {
			this.#enqueueFlush(itemsToFlush);
		}
	}

	/**
	 * flushLocked prepares items for flushing and returns them.
	 *
	 * Port note: named `…Locked` per upstream's comment convention ("must be called with
	 * q.mu held"), even though this port takes no lock — see the Port notes on add()/flush().
	 */
	#flushLocked(): queueItem[] | undefined {
		if (this.#items.length === 0) {
			return undefined;
		}

		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		const itemsToFlush = this.#items;
		this.#items = [];

		return itemsToFlush;
	}

	/**
	 * enqueueFlush and #drain together stand in for Go's `q.work <- itemsToFlush` and the
	 * background goroutine that reads from it. See the class-level Port note.
	 */
	#enqueueFlush(items: queueItem[]): void {
		this.#pending.push(items);
		void this.#drain();
	}

	async #drain(): Promise<void> {
		if (this.#draining) {
			// Another call is already draining #pending; it will pick up what was just
			// pushed on its next iteration.
			return;
		}
		this.#draining = true;
		try {
			while (this.#pending.length > 0) {
				if (this.signal?.aborted) {
					return;
				}
				const entries = this.#pending.shift();
				if (entries === undefined) {
					break;
				}
				await this.#doFlush(entries);
			}
		} finally {
			this.#draining = false;
		}
	}

	/** doFlush handles the queue flush, and sending notifications of assigned log indices. */
	async #doFlush(entries: readonly queueItem[]): Promise<void> {
		const entriesData = entries.map((e) => e.entry);

		let err: unknown;
		try {
			await this.flushFn(entriesData, this.signal);
		} catch (caught) {
			err = caught;
		}

		// Send assigned indices to all the waiting add() requests
		for (const e of entries) {
			e.notify(err);
		}
	}
}

/**
 * newQueue creates a new queue with the specified maximum age and size.
 *
 * The provided FlushFunc will be called with a slice containing the contents of the queue, in
 * the same order as they were added, when either the oldest entry in the queue has been there
 * for maxAgeMs, or the size of the queue reaches maxSize.
 */
export function newQueue(maxAgeMs: number, maxSize: number, f: FlushFunc, signal?: AbortSignal): Queue {
	return new Queue(maxAgeMs, maxSize, f, signal);
}

/**
 * queueItem represents an in-flight queueItem in the queue.
 *
 * The f field acts as a future for the queueItem's assigned index/error, and will
 * hang until assign is called.
 */
class queueItem {
	readonly entry: Entry;
	readonly f: IndexFuture;
	readonly set: (index: Index, err: unknown) => void;

	constructor(entry: Entry, f: IndexFuture, set: (index: Index, err: unknown) => void) {
		this.entry = entry;
		this.f = f;
		this.set = set;
	}

	/**
	 * notify sets the assigned log index (or an error) to the entry.
	 *
	 * This func must only be called once, and will cause any current or future callers of index()
	 * to be given the values provided here.
	 */
	notify(err: unknown): void {
		if (this.entry.index() === undefined && err === undefined) {
			throw new Error(
				"logic error: flush complete without error, but entry was not assigned an index - did storage fail to call entry.MarshalBundleData?",
			);
		}
		let idx = 0n;
		if (this.entry.index() !== undefined) {
			idx = this.entry.index() as bigint;
		}
		this.set({ index: idx, isDup: false }, err);
	}
}

/** newEntry creates a new entry for the provided data. */
function newEntry(data: Entry): queueItem {
	const [f, set] = newFutureErr<Index>();
	return new queueItem(data, () => f.get(), set);
}
