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
 *
 * Port note: Go declares FlushFunc and NewQueue between this struct and its methods; a
 * TypeScript class keeps its methods in its body, so they follow the class instead.
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

		// If this is the first item, start the timer.
		if (this.#items.length === 1) {
			this.#timer = setTimeout(() => this.#flush(), this.maxAgeMs);
		}

		// If we've reached max size, flush.
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
	 * flushLocked must be called with q.mu held.
	 * It prepares items for flushing and returns them.
	 *
	 * Port note: this port takes no lock (see the Port notes on add() and flush()); the
	 * name and the comment are kept as upstream has them.
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
		for (let i = 0; i < entries.length; i++) {
			try {
				(entries[i] as queueItem).notify(err);
			} catch (logicErr) {
				// Port note: notify panics in Go when storage forgot to assign an index,
				// which takes the whole process — and every waiting Add() — down with it.
				// Here the panic is an exception on the drain loop, so the futures still
				// pending would otherwise wait forever: settle each remaining one with the
				// same logic error before rethrowing it. See
				// docs/decisions/0053-queue-channel-becomes-async-drain-loop.md.
				for (const e of entries.slice(i)) {
					e.set({ index: 0n, isDup: false }, logicErr);
				}
				throw logicErr;
			}
		}
	}
}

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
 * newQueue creates a new queue with the specified maximum age and size.
 *
 * The provided FlushFunc will be called with a slice containing the contents of the queue, in
 * the same order as they were added, when either the oldest entry in the queue has been there
 * for maxAge, or the size of the queue reaches maxSize.
 *
 * Port note: Go spins off its worker goroutine here ("Spin off a worker thread to write the
 * queue flushes to storage."); this port starts its drain loop on demand from add() and the
 * timer instead — see the Port note on Queue. maxAge is `maxAgeMs`, a number of
 * milliseconds (PORTING.md §3.5).
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
	 *
	 * Port note: Go's `err == nil` is `err === undefined || err === null` here, the same
	 * test newFutureErr's setter applies (docs/decisions/0056-future-ported-ahead-of-schedule.md).
	 */
	notify(err: unknown): void {
		if (this.entry.index() === undefined && (err === undefined || err === null)) {
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
