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
// Ported from tessera/client/stream_test.go @ 4a6d9f9
//
// Port note: upstream's TestEntryBundles and TestEntries drive a real, live
// testonly.NewTestLog (full storage/append-lifecycle machinery) -- a Wave 2/3
// dependency this package does not and must not depend on (see the mission brief in
// docs/notes/ORCHESTRATION.md). This file instead drives entryBundles/entries against
// the log_1000 and log_5000 fixtures (fixtures/gen/log.go), which are real,
// byte-identical logs built by the actual Tessera POSIX driver -- the same fixtures the
// storage-internal package's own integration tests use, per the mission brief's
// encouragement to cross-check client-level code against log_<N>.json.
//
// This also means the cases below are not the same cases as upstream's: an equivalent
// coverage was built for what these fixtures make possible. In particular, a single
// entryBundles() call snapshots the tree size exactly once (see the Port note above
// entryBundles in stream.ts): mutating a size closure's return value mid-loop -- what
// upstream's TestEntryBundles literally does -- has no effect on an already-running
// call. "Resuming after growth" instead means calling entryBundles again, which is what
// every real caller (the antispam followers in storage/{posix,gcp,aws}/antispam/*.go,
// and this package's own fsck.go) actually does; see the "resumes ... across repeated
// calls" case below.

import { beforeAll, describe, expect, it } from "vitest";
import { EntryBundleWidth, entriesPath } from "../api/layout/index.ts";
import { EntryBundle } from "../api/state.ts";
import { partialOrFullResource } from "../internal/fetcher/fallback.ts";
import { fromUTF8, toUTF8 } from "../internal/gostd/bytes.ts";
import { ErrNotExist } from "../internal/gostd/errors.ts";
import { type Fixture, hexToBytes, loadFixture, u64 } from "../testonly/fixtures.ts";
import type { EntryBundleFetcherFunc } from "./client.ts";
import { entries, entryBundles, type TreeSizeFunc } from "./stream.ts";

interface BundleFile {
	readonly path: string;
	readonly raw: string;
}
interface LogFixture {
	readonly size: string;
	readonly entryBundles: readonly BundleFile[];
}

/** entryData mirrors the fixture corpus: entry i is the UTF-8 bytes of "entry-<i>". */
function entryData(i: bigint): string {
	return `entry-${i}`;
}

/** buildBundleFetcher serves entry bundles from a log_<N> fixture, exactly like a real EntryBundleFetcherFunc would serve them from disk or over HTTP -- partial-then-fall-back-to-full included. */
function buildBundleFetcher(fixture: Fixture<LogFixture>): EntryBundleFetcherFunc {
	const resources = new Map<string, Uint8Array>();
	for (const b of fixture.entryBundles) {
		resources.set(b.path, hexToBytes(b.raw));
	}
	return async (i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> =>
		partialOrFullResource(
			p,
			async (pp: number): Promise<Uint8Array> => {
				const raw = resources.get(entriesPath(i, pp));
				if (raw === undefined) {
					throw ErrNotExist;
				}
				return raw;
			},
			signal,
		);
}

function unbundle(data: Uint8Array): Uint8Array[] {
	const eb = new EntryBundle();
	eb.unmarshalText(data);
	return eb.entries;
}

let log1000: Fixture<LogFixture>;
let log5000: Fixture<LogFixture>;

beforeAll(async () => {
	[log1000, log5000] = await Promise.all([loadFixture<LogFixture>("log_1000"), loadFixture<LogFixture>("log_5000")]);
});

it("TestEntries", async () => {
	const logSize = u64(log1000.size);
	const getBundle = buildBundleFetcher(log1000);
	const size: TreeSizeFunc = async (): Promise<bigint> => logSize;

	const want = new Set<string>();
	for (let i = 0n; i < logSize; i++) {
		want.add(entryData(i));
	}

	const got = new Set<string>();
	for await (const e of entries(entryBundles(2, size, getBundle, 0n, logSize), unbundle)) {
		const text = fromUTF8(e.entry);
		expect(want.has(text), `unexpected entry ${text}`).toBe(true);
		expect(got.has(text), `duplicate entry ${text}`).toBe(false);
		got.add(text);
	}
	expect(got.size).toBe(Number(logSize));
});

it("TestEntryBundles yields bundles covering the requested range in order", async () => {
	const logSize = u64(log5000.size);
	const getBundle = buildBundleFetcher(log5000);
	const size: TreeSizeFunc = async (): Promise<bigint> => logSize;

	let seenEntries = 0n;
	for await (const gotEntry of entryBundles(2, size, getBundle, 0n, logSize)) {
		const e = gotEntry.rangeInfo.index * BigInt(EntryBundleWidth) + BigInt(gotEntry.rangeInfo.first);
		expect(e, `got idx`).toBe(seenEntries);
		seenEntries += BigInt(gotEntry.rangeInfo.n);
	}
	expect(seenEntries).toBe(logSize);
});

it("bounds concurrent fetches to numWorkers", async () => {
	const logSize = u64(log5000.size);
	const base = buildBundleFetcher(log5000);

	let inFlight = 0;
	let maxInFlight = 0;
	const numWorkers = 3;
	const getBundle: EntryBundleFetcherFunc = async (i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			// Give overlapping calls a chance to actually overlap before resolving,
			// instead of each one finishing synchronously before the next dispatch.
			await Promise.resolve();
			await Promise.resolve();
			return await base(i, p, signal);
		} finally {
			inFlight--;
		}
	};
	const size: TreeSizeFunc = async (): Promise<bigint> => logSize;

	let count = 0;
	for await (const _b of entryBundles(numWorkers, size, getBundle, 0n, logSize)) {
		count++;
	}
	expect(count).toBe(log5000.entryBundles.length);
	expect(maxInFlight, "never actually ran concurrently").toBeGreaterThan(1);
	expect(maxInFlight, `exceeded numWorkers=${numWorkers}`).toBeLessThanOrEqual(numWorkers);
});

it("propagates a getBundle error and stops the stream", async () => {
	const logSize = u64(log1000.size);
	const base = buildBundleFetcher(log1000);
	const boom = new Error("boom");
	const getBundle: EntryBundleFetcherFunc = async (i: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array> => {
		if (i === 2n) {
			throw boom;
		}
		return base(i, p, signal);
	};
	const size: TreeSizeFunc = async (): Promise<bigint> => logSize;

	const seen: bigint[] = [];
	let caught: unknown;
	try {
		for await (const b of entryBundles(1, size, getBundle, 0n, logSize)) {
			seen.push(b.rangeInfo.index);
		}
	} catch (err) {
		caught = err;
	}

	expect(caught).toBe(boom);
	// numWorkers=1 makes fetch order deterministic: bundles 0 and 1 are yielded
	// before the fetch for bundle 2 (index 2) throws.
	expect(seen).toEqual([0n, 1n]);
});

// The three fixture-driven tests above resolve their fetches in roughly dispatch order,
// so on their own they cannot distinguish "yields in dispatch order" from "yields in
// resolution order". The two tests below use a fetcher whose resolution is driven by
// hand, forcing *later* indices to settle before earlier ones, which is exactly the race
// the sliding window's strict-ordering guarantee (see the Port note above entryBundles)
// has to survive.

/** deferredFetcher hands back an EntryBundleFetcherFunc whose every call parks until the test explicitly resolves or rejects that index. */
function deferredFetcher(): {
	fetch: EntryBundleFetcherFunc;
	resolve: (i: bigint) => void;
	reject: (i: bigint, e: unknown) => void;
	dispatched: bigint[];
} {
	const resolvers = new Map<string, (v: Uint8Array) => void>();
	const rejecters = new Map<string, (e: unknown) => void>();
	const dispatched: bigint[] = [];
	// entryBundles never parses Data itself (only entries() does), so an empty body is fine.
	const fetch: EntryBundleFetcherFunc = (i: bigint): Promise<Uint8Array> => {
		dispatched.push(i);
		return new Promise<Uint8Array>((res, rej) => {
			resolvers.set(i.toString(), res);
			rejecters.set(i.toString(), rej);
		});
	};
	return {
		fetch,
		resolve: (i) => (resolvers.get(i.toString()) as (v: Uint8Array) => void)(new Uint8Array(0)),
		reject: (i, e) => (rejecters.get(i.toString()) as (e: unknown) => void)(e),
		dispatched,
	};
}

/** settle lets the event loop turn a few times so any pending microtask/macrotask work drains. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

it("yields bundles in strict index order even when later indices resolve before earlier ones", async () => {
	// Three full bundles (width 256 each), all three dispatched at once by numWorkers=3.
	const treeSize = 3n * BigInt(EntryBundleWidth);
	const d = deferredFetcher();
	const size: TreeSizeFunc = async (): Promise<bigint> => treeSize;

	const yielded: bigint[] = [];
	const run = (async (): Promise<void> => {
		for await (const b of entryBundles(3, size, d.fetch, 0n, treeSize)) {
			yielded.push(b.rangeInfo.index);
		}
	})();

	await settle();
	expect(d.dispatched, "all three fetches should be in flight at once").toEqual([0n, 1n, 2n]);

	// Resolve the two *later* bundles first. Because index 0 is still parked and delivery
	// is strictly in dispatch order, nothing may be yielded yet.
	d.resolve(2n);
	d.resolve(1n);
	await settle();
	expect(yielded, "must not yield out of order while index 0 is still pending").toEqual([]);

	// Now release index 0; the whole stream drains, in order.
	d.resolve(0n);
	await run;
	expect(yielded).toEqual([0n, 1n, 2n]);
});

it("surfaces an ahead-fetch error in order and does not leak it as an unhandled rejection", async () => {
	const treeSize = 3n * BigInt(EntryBundleWidth);
	const d = deferredFetcher();
	const boom = new Error("ahead-boom");
	const size: TreeSizeFunc = async (): Promise<bigint> => treeSize;

	const yielded: bigint[] = [];
	let caught: unknown;
	const run = (async (): Promise<void> => {
		try {
			for await (const b of entryBundles(3, size, d.fetch, 0n, treeSize)) {
				yielded.push(b.rangeInfo.index);
			}
		} catch (e) {
			caught = e;
		}
	})();

	await settle();
	expect(d.dispatched).toEqual([0n, 1n, 2n]);

	// Index 1 (ahead in the window) fails while index 0 is still in flight. The error must
	// not surface yet -- it is behind index 0 in delivery order -- and, crucially, must not
	// be swallowed. (If entryBundles left this rejected promise unhandled, Vitest would
	// report an unhandled rejection and fail this file; that this test passes cleanly is
	// the regression guard for the pending.catch(() => {}) in entryBundles.)
	d.reject(1n, boom);
	await settle();
	expect(caught, "error must wait its turn behind index 0").toBeUndefined();
	expect(yielded).toEqual([]);

	// Release index 0: bundle 0 is yielded, then index 1's error surfaces, in order.
	d.resolve(0n);
	await run;
	expect(yielded).toEqual([0n]);
	expect(caught).toBe(boom);
});

describe("resuming after the log grows", () => {
	it("a fresh entryBundles call continues where the previous one left off", async () => {
		// Not part of upstream stream_test.go: this is the "resuming" scenario
		// TestEntryBundles' comments describe, adapted to how entryBundles actually
		// behaves -- see this file's header comment. log_1000 and log_5000 are
		// independently-built logs, but both are deterministic (entry i is always
		// "entry-<i>"), so log_5000's first 1000 entries are byte-identical to
		// log_1000's, making this a faithful stand-in for one log that grew.
		const getBundle1000 = buildBundleFetcher(log1000);
		const getBundle5000 = buildBundleFetcher(log5000);

		const seen = new Set<string>();
		let consumed = 0n;

		// First poll: the log currently has 1000 entries.
		for await (const e of entries(
			entryBundles(2, async () => 1000n, getBundle1000, 0n, 1000n),
			unbundle,
		)) {
			seen.add(fromUTF8(e.entry));
			consumed++;
		}
		expect(consumed).toBe(1000n);

		// The log has since grown to 5000 entries. A fresh call resumes from
		// wherever the caller left off.
		const logSize = u64(log5000.size);
		for await (const e of entries(
			entryBundles(2, async () => logSize, getBundle5000, consumed, logSize - consumed),
			unbundle,
		)) {
			seen.add(fromUTF8(e.entry));
			consumed++;
		}
		expect(consumed).toBe(logSize);

		const want = new Set<string>();
		for (let i = 0n; i < logSize; i++) {
			want.add(entryData(i));
		}
		expect(seen).toEqual(want);
	});
});

it("EntryBundle round-trips through toUTF8/fromUTF8 the way the fixture corpus expects", () => {
	// A narrow sanity check on this file's own entryData helper, pinning it against the
	// fixture's documented entryScheme ("entry i is the UTF-8 bytes of \"entry-<i>\"").
	expect(fromUTF8(toUTF8(entryData(41n)))).toBe("entry-41");
});
