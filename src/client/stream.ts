// Copyright 2025 The Tessera Authors. All Rights Reserved.
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
// Ported from tessera/client/stream.go @ 4a6d9f9
//
// Port note: `iter.Seq2[T, error]` becomes `AsyncGenerator<T>` (errors thrown, not
// yielded — PORTING.md §3.6): these generators do real I/O, unlike the synchronous
// `iter.Seq` generators in api/layout.
//
// Port note: upstream's OpenTelemetry spans are dropped along with client/otel.go; see
// docs/decisions/0061-otel-tracing-dropped.md.

// Module stream provides support for streaming contiguous entries from logs.

import { EntryBundleWidth, type RangeInfo, range } from "../api/layout/index.ts";
import type { EntryBundleFetcherFunc } from "./client.ts";

const entryBundleWidth64 = BigInt(EntryBundleWidth);

/** TreeSizeFunc is a function which knows how to return the current tree size of a log. */
export type TreeSizeFunc = (signal?: AbortSignal) => Promise<bigint>;

/**
 * Bundle represents an entry bundle in a log, along with some metadata about which parts of the bundle
 * are relevent.
 */
export interface Bundle {
	/** rangeInfo decribes which of the entries in this bundle are relevent. */
	readonly rangeInfo: RangeInfo;
	/**
	 * data is the raw serialised bundle, as fetched from the log.
	 *
	 * For a tlog-tiles compliant log, this can be unmarshaled using api.EntryBundle.
	 */
	readonly data: Uint8Array;
}

/**
 * entryBundles produces an async generator which returns a stream of Bundle structs which cover the requested range of entries in their natural order in the log.
 *
 * If the adaptor encounters an error while reading an entry bundle, the encountered error will be thrown from the generator.
 *
 * This adaptor is optimised for the case where calling getBundle has some appreciable latency, and works
 * around that by maintaining a read-ahead window of up to numWorkers concurrent in-flight requests to
 * getBundle. The request parallelism is set by the value of the numWorkers paramemter, which can be tuned
 * to balance throughput against consumption of resources, but such balancing needs to be mindful of the nature of the
 * source infrastructure, and how concurrent requests affect performance (e.g. GCS buckets vs. files on a single disk).
 *
 * Port note: Go implements the bounded read-ahead with a goroutine, a buffered channel of
 * futures and a token bucket. JavaScript has no goroutines; a sliding window of up to
 * `numWorkers` in-flight promises, refilled as each one is awaited (in dispatch order),
 * gives the same bound on concurrency and the same strict in-order delivery without that
 * machinery — see docs/decisions/0004-errors-context-and-concurrency.md's guidance to
 * check whether a simpler translation suffices before reaching for ErrGroup/Mutex.
 */
export async function* entryBundles(
	numWorkers: number,
	getSize: TreeSizeFunc,
	getBundle: EntryBundleFetcherFunc,
	fromEntry: bigint,
	N: bigint,
	signal?: AbortSignal,
): AsyncGenerator<Bundle> {
	const treeSize = await getSize(signal);

	// Port note: the second argument is `fromEntry + N`, not `N`. This mirrors
	// upstream exactly: every real caller of EntryBundles (the antispam followers in
	// storage/{posix,gcp,aws}/antispam/*.go, and this package's own fsck.go) constructs
	// N so that fromEntry + N is the *absolute* log position it wants to stream up to
	// (e.g. `N = logSize - followFrom`, so `fromEntry + N = logSize`). Passing that sum
	// as layout.Range's own "N" (count) parameter relies on Range's `min(from+N,
	// treeSize)` saturation to turn it into "everything from fromEntry up to the
	// current tree size, capped at fromEntry+N" — porting `N` instead here would
	// silently change behaviour for every fromEntry != 0 caller.
	const infos = range(fromEntry, fromEntry + N, treeSize);

	// window holds up to numWorkers in-flight bundle fetches, oldest-dispatched-first.
	// fillWindow tops it back up to numWorkers every time a slot frees, which happens
	// as soon as the oldest fetch has been awaited -- the same point at which upstream
	// returns a token to its bucket.
	const window: Promise<Bundle>[] = [];
	const fillWindow = (): void => {
		while (window.length < numWorkers) {
			const next = infos.next();
			if (next.done === true) {
				return;
			}
			const ri = next.value;
			const pending = getBundle(ri.index, ri.partial, signal).then((data) => ({ rangeInfo: ri, data }));
			// A fetch that rejects while it is still waiting its turn at the front of the
			// window would otherwise look like an unhandled rejection to the host runtime
			// (Node's unhandledRejection, a browser's onunhandledrejection, a Worker's
			// error log) even though the loop below awaits it and surfaces the error in
			// order. Attaching a no-op rejection handler marks it handled without
			// consuming the rejection -- the `await window.shift()` below still throws the
			// original error. Go has no equivalent wart: its worker goroutine parks the
			// error in a buffered channel and exits cleanly.
			pending.catch(() => {});
			window.push(pending);
		}
	};
	fillWindow();

	while (window.length > 0) {
		// Port note: Go's consumer loop only continues after the current bundle has
		// been yielded and the caller has asked for the next one; if `next` rejects,
		// the exception propagates out of this generator here, which is the port of
		// "yield(bundleOrErr{err: err}); return" -- the generator is done after a throw,
		// exactly as the upstream iterator stops after yielding an error.
		const next = window.shift() as Promise<Bundle>;
		const bundle = await next;
		fillWindow();
		yield bundle;
	}
}

/** Entry represents a single leaf in a log. */
export interface Entry<T> {
	/** index is the index of the entry in the log. */
	readonly index: bigint;
	/** entry is the entry from the log. */
	readonly entry: T;
}

/**
 * entries consumes an async generator of Bundle structs and transforms it using the provided unbundle function, and returns an async generator over the transformed data.
 *
 * Different unbundle implementations can be provided to return raw entry bytes, parsed entry structs, or derivations of entries (e.g. hashes) as needed.
 */
export async function* entries<T>(
	bundles: AsyncGenerator<Bundle>,
	unbundle: (data: Uint8Array) => T[],
): AsyncGenerator<Entry<T>> {
	for await (const b of bundles) {
		let es = unbundle(b.data);
		if (es.length <= b.rangeInfo.first) {
			throw new Error(`logic error: First is ${b.rangeInfo.first} but only ${es.length} entries`);
		}
		es = es.slice(b.rangeInfo.first);
		if (es.length > b.rangeInfo.n) {
			es = es.slice(0, b.rangeInfo.n);
		}

		const rIdx = b.rangeInfo.index * entryBundleWidth64 + BigInt(b.rangeInfo.first);
		for (let i = 0; i < es.length; i++) {
			yield { index: rIdx + BigInt(i), entry: es[i] as T };
		}
	}
}
