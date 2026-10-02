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
// Ported from tessera/migrate.go @ 4a6d9f9
//
// Port note: klog request logging is dropped, matching every other package in this
// port -- docs/decisions/0070-witness-and-migrate-drop-otel-and-klog.md. `github.com/cenkalti/backoff/v5`
// (worker retry policy) is a third-party dependency outside this port's allow-list
// (PORTING.md §7); `retryWithBackoff` below reproduces the shape of its default policy
// without being a byte-for-byte port -- see docs/decisions/0073-migrate-retry-backoff.md.
// There is no `migrate_test.go` upstream (this file's coverage comes from Tessera's
// `integration/` end-to-end suite, which needs a real storage `Driver`). `migrate_test.ts`
// here is new, covering exactly the pure logic reachable without a driver:
// `populateWork`'s chunking arithmetic. See
// docs/decisions/0074-migrate-untestable-without-driver.md.

import { range } from "./api/layout/index.ts";
import type { EntryBundleFetcherFunc } from "./client/index.ts";
import { throwIfAborted } from "./internal/gostd/errors.ts";
import { ErrGroup, sleep } from "./internal/gostd/sync.ts";

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * setEntryBundleFunc is the signature of a function which can durably store a serialised
 * entry bundle at the given index/partial size.
 *
 * Port note: unexported in Go (`setEntryBundleFunc`); kept unexported here too, since
 * nothing outside this file needs it -- `migrate_lifecycle.ts` passes `writer.setEntryBundle`
 * (a bound method matching this shape) directly to `newCopier`.
 */
type setEntryBundleFunc = (index: bigint, partial: number, bundle: Uint8Array, signal?: AbortSignal) => Promise<void>;

/**
 * newCopier constructs a copier ready to migrate entry bundles from a source log into a
 * target Driver.
 *
 * @internal Go's `copier` is unexported; exported here (ADR-0010's pattern) so
 * `migrate_lifecycle.ts` -- a different TypeScript module standing in for the same Go
 * package -- and `migrate_test.ts` can reach it. Not re-exported from `src/index.ts`.
 */
export function newCopier(
	numWorkers: number,
	setEntryBundle: setEntryBundleFunc,
	getEntryBundle: EntryBundleFetcherFunc,
): Copier {
	return new Copier(setEntryBundle, getEntryBundle, numWorkers);
}

/**
 * bundle represents the address of an individual entry bundle.
 *
 * @internal Go's `bundle` is unexported; exported here (ADR-0010's pattern) so
 * `populateWork`'s return type is reachable from `migrate_test.ts`.
 */
export interface Bundle {
	readonly index: bigint;
	readonly partial: number;
}

/**
 * populateWork yields the bundle work items needed to copy the half-open entry range
 * `[from, treeSize)`, mirroring Go's `populateWork`'s use of `layout.Range`.
 *
 * Port note: Go's `populateWork` runs in its own goroutine, pushing each item onto the
 * buffered `todo` channel that `worker` goroutines drain concurrently -- the channel's
 * capacity (`numWorkers`) bounds how far the producer can run ahead of the slowest
 * consumer. Here `populateWork` is a plain synchronous generator instead, and
 * `Copier.copy` has every worker call `.next()` on the *same* generator object directly.
 * This is safe with no lock: `Generator.next()` runs synchronously to its next `yield`,
 * and JavaScript's single-threaded, run-to-completion semantics mean no two `.next()`
 * calls can ever interleave, so each work item still goes to exactly one worker. It is
 * also simpler and no less memory-bounded than Go's channel, since nothing is
 * materialized ahead of demand either way. See
 * docs/decisions/0077-copier-work-distribution-is-a-shared-generator.md for the full
 * reasoning, and docs/decisions/0074-migrate-untestable-without-driver.md for what this
 * change means for what can and cannot be tested without a storage driver.
 *
 * @internal Go's `populateWork` is unexported and has no direct upstream test (there is
 * no migrate_test.go); exported here specifically so `migrate_test.ts` can pin the
 * chunking arithmetic, where an off-by-one would duplicate or skip entries during a real
 * migration. Not re-exported from `src/index.ts`.
 */
export function* populateWork(from: bigint, treeSize: bigint): Generator<Bundle> {
	for (const ri of range(from, treeSize - from, treeSize)) {
		yield { index: ri.index, partial: ri.partial };
	}
}

/**
 * retryWithBackoff calls fn, retrying with exponential backoff and jitter between
 * attempts if it throws, up to maxTries attempts in total.
 *
 * Port note: stands in for `github.com/cenkalti/backoff/v5`'s
 * `backoff.Retry(ctx, fn, backoff.WithMaxTries(10), backoff.WithBackOff(backoff.NewExponentialBackOff()))`.
 * The parameters below (500ms initial interval, 1.5x multiplier, 60s cap, 50% jitter) are
 * that library's own documented defaults, reproduced here rather than imported, since it
 * is a third-party dependency outside this port's allow-list (PORTING.md §7). This is not
 * a byte-for-byte port of its jitter algorithm -- nothing in this package asserts on
 * retry timing, there being no upstream migrate_test.go to assert it in the first place.
 * See docs/decisions/0073-migrate-retry-backoff.md.
 */
async function retryWithBackoff<T>(maxTries: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const initialIntervalMs = 500;
	const multiplier = 1.5;
	const maxIntervalMs = 60_000;
	const randomizationFactor = 0.5;

	let intervalMs = initialIntervalMs;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxTries; attempt++) {
		throwIfAborted(signal);
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (attempt === maxTries) {
				break;
			}
			const jitter = intervalMs * randomizationFactor * (Math.random() * 2 - 1);
			await sleep(Math.max(0, intervalMs + jitter), signal);
			intervalMs = Math.min(intervalMs * multiplier, maxIntervalMs);
		}
	}
	throw lastErr;
}

/** copier controls the migration work. */
export class Copier {
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

		const todo = populateWork(fromSize, sourceSize);

		// Do the copying.
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

	/** bundlesCopied returns the number of bundles from the source present in the target. */
	bundlesCopied(): bigint {
		return this._bundlesCopied;
	}

	/**
	 * worker undertakes work items from the todo generator.
	 *
	 * It will attempt to retry failed operations several times before giving up, this should help
	 * deal with any transient errors which may occur.
	 */
	async #worker(todo: Generator<Bundle>, signal?: AbortSignal): Promise<void> {
		for (let next = todo.next(); !next.done; next = todo.next()) {
			const b = next.value;
			await retryWithBackoff(
				10,
				async () => {
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
				},
				signal,
			);
			this._bundlesCopied += 1n;
		}
	}
}
