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
// TestEntryBundles and TestEntries are ported as upstream has them, on a live
// testonly.newTestLog. Every case after them is a port addition, driven instead by the
// log_1000 and log_5000 fixtures (fixtures/gen/log.go): real logs built by the Tessera POSIX
// driver, served by an in-test EntryBundleFetcherFunc.

import { beforeAll, describe, expect, it } from "vitest";
import { EntryBundleWidth, entriesPath } from "../api/layout/index.ts";
import { EntryBundle } from "../api/state.ts";
import { type IndexFuture, newAppendOptions } from "../append_lifecycle.ts";
import { newPublicationAwaiter } from "../await.ts";
import { newEntry } from "../entry.ts";
import { partialOrFullResource } from "../internal/fetcher/fallback.ts";
import { fromUTF8, toUTF8 } from "../internal/gostd/bytes.ts";
import { ErrNotExist } from "../internal/gostd/errors.ts";
import { sleep } from "../internal/gostd/sync.ts";
import { type Fixture, hexToBytes, loadFixture, u64 } from "../testonly/fixtures.ts";
import { newTestLog, type TestLog } from "../testonly/testlog.ts";
import type { EntryBundleFetcherFunc } from "./client.ts";
import { type Bundle, entries, entryBundles, type TreeSizeFunc } from "./stream.ts";

// Port note: TestEntryBundles appends 100045 entries through the full append lifecycle,
// waits for each to be published, then streams them back, sleeping a second on the way.
// It takes about 6.5s in Go and about 6s here on an idle machine, so it gets an explicit
// timeout with headroom for a contended CI runner rather than the suite's 20s default —
// the precedent integrate_test.ts sets for TestIntegrate.
const entryBundlesTimeoutMs = 60_000;

it(
	"TestEntryBundles",
	async () => {
		const ac = new AbortController();

		const logSize1 = 12345n;
		const logSize2 = 100045n;

		const { testLog: tl, shutdown } = await newTestLog(
			newAppendOptions().withBatching(30000, 1000).withCheckpointInterval(1000),
			ac.signal,
		);
		try {
			await populateEntries(tl, logSize1, "first", ac.signal);
			await populateEntries(tl, logSize2 - logSize1, "second", ac.signal);

			let logSize = logSize1;
			const size: TreeSizeFunc = async (): Promise<bigint> => logSize;

			// Finally, try to stream all the bundles back.
			// We'll first try to stream up to logSize1, then when we reach it we'll
			// make the tree appear to grow to logSize2 to test resuming.
			//
			// Port note: as in Go, entryBundles asks for the tree size once, before it
			// starts, so growing it here does not extend a stream already running: this
			// stream, like upstream's, ends at logSize1. Upstream asserts only the order of
			// what it sees, and so does this.
			let seenEntries = 0n;

			const readEntryBundle: EntryBundleFetcherFunc = (i, p, s) => tl.logReader.readEntryBundle(i, p, s);
			for await (const gotEntry of entryBundles(2, size, readEntryBundle, 0n, logSize2, ac.signal)) {
				const e = gotEntry.rangeInfo.index * BigInt(EntryBundleWidth) + BigInt(gotEntry.rangeInfo.first);
				expect(e, `got idx ${e}, want ${seenEntries}`).toBe(seenEntries);
				seenEntries += BigInt(gotEntry.rangeInfo.n);

				switch (seenEntries) {
					case logSize1:
						// We've fetched all the entries from the original tree size, now we'll make
						// the tree appear to have grown to the final size.
						// The stream should start returning bundles again until we've consumed them all.
						logSize = logSize2;
						await sleep(1000);
				}
			}
		} finally {
			await shutdown();
			ac.abort();
		}
	},
	entryBundlesTimeoutMs,
);

it("TestEntries", async () => {
	const ac = new AbortController();

	const logSize = 1234n;

	const { testLog: tl, shutdown } = await newTestLog(
		newAppendOptions().withBatching(Number(logSize), 1000).withCheckpointInterval(1000),
		ac.signal,
	);
	try {
		// Put some entries into a log.
		const es = await populateEntries(tl, logSize, "first", ac.signal);
		const wantEntries = new Set<string>();
		for (const e of es) {
			wantEntries.add(fromUTF8(e));
		}

		const unbundle = (bundle: Uint8Array): Uint8Array[] => {
			const eb = new EntryBundle();
			eb.unmarshalText(bundle);
			return eb.entries;
		};

		// Now stream back entries and check that we saw all the entries we added above.
		//
		// Port note: Go consumes the stream on a goroutine and hands each entry over a
		// channel; a single async loop does the same here.
		const size: TreeSizeFunc = async (): Promise<bigint> => logSize;
		const readEntryBundle: EntryBundleFetcherFunc = (i, p, s) => tl.logReader.readEntryBundle(i, p, s);
		for await (const gotEntry of entries(entryBundles(2, size, readEntryBundle, 0n, logSize, ac.signal), unbundle)) {
			const k = fromUTF8(gotEntry.entry);
			expect(wantEntries.has(k), `Expected missing entry ${JSON.stringify(k)} - already seen?`).toBe(true);
			wantEntries.delete(k);
		}

		expect(wantEntries.size, `Did not see ${wantEntries.size} expected entries`).toBe(0);
	} finally {
		await shutdown();
		ac.abort();
	}
});

/**
 * populateEntries adds N entries `<ep>-<i>` to tl and waits until all of them are
 * published, returning their data.
 */
async function populateEntries(tl: TestLog, N: bigint, ep: string, signal: AbortSignal): Promise<Uint8Array[]> {
	const es: Uint8Array[] = [];
	const fs: IndexFuture[] = [];
	for (let i = 0n; i < N; i++) {
		const e = toUTF8(`${ep}-${i}`);
		es.push(e);
		fs.push(tl.appender.add(newEntry(e), signal));
	}

	const a = newPublicationAwaiter((s) => tl.logReader.readCheckpoint(s), 1000, signal);
	for (const f of fs) {
		await a.await(f, signal);
	}
	return es;
}

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

// Port additions below this line.

it("port addition: entries() yields every entry of the log_1000 fixture exactly once", async () => {
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

it("port addition: entryBundles() covers the log_5000 fixture in order", async () => {
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

it("port addition: bounds concurrent fetches to numWorkers", async () => {
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

it("port addition: propagates a getBundle error and stops the stream", async () => {
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

it("port addition: yields bundles in strict index order even when later indices resolve before earlier ones", async () => {
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

it("port addition: surfaces an ahead-fetch error in order and does not leak it as an unhandled rejection", async () => {
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

describe("port addition: resuming after the log grows", () => {
	it("a fresh entryBundles call continues where the previous one left off", async () => {
		// The "resuming" scenario TestEntryBundles' comments describe, the way real callers
		// achieve it: a single entryBundles call reads the tree size once (see the Port
		// note in TestEntryBundles), so resuming means calling it again. log_1000 and log_5000 are
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

it("port addition: entryData matches the fixture corpus' entry scheme", () => {
	// A narrow sanity check on this file's own entryData helper, pinning it against the
	// fixture's documented entryScheme ("entry i is the UTF-8 bytes of \"entry-<i>\"").
	expect(fromUTF8(toUTF8(entryData(41n)))).toBe("entry-41");
});

describe("port addition: numWorkers below 1", () => {
	// Go's numWorkers is a uint: a value it cannot hold is refused when entryBundles is
	// called (docs/decisions/0192).
	for (const numWorkers of [-1, 1.5, Number.NaN]) {
		it(`throws a RangeError for numWorkers=${numWorkers}`, () => {
			const size: TreeSizeFunc = async (): Promise<bigint> => 600n;
			const getBundle: EntryBundleFetcherFunc = async (): Promise<Uint8Array> => new Uint8Array(0);
			expect(() => entryBundles(numWorkers, size, getBundle, 0n, 600n)).toThrow(
				new RangeError(`numWorkers must be an integer of at least 1, got ${numWorkers}`),
			);
		});
	}

	// With numWorkers == 0, Go's EntryBundles blocks forever once there is a bundle to fetch,
	// since its token bucket never holds a token; otherwise it terminates normally. Each case
	// was run against client.EntryBundles at the pinned commit (Go 1.24.7 and 1.25.5) with a
	// 2s limit: the four empty ranges returned after no yields, the failing getSize yielded
	// its error and returned, and the two non-empty ranges hung. No case called getBundle.
	const zeroWorkers: { name: string; size: bigint | Error; from: bigint; n: bigint; want: string }[] = [
		{ name: "empty tree", size: 0n, from: 0n, n: 600n, want: "done" },
		{ name: "N=0", size: 600n, from: 0n, n: 0n, want: "done" },
		{ name: "from at size", size: 600n, from: 600n, n: 10n, want: "done" },
		{ name: "from beyond size", size: 600n, from: 700n, n: 10n, want: "done" },
		{ name: "getSize fails", size: new Error("size boom"), from: 0n, n: 600n, want: "size boom" },
		{ name: "non-empty", size: 600n, from: 0n, n: 600n, want: "numWorkers must be an integer of at least 1, got 0" },
		{
			name: "non-empty one entry",
			size: 1n,
			from: 0n,
			n: 1n,
			want: "numWorkers must be an integer of at least 1, got 0",
		},
	];
	for (const tc of zeroWorkers) {
		it(`numWorkers=0, ${tc.name}`, async () => {
			const size: TreeSizeFunc = async (): Promise<bigint> => {
				if (tc.size instanceof Error) {
					throw tc.size;
				}
				return tc.size;
			};
			let fetches = 0;
			const getBundle: EntryBundleFetcherFunc = async (): Promise<Uint8Array> => {
				fetches++;
				return new Uint8Array(0);
			};
			const g = entryBundles(0, size, getBundle, tc.from, tc.n);
			let got = "done";
			try {
				for await (const _ of g) {
					got = "yielded a bundle";
				}
			} catch (err) {
				got = (err as Error).message;
				if (tc.want.startsWith("numWorkers")) {
					expect(err).toBeInstanceOf(RangeError);
				}
			}
			expect(got).toBe(tc.want);
			expect(fetches).toBe(0);
		});
	}
});

it("port addition: nothing is fetched before the first next(), where Go's producer starts at once", async () => {
	// At the pinned commit, EntryBundles(ctx, 2, ...) made 3 calls (getSize and two
	// getBundle) within 200ms without ever being iterated (docs/decisions/0066).
	let started = 0;
	const g = entryBundles(
		2,
		async () => {
			started++;
			return 600n;
		},
		async () => {
			started++;
			return new Uint8Array(0);
		},
		0n,
		600n,
	);
	await settle();
	expect(started).toBe(0);
	// getSize, two fetches, and a third that refills the window once the first has settled.
	await g.next();
	expect(started).toBe(4);
});

describe("port addition: uint64 wraparound, as Go computes it", () => {
	it("entryBundles: fromEntry+N wraps", async () => {
		// Go: EntryBundles(ctx, 1, size=600, ..., 10, MaxUint64-5) yields one bundle,
		// {Index:0 Partial:0 First:10 N:4}.
		const got: Bundle[] = [];
		for await (const b of entryBundles(
			1,
			async () => 600n,
			async () => new Uint8Array(0),
			10n,
			0xffffffffffffffffn - 5n,
		)) {
			got.push(b);
		}
		expect(got.map((b) => b.rangeInfo)).toEqual([{ index: 0n, partial: 0, first: 10, n: 4 }]);
	});

	it("entries: the entry index wraps", async () => {
		// Go: a bundle with RangeInfo{Index: 1<<56 + 1, First: 3, N: 2} yields indices 259 and 260.
		async function* one(): AsyncGenerator<Bundle> {
			yield { rangeInfo: { index: (1n << 56n) + 1n, partial: 0, first: 3, n: 2 }, data: new Uint8Array(0) };
		}
		const got: bigint[] = [];
		for await (const e of entries(one(), () => [0, 1, 2, 3, 4, 5])) {
			got.push(e.index);
		}
		expect(got).toEqual([259n, 260n]);
	});
});

it("port addition: entries() rejects a bundle with fewer entries than its range needs", async () => {
	// Go yields only the entries the bundle holds, silently dropping the rest of the range
	// (docs/decisions/0194).
	async function* short(): AsyncGenerator<Bundle> {
		yield { rangeInfo: { index: 4n, partial: 0, first: 1, n: 5 }, data: new Uint8Array(0) };
	}
	const got: number[] = [];
	await expect(async () => {
		for await (const e of entries(short(), () => [0, 1, 2, 3])) {
			got.push(e.entry);
		}
	}).rejects.toThrow("bundle 4 has 4 entries, but the range needs 6");
	expect(got).toEqual([]);
});
