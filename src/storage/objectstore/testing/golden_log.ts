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

// How the golden compatibility suite (./golden.ts) drives a log and looks inside a store:
// appending the fixture entries through the public newAppender API exactly as
// fixtures/gen/log.go appended them in Go, and finding out which keys a store holds without
// requiring the ObjectStore contract to grow a listing operation. Plain functions that throw
// ordinary errors, with no test-framework dependency; test-only, excluded from the published
// build.

import { type AppendOptions, newAppender, newAppendOptions } from "../../../append_lifecycle.ts";
import { newPublicationAwaiter } from "../../../await.ts";
import { newEntry } from "../../../entry.ts";
import { newSigner } from "../../../vendor/note/note.ts";
import { newObjectStoreDriver, type ObjectStoreDriver } from "../driver.ts";
import type { ObjectInfo, ObjectStore } from "../objectstore.ts";
import { entryData, logSKey } from "./golden_fixtures.ts";

/**
 * goldenOptions mirrors fixtures/gen/log.go's runLog options, with the batching left to the
 * caller: checkpoint republication and garbage collection disabled, and the minimum checkpoint
 * interval. Disabling GC is what makes the set of keys a pure function of the batch boundaries.
 */
export function goldenOptions(batchSize: number, batchMaxAgeMs: number): AppendOptions {
	return newAppendOptions()
		.withCheckpointSigner(newSigner(logSKey))
		.withBatching(batchSize, batchMaxAgeMs)
		.withCheckpointInterval(100)
		.withCheckpointRepublishInterval(0)
		.withGarbageCollectionInterval(0);
}

/** oneBatch is the longest batch age that still lets a test fail fast: batches here flush by size. */
const oneBatchMaxAgeMs = 3_600_000;

/** singleBatchOptions returns goldenOptions for a run that adds `n` entries as exactly one batch. */
export function singleBatchOptions(n: number): AppendOptions {
	// The queue rejects a zero-sized batch, and an empty run never fills one anyway: the same
	// special case fixtures/gen/log.go makes for log_0.
	return goldenOptions(Math.max(n, 1), oneBatchMaxAgeMs);
}

/**
 * appendEntries starts a fresh driver and appender over store, appends the fixture entries
 * [from, to) in order, waits until a published checkpoint covers them, shuts the appender down,
 * and returns the driver so that the caller can garbage collect through it.
 *
 * The entries are added synchronously, before any of their futures is awaited, so batch
 * boundaries are deterministic: the queue flushes each time it fills, and the remainder once
 * the batch age expires. The suite's expectations about superseded partial resources rely on
 * that.
 *
 * It waits with a PublicationAwaiter, as fixtures/gen/log.go does, rather than relying on
 * shutdown alone: shutdown treats an appender whose largest issued index is 0 as having done no
 * work (append_lifecycle.go's "special case no work done"), so it would return before a
 * one-entry log's first checkpoint is published.
 */
export async function appendEntries(
	store: ObjectStore,
	opts: AppendOptions,
	from: number,
	to: number,
): Promise<ObjectStoreDriver> {
	const driver = newObjectStoreDriver({ store });
	const ac = new AbortController();
	try {
		const { appender, shutdown, reader } = await newAppender(driver, opts, ac.signal);
		const futures = [];
		for (let i = from; i < to; i++) {
			futures.push(appender.add(newEntry(entryData(i))));
		}
		const indices = await Promise.all(futures.map((f) => f()));
		for (const [i, idx] of indices.entries()) {
			// Entries must be sequenced in order for the comparison to mean anything, exactly as
			// fixtures/gen/log.go insists for the fixture itself.
			if (idx.index !== BigInt(from + i)) {
				throw new Error(`entry ${from + i} was assigned index ${idx.index}`);
			}
		}
		const last = futures.at(-1);
		if (last !== undefined) {
			const awaiter = newPublicationAwaiter((s?: AbortSignal) => reader.readCheckpoint(s), 10, ac.signal);
			await awaiter.await(last, ac.signal);
		}
		await shutdown(ac.signal);
	} finally {
		ac.abort();
	}
	return driver;
}

/**
 * collectGarbage runs one garbage-collection pass over a log of the given size, as the
 * appender's GC loop would once that size is published. It reaches the driver's internal
 * garbageCollect, as the files_test.go port does, because the suite disables the loop to keep
 * the key set deterministic. 1000 bundles is more than any fixture has, so one pass finishes.
 */
export function collectGarbage(driver: ObjectStoreDriver, size: number): Promise<void> {
	return driver.garbageCollect(BigInt(size), 1000, newAppendOptions().entriesPath());
}

/**
 * KeyRecorder remembers every key written through the stores it wraps, so that the suite can
 * tell exactly which keys a backend holds without a listing operation.
 *
 * The ObjectStore contract deliberately has no `list` (docs/decisions/0101-objectstore-partial-tiles-not-relinked.md).
 * Every store the suite uses starts empty and is only ever written through a wrapper, so the
 * recorded keys are every key the driver asked the backend to hold, and reading each of them
 * back from the backend itself (not from the wrapper's memory) yields exactly the ones it does
 * hold. Keys a backend dropped, failed to delete, or kept under a different name all show up as
 * a difference. What it cannot see is a backend inventing a key nobody asked for, which is why
 * the suite prefers a backend's own listing (GoldenCompatibilityOptions.listKeys) when there is
 * one.
 */
export class KeyRecorder {
	readonly #written = new Set<string>();

	/** wrap returns store with every put and create recorded; reads and locks pass straight through. */
	wrap(store: ObjectStore): ObjectStore {
		const written = this.#written;
		return {
			get: (key: string): Promise<Uint8Array | undefined> => store.get(key),
			stat: (key: string): Promise<ObjectInfo | undefined> => store.stat(key),
			put: (key: string, data: Uint8Array): Promise<void> => {
				written.add(key);
				return store.put(key, data);
			},
			create: (key: string, data: Uint8Array): Promise<boolean> => {
				written.add(key);
				return store.create(key, data);
			},
			deletePrefix: (prefix: string): Promise<void> => store.deletePrefix(prefix),
			lock: <T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => store.lock(name, fn, signal),
		};
	}

	/**
	 * heldKeys returns, in ascending order, every key that was written through a wrapped store or
	 * is named in also, and that store holds now.
	 */
	async heldKeys(store: ObjectStore, also: Iterable<string> = []): Promise<string[]> {
		const held: string[] = [];
		for (const key of new Set([...this.#written, ...also])) {
			// get rather than stat: holding a key means handing its bytes back.
			if ((await store.get(key)) !== undefined) {
				held.push(key);
			}
		}
		return held.sort();
	}
}
