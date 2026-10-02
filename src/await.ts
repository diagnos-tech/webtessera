// Copyright 2024 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/await.go @ 4a6d9f9
//
// Port note: klog logging is dropped, per the reasoning recorded in
// docs/decisions/0080-append-lifecycle-otel-and-klog.md (and the earlier
// docs/decisions/0051-storage-internal-drops-otel-and-klog.md it follows).

import type { Index, IndexFuture } from "./append_lifecycle.ts";
import { ErrNotExist, errorIs } from "./internal/gostd/errors.ts";
import { sleep } from "./internal/gostd/sync.ts";
import { checkpointUnsafe } from "./internal/parse/parse.ts";

/** readCheckpointFn fetches the latest checkpoint. Go: `func(ctx) ([]byte, error)`. */
type readCheckpointFn = (signal?: AbortSignal) => Promise<Uint8Array>;

/**
 * newPublicationAwaiter provides a PublicationAwaiter that can be cancelled
 * using the provided signal. The PublicationAwaiter will poll every `pollPeriodMs`
 * to fetch checkpoints using the `readCheckpoint` function.
 *
 * Port note: Go's `NewPublicationAwaiter(ctx, readCheckpoint, pollPeriod)` starts a poll-loop
 * goroutine; here the loop is started as a background async task and its lifetime is bound to
 * `signal`, per docs/decisions/0004-errors-context-and-concurrency.md.
 */
export function newPublicationAwaiter(
	readCheckpoint: readCheckpointFn,
	pollPeriodMs: number,
	signal?: AbortSignal,
): PublicationAwaiter {
	const a = new PublicationAwaiter();
	void a._pollLoop(readCheckpoint, pollPeriodMs, signal);
	return a;
}

/**
 * PublicationAwaiter allows client threads to block until a leaf is published.
 * This means it has a sequence number, and been integrated into the tree, and
 * a checkpoint has been published for it.
 * A single long-lived PublicationAwaiter instance
 * should be reused for all requests in the application code as there is some
 * overhead to each one; the core of an PublicationAwaiter is a poll loop that
 * will fetch checkpoints whenever it has clients waiting.
 *
 * The expected call pattern is:
 *
 * const [i, cp] = await awaiter.await(storage.add(myLeaf));
 *
 * When used this way, it requires very little code at the point of use to
 * block until the new leaf is integrated into the tree.
 *
 * Port note: Go coordinates the poll loop and waiters with a `sync.Cond`. JavaScript is
 * single-threaded and cannot block a thread, so `sync.Cond.Wait`/`Broadcast` become a set of
 * pending resolvers woken on each poll update (or on cancellation). The condition is
 * re-checked after each wake exactly as `Cond.Wait` requires, so the semantics are preserved;
 * no lock guards `size`/`checkpoint`/`err` because every read and write of them is synchronous
 * (docs/decisions/0004-errors-context-and-concurrency.md).
 */
export class PublicationAwaiter {
	// size, checkpoint, and err keep track of the latest size and checkpoint
	// (or error) seen by the poller.
	#size = 0n;
	#checkpoint: Uint8Array | undefined = undefined;
	#err: unknown = undefined;

	// waiters holds the resolvers of clients currently blocked in await(). Broadcast resolves
	// and clears them, standing in for sync.Cond.Broadcast.
	#waiters: (() => void)[] = [];

	/**
	 * await blocks until the IndexFuture is resolved, and this new index has been
	 * integrated into the log, i.e. the log has made a checkpoint available that
	 * commits to this new index. When this happens, await returns the index at
	 * which the leaf has been added, and a checkpoint that commits to this index.
	 *
	 * This operation can be aborted early by cancelling the signal. In this event,
	 * or in the event that there is an error getting a valid checkpoint, an error
	 * will be thrown from this method.
	 *
	 * Port note: Go returns `(Index, []byte, error)`; the port returns `[Index, checkpoint]`
	 * and throws on error (docs/decisions/0004-errors-context-and-concurrency.md).
	 */
	async await(future: IndexFuture, signal?: AbortSignal): Promise<[Index, Uint8Array | undefined]> {
		const i = await future();

		while (this.#size <= i.index && this.#err === undefined && !signal?.aborted) {
			await this.#wait();
		}
		// Ensure we propagate the cancellation error, if any.
		if (signal?.aborted) {
			this.#err = signal.reason;
		}
		if (this.#err !== undefined) {
			throw this.#err;
		}
		return [i, this.#checkpoint];
	}

	/**
	 * _pollLoop MUST be called as a background task when constructing a PublicationAwaiter
	 * and will run continually until its signal is cancelled. It wakes up every
	 * `pollPeriodMs` to check if there are clients blocking. If there are, it requests
	 * the latest checkpoint from the log, parses the tree size, and releases all clients
	 * that were blocked on an index smaller than this tree size.
	 *
	 * @internal
	 */
	async _pollLoop(readCheckpoint: readCheckpointFn, pollPeriodMs: number, signal?: AbortSignal): Promise<void> {
		let cp: Uint8Array | undefined;
		let cpErr: unknown;
		let cpSize = 0n;
		for (let done = false; !done; ) {
			// select { <-ctx.Done(): ... ; <-time.After(pollPeriod): ... }
			let aborted = false;
			try {
				await sleep(pollPeriodMs, signal);
			} catch {
				cp = undefined;
				cpSize = 0n;
				cpErr = signal?.reason;
				done = true;
				aborted = true;
			}
			if (!aborted) {
				try {
					cp = await readCheckpoint(signal);
					cpErr = undefined;
				} catch (err) {
					cp = undefined;
					cpErr = err;
				}
				if (cpErr !== undefined && errorIs(cpErr, ErrNotExist)) {
					continue;
				}
				if (cpErr !== undefined) {
					cpSize = 0n;
				} else {
					try {
						cpSize = checkpointUnsafe(cp ?? new Uint8Array(0)).size;
					} catch (err) {
						cpSize = 0n;
						cpErr = err;
					}
				}
			}

			// Note that for now, this releases all clients in the event of a single failure.
			// If this causes problems, this could be changed to attempt retries.
			this.#checkpoint = cp;
			this.#size = cpSize;
			this.#err = cpErr;
			this.#broadcast();
		}
	}

	// Port note: unlike Go's sync.Cond.Wait, this does not itself observe cancellation — it is
	// woken only by #broadcast, exactly as Cond.Wait is woken only by Broadcast. Cancellation is
	// handled the same way Go handles it: the await() loop guard re-checks `signal.aborted`, and
	// the poll loop issues a final #broadcast when its own sleep is cancelled, which releases any
	// waiters so they observe the cancellation. Registering a per-wait abort listener on the
	// caller's (possibly composite) signal instead would add and remove a listener on every one
	// of the (waiters × polls) wakeups, which is both needless churn and a divergence from Go's
	// wake-on-broadcast-only semantics.
	#wait(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.#waiters.push(resolve);
		});
	}

	#broadcast(): void {
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const w of waiters) {
			w();
		}
	}
}
