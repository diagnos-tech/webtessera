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
// Ported from tessera/migrate.go @ 4a6d9f9
//
// Port note: klog request logging is dropped, matching every other package in this
// port -- docs/decisions/0070-witness-and-migrate-drop-otel-and-klog.md. `github.com/cenkalti/backoff/v5`
// (worker retry policy) is a third-party dependency outside this port's allow-list
// (AGENTS.md §7); `retryWithBackoff` at the end of this file reproduces the behaviour of the
// `backoff.Retry` call the worker makes -- see docs/decisions/0073-migrate-retry-backoff.md.
// There is no `migrate_test.go` upstream (this file's coverage comes from Tessera's
// `integration/` end-to-end suite, which needs a real storage `Driver`). `migrate_test.ts`
// here is new, covering the logic reachable without a driver -- see
// docs/decisions/0074-migrate-untestable-without-driver.md.

import { range } from "./api/layout/index.ts";
import type { EntryBundleFetcherFunc } from "./client/index.ts";
import { ErrGroup, sleep } from "./internal/gostd/sync.ts";

/**
 * setEntryBundleFunc is the signature of a function which can durably store a serialised
 * entry bundle at the given index/partial size.
 *
 * Port note: Go declares this type without a doc comment; this one only describes it. It
 * is kept unexported, since nothing outside this file needs it -- `migrate_lifecycle.ts`
 * passes `writer.setEntryBundle` (a bound method matching this shape) directly to
 * `newCopier`.
 */
type setEntryBundleFunc = (index: bigint, partial: number, bundle: Uint8Array, signal?: AbortSignal) => Promise<void>;

/**
 * newCopier constructs a copier ready to migrate entry bundles from a source log into a
 * target Driver.
 *
 * Port note: Go declares this function without a doc comment; this one only describes it.
 *
 * @internal Go's `newCopier` is unexported; exported here (ADR-0010's pattern) so
 * `migrate_lifecycle.ts` -- a different TypeScript module standing in for the same Go
 * package -- and `migrate_test.ts` can reach it. Not re-exported from `src/index.ts`.
 */
export function newCopier(
	numWorkers: number,
	setEntryBundle: setEntryBundleFunc,
	getEntryBundle: EntryBundleFetcherFunc,
): copier {
	return new copier(setEntryBundle, getEntryBundle, numWorkers);
}

/**
 * copier controls the migration work.
 *
 * Port note: Go's `todo chan bundle` (buffered to numWorkers) is not a field here: work is
 * handed out by the generator populateWork returns, and the worker count it would have
 * carried as the channel's capacity is kept as `#numWorkers` instead
 * (docs/decisions/0077-copier-work-distribution-is-a-shared-generator.md).
 *
 * @internal Go's `copier` is unexported; exported here (ADR-0010's pattern) as newCopier's
 * return type, which `migrate_lifecycle.ts` and `migrate_test.ts` use. Not re-exported from
 * `src/index.ts`.
 */
export class copier {
	readonly #setEntryBundle: setEntryBundleFunc;
	readonly #getEntryBundle: EntryBundleFetcherFunc;
	readonly #numWorkers: number;

	/**
	 * bundlesCopied is the number of entry bundles copied so far.
	 *
	 * Port note: Go's field is an `atomic.Uint64` because multiple worker goroutines call
	 * `.Add(1)` on it concurrently, and `migrate_lifecycle.go` calls `.Store(...)` on it
	 * directly (same package, unexported field) to seed it from a resumed migration's
	 * already-integrated size. Every increment here happens inside a single synchronous
	 * expression with no `await` in the middle, so no two "concurrent" workers can ever
	 * interleave mid-increment (ADR-0004) -- a plain `bigint` field needs no atomic
	 * wrapper. It is `_`-prefixed and public (ADR-0010) rather than `#private`, because
	 * `migrate_lifecycle.ts` -- a different TypeScript module standing in for the same Go
	 * package -- needs the equivalent of that `.Store()` call, and the exported accessor
	 * below (`bundlesCopied()`, Go: `BundlesCopied()`) collides on name with a flattened
	 * private field.
	 *
	 * @internal
	 */
	_bundlesCopied = 0n;

	/** @internal Stands in for Go's `&copier{...}` composite literal; construct via newCopier. */
	constructor(setEntryBundle: setEntryBundleFunc, getEntryBundle: EntryBundleFetcherFunc, numWorkers: number) {
		this.#setEntryBundle = setEntryBundle;
		this.#getEntryBundle = getEntryBundle;
		this.#numWorkers = numWorkers;
	}

	/**
	 * copy starts the work of copying sourceSize entries from the source to the target log.
	 *
	 * Only the entry bundles are copied as the target storage is expected to integrate them and recalculate the root.
	 * This is done to ensure the correctness of both the source log as well as the copy process itself.
	 *
	 * A call to this function will block until either the copying is done, or an error has occurred.
	 */
	async copy(fromSize: bigint, sourceSize: bigint, signal?: AbortSignal): Promise<void> {
		if (fromSize > sourceSize) {
			throw new Error(`from size ${fromSize} > source size ${sourceSize}`);
		}

		const todo = this.populateWork(fromSize, sourceSize);

		// Do the copying
		const eg = new ErrGroup();
		for (let i = 0; i < this.#numWorkers; i++) {
			eg.go(() => this.#worker(todo, signal));
		}
		try {
			await eg.wait();
		} catch (err) {
			throw new Error(`copy failed: ${errText(err)}`);
		}
	}

	/** Progress returns the number of bundles from the source present in the target. */
	bundlesCopied(): bigint {
		return this._bundlesCopied;
	}

	/**
	 * populateWork sends entries to the `todo` work channel.
	 * Each entry corresponds to an individual entryBundle which needs to be copied.
	 *
	 * Port note: Go's `populateWork` runs in its own goroutine, pushing each item onto the
	 * buffered `todo` channel that `worker` goroutines drain concurrently -- the channel's
	 * capacity (`numWorkers`) bounds how far the producer can run ahead of the slowest
	 * consumer. Here `populateWork` returns a synchronous generator instead (the "`todo`
	 * work channel" above), and `copy` has every worker call `.next()` on the *same*
	 * generator object directly. This is safe with no lock: `Generator.next()` runs
	 * synchronously to its next `yield`, and JavaScript's single-threaded, run-to-completion
	 * semantics mean no two `.next()` calls can ever interleave, so each work item still goes
	 * to exactly one worker. It is also no less memory-bounded than Go's channel, since
	 * nothing is materialized ahead of demand either way. See
	 * docs/decisions/0077-copier-work-distribution-is-a-shared-generator.md.
	 *
	 * @internal Go's `populateWork` is unexported and has no direct upstream test (there is
	 * no migrate_test.go); public here specifically so `migrate_test.ts` can pin the
	 * chunking arithmetic, where an off-by-one would duplicate or skip entries during a real
	 * migration (ADR-0010).
	 */
	*populateWork(from: bigint, treeSize: bigint): Generator<bundle> {
		for (const ri of range(from, treeSize - from, treeSize)) {
			yield { index: ri.index, partial: ri.partial };
		}
	}

	/**
	 * worker undertakes work items from the `todo` channel.
	 *
	 * It will attempt to retry failed operations several times before giving up, this should help
	 * deal with any transient errors which may occur.
	 */
	async #worker(todo: Generator<bundle>, signal?: AbortSignal): Promise<void> {
		for (let next = todo.next(); !next.done; next = todo.next()) {
			const b = next.value;
			const n = await retryWithBackoff(
				10,
				async (): Promise<bigint> => {
					let d: Uint8Array;
					try {
						d = await this.#getEntryBundle(b.index, b.partial, signal);
					} catch (err) {
						throw new Error(`failed to fetch entrybundle ${b.index} (p=${b.partial}): ${errText(err)}`);
					}
					try {
						await this.#setEntryBundle(b.index, b.partial, d, signal);
					} catch (err) {
						throw new Error(`failed to store entrybundle ${b.index} (p=${b.partial}): ${errText(err)}`);
					}
					return 1n;
				},
				signal,
			);
			this._bundlesCopied += n;
		}
	}
}

/**
 * bundle represents the address of an individual entry bundle.
 *
 * Port note: Go declares this struct between copier's and copier's methods; TypeScript keeps
 * methods inside the class body, so it follows the class.
 *
 * @internal Go's `bundle` is unexported; exported here (ADR-0010's pattern) so
 * `populateWork`'s return type is reachable from `migrate_test.ts`.
 */
export interface bundle {
	readonly index: bigint;
	readonly partial: number;
}

/**
 * retryWithBackoff calls operation until it succeeds, maxTries attempts have been made, the
 * signal is aborted, or the retries have taken longer than defaultMaxElapsedTimeMs, sleeping
 * an exponentially growing, randomised interval between attempts.
 *
 * Port note: stands in for the call the worker makes,
 * `backoff.Retry(ctx, operation, backoff.WithMaxTries(10), backoff.WithBackOff(backoff.NewExponentialBackOff()))`
 * from `github.com/cenkalti/backoff/v5` v5.0.3, a third-party dependency outside this port's
 * allow-list (AGENTS.md §7). It follows that version's `Retry` step for step: the operation
 * always runs at least once; after a failure it stops with the operation's error once
 * maxTries attempts have been made, with the signal's reason (Go: `context.Cause(ctx)`) if
 * the signal is aborted, and with the operation's error again if the next wait would take
 * the total past `DefaultMaxElapsedTime` (15 minutes); a signal aborted during the wait
 * ends it with the signal's reason. The waits follow `ExponentialBackOff`'s defaults and its
 * arithmetic in nanoseconds (500ms initial interval, 1.5x multiplier, 60s cap on the
 * interval, ±50% jitter). `PermanentError` and `RetryAfterError` are not reproduced, as the
 * worker's operation never returns either. The random source is `Math.random`, so the
 * exact waits differ from run to run, as they do in Go. See
 * docs/decisions/0073-migrate-retry-backoff.md.
 */
async function retryWithBackoff<T>(maxTries: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const b = new exponentialBackOff();
	const startedAt = Date.now();
	for (let numTries = 1; ; numTries++) {
		// Execute the operation.
		try {
			return await operation();
		} catch (err) {
			// Stop retrying if maximum tries exceeded.
			if (maxTries > 0 && numTries >= maxTries) {
				throw err;
			}

			// Stop retrying if context is cancelled.
			if (signal?.aborted) {
				throw signal.reason;
			}

			// Calculate next backoff duration.
			const nextMs = b.nextBackOffMs();

			// Stop retrying if maximum elapsed time exceeded.
			if (Date.now() - startedAt + nextMs > defaultMaxElapsedTimeMs) {
				throw err;
			}

			// Wait for the next backoff period or context cancellation. sleep rejects with the
			// signal's reason, which is Go's context.Cause(ctx).
			await sleep(nextMs, signal);
		}
	}
}

// defaultMaxElapsedTimeMs is backoff v5.0.3's DefaultMaxElapsedTime (15 * time.Minute), the
// bound Retry applies when no WithMaxElapsedTime option is given.
const defaultMaxElapsedTimeMs = 15 * 60 * 1000;

/**
 * exponentialBackOff is backoff v5.0.3's ExponentialBackOff with the defaults
 * NewExponentialBackOff sets. Intervals are kept in nanoseconds, as Go's time.Duration
 * keeps them, so the truncations match; only the value handed to sleep is milliseconds.
 */
class exponentialBackOff {
	static readonly initialIntervalNs = 500 * 1_000_000;
	static readonly randomizationFactor = 0.5;
	static readonly multiplier = 1.5;
	static readonly maxIntervalNs = 60 * 1_000 * 1_000_000;

	// Go: Reset(), which Retry calls before the first attempt.
	#currentIntervalNs = exponentialBackOff.initialIntervalNs;

	nextBackOffMs(): number {
		const current = this.#currentIntervalNs;
		const delta = exponentialBackOff.randomizationFactor * current;
		const minInterval = current - delta;
		const maxInterval = current + delta;
		// Get a random value from the range [minInterval, maxInterval]. Go adds 1 so that the
		// upper bound itself can be chosen.
		const nextNs = Math.trunc(minInterval + Math.random() * (maxInterval - minInterval + 1));
		// Check for overflow, if overflow is detected set the current interval to the max interval.
		if (current >= exponentialBackOff.maxIntervalNs / exponentialBackOff.multiplier) {
			this.#currentIntervalNs = exponentialBackOff.maxIntervalNs;
		} else {
			this.#currentIntervalNs = Math.trunc(current * exponentialBackOff.multiplier);
		}
		return nextNs / 1_000_000;
	}
}

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
