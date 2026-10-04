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
import { asUint64 } from "../internal/gostd/bits.ts";
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
 * around that by maintaining a read-ahead cache of subsequent bundles which is populated a number of parallel
 * requests to getBundle. The request parallelism is set by the value of the numWorkers paramemter, which can be tuned
 * to balance throughput against consumption of resources, but such balancing needs to be mindful of the nature of the
 * source infrastructure, and how concurrent requests affect performance (e.g. GCS buckets vs. files on a single disk).
 *
 * Port note: Go implements the bounded read-ahead with a goroutine, a buffered channel of
 * futures and a token bucket. JavaScript has no goroutines; a sliding window of up to
 * `numWorkers` in-flight promises, refilled as each one is awaited (in dispatch order),
 * gives the same bound on concurrency and the same strict in-order delivery without that
 * machinery. See docs/decisions/0066-entrybundles-sliding-window-concurrency.md.
 *
 * Port note: Go's producer goroutine starts when EntryBundles is called, so getSize and
 * the first numWorkers fetches begin before the caller first iterates, and whether or not
 * it ever does. An async generator runs only once asked for a value, so here nothing is
 * fetched until the first `next()` (docs/decisions/0066).
 *
 * Port note: a numWorkers that is not an integer of at least 1 throws a RangeError when
 * entryBundles is called. Go's token bucket never yields a token for numWorkers == 0, so
 * its iterator blocks forever. See
 * docs/decisions/0192-numworkers-below-one-is-rejected.md.
 */
export function entryBundles(
	numWorkers: number,
	getSize: TreeSizeFunc,
	getBundle: EntryBundleFetcherFunc,
	fromEntry: bigint,
	N: bigint,
	signal?: AbortSignal,
): AsyncGenerator<Bundle> {
	if (!Number.isInteger(numWorkers) || numWorkers < 1) {
		throw new RangeError(`numWorkers must be an integer of at least 1, got ${numWorkers}`);
	}
	return streamEntryBundles(numWorkers, getSize, getBundle, fromEntry, N, signal);
}

/** streamEntryBundles is the body of entryBundles, once numWorkers has been checked. */
async function* streamEntryBundles(
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
	// silently change behaviour for every fromEntry != 0 caller. The sum wraps as Go's
	// uint64 addition does (docs/decisions/0014-uint64-wrapping-made-explicit.md).
	const infos = range(fromEntry, asUint64(fromEntry + N), treeSize);

	// Fetch entry bundle resources in parallel.
	// We use a limited number of tokens here to prevent this from
	// consuming an unbounded amount of resources.
	//
	// Port note: window holds up to numWorkers in-flight bundle fetches,
	// oldest-dispatched-first; it stands in for both the token bucket and the channel of
	// futures. fillWindow tops it back up to numWorkers every time a slot frees. Upstream's
	// comments on the channel, the futures and the tokens it replaces (ADR-0066) are kept
	// below, each beside the part of the window that does that job:
	//
	//   bundleOrErr represents a fetched entry bundle and its params, or an error if we couldn't fetch it for
	//   some reason.
	//
	//   bundles will be filled with futures for in-order entry bundles by the worker
	//   go routines below.
	//   This channel will be drained by the loop at the bottom of this func which
	//   yields the bundles to the caller.
	//
	//   We'll limit ourselves to numWorkers worth of on-going work using these tokens:
	const window: Promise<Bundle>[] = [];
	const fillWindow = (): void => {
		// Port note, upstream's comment on its loop: "For each bundle, pop a future into the
		// bundles channel and kick off an async request to resolve it."
		while (window.length < numWorkers) {
			const next = infos.next();
			if (next.done === true) {
				return;
			}
			const ri = next.value;
			// Port note, upstream's comment on taking a token: "We'll return a token below, once
			// the bundle is fetched _and_ is being yielded." Here the slot this fetch takes is
			// freed by the loop below, once the fetch has resolved and is being yielded.
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
		const next = window.shift() as Promise<Bundle>;
		// For now, force the iterator to stop if we've just returned an error.
		// If there's a good reason to allow it to continue we can change this.
		//
		// Port note: if `next` rejects, the exception propagates out of this generator
		// here, and a generator that has thrown is done -- the stop Go writes out
		// explicitly after yielding the error.
		const bundle = await next;
		// We're about to yield a value, so we can now return the token and unblock another fetch.
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
		// Port note: hardening with no Go counterpart: Go yields however many of the range's
		// N entries the bundle actually holds, so a short bundle silently drops entries. See
		// docs/decisions/0194-tile-and-bundle-size-limits.md.
		if (es.length < b.rangeInfo.first + b.rangeInfo.n) {
			throw new Error(
				`bundle ${b.rangeInfo.index} has ${es.length} entries, but the range needs ${b.rangeInfo.first + b.rangeInfo.n}`,
			);
		}
		es = es.slice(b.rangeInfo.first);
		if (es.length > b.rangeInfo.n) {
			es = es.slice(0, b.rangeInfo.n);
		}

		// Port note: the index arithmetic wraps as Go's uint64 arithmetic does
		// (docs/decisions/0014-uint64-wrapping-made-explicit.md).
		const rIdx = asUint64(b.rangeInfo.index * entryBundleWidth64 + BigInt(b.rangeInfo.first));
		for (let i = 0; i < es.length; i++) {
			yield { index: asUint64(rIdx + BigInt(i)), entry: es[i] as T };
		}
	}
}
