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
// Tests for migrate.ts. There is no migrate_test.go upstream: migrate.go's coverage comes
// from Tessera's integration/ end-to-end suite, which needs a real storage Driver (see
// docs/decisions/0074-migrate-untestable-without-driver.md). This file is original to this
// project and covers exactly the logic reachable without one: populateWork's chunking
// arithmetic (an off-by-one there would duplicate or skip entries during a real
// migration) and Copier.copy's worker orchestration against in-memory fakes standing in
// for EntryBundleFetcherFunc/setEntryBundleFunc.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntryBundleFetcherFunc } from "./client/index.ts";
import { type Bundle, type Copier, newCopier, populateWork } from "./migrate.ts";

describe("populateWork", () => {
	// TileWidth/EntryBundleWidth is 256; these cases are hand-computed against
	// api/layout/paths.ts's `range`, which populateWork wraps -- see that function's own
	// exhaustive fixture coverage (layout_range.json, 27 cases) for range() itself. What
	// is new here is populateWork's own mapping from range()'s from/N call to
	// {index, partial} bundle addresses, and its boundary at a real tile width (256).
	const tests: { desc: string; from: bigint; treeSize: bigint; want: Bundle[] }[] = [
		{ desc: "empty: from == treeSize == 0", from: 0n, treeSize: 0n, want: [] },
		{ desc: "empty: from == treeSize, non-zero", from: 10n, treeSize: 10n, want: [] },
		{ desc: "single partial bundle below one tile", from: 0n, treeSize: 1n, want: [{ index: 0n, partial: 1 }] },
		{ desc: "exactly one full bundle", from: 0n, treeSize: 256n, want: [{ index: 0n, partial: 0 }] },
		{
			desc: "one full bundle plus one partial",
			from: 0n,
			treeSize: 257n,
			want: [
				{ index: 0n, partial: 0 },
				{ index: 1n, partial: 1 },
			],
		},
		{
			desc: "two full bundles plus one partial",
			from: 0n,
			treeSize: 513n,
			want: [
				{ index: 0n, partial: 0 },
				{ index: 1n, partial: 0 },
				{ index: 2n, partial: 1 },
			],
		},
		{
			desc: "resuming from a full-tile boundary skips the already-copied bundle",
			from: 256n,
			treeSize: 513n,
			want: [
				{ index: 1n, partial: 0 },
				{ index: 2n, partial: 1 },
			],
		},
		{
			desc: "resuming partway through a bundle still yields that whole bundle",
			from: 100n,
			treeSize: 200n,
			want: [{ index: 0n, partial: 200 }],
		},
	];

	for (const test of tests) {
		it(test.desc, () => {
			const got = [...populateWork(test.from, test.treeSize)];
			expect(got).toEqual(test.want);
		});
	}
});

describe("Copier.copy", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("throws when fromSize > sourceSize, without touching the fetcher", async () => {
		let called = false;
		const c = newCopier(
			1,
			async () => {},
			async () => {
				called = true;
				return new Uint8Array(0);
			},
		);
		await expect(c.copy(5n, 3n)).rejects.toThrow("from size 5 > source size 3");
		expect(called).toBe(false);
	});

	it("copies every bundle in [from, sourceSize) exactly once across multiple concurrent workers", async () => {
		const stored = new Map<string, { partial: number; data: Uint8Array }>();
		const getEntryBundle: EntryBundleFetcherFunc = async (index, partial): Promise<Uint8Array> =>
			new Uint8Array([Number(index % 256n), partial]);
		const setEntryBundle = async (index: bigint, partial: number, bundle: Uint8Array): Promise<void> => {
			// A Map keyed by index catches any worker double-processing an item: a
			// duplicate `set` on the same key would silently overwrite rather than
			// grow the map, so asserting `stored.size === want.length` below is what
			// actually catches it.
			stored.set(String(index), { partial, data: bundle });
		};
		const c = newCopier(4, setEntryBundle, getEntryBundle);
		await c.copy(0n, 1000n);

		const want = [...populateWork(0n, 1000n)];
		expect(stored.size).toBe(want.length);
		for (const b of want) {
			const got = stored.get(String(b.index));
			expect(got?.partial).toBe(b.partial);
			expect(got?.data).toEqual(new Uint8Array([Number(b.index % 256n), b.partial]));
		}
		expect(c.bundlesCopied()).toBe(BigInt(want.length));
	});

	it("seeds bundlesCopied from _bundlesCopied, mirroring migrate_lifecycle.ts's resumption via .Store()", async () => {
		const c: Copier = newCopier(
			2,
			async () => {},
			async () => new Uint8Array(0),
		);
		c._bundlesCopied = 3n;
		await c.copy(0n, 512n); // Two full bundles (indices 0 and 1).
		expect(c.bundlesCopied()).toBe(5n);
	});

	it("retries a failing fetch with backoff and eventually succeeds", async () => {
		vi.useFakeTimers();

		let attempts = 0;
		const getEntryBundle: EntryBundleFetcherFunc = async (): Promise<Uint8Array> => {
			attempts++;
			if (attempts < 3) {
				throw new Error("transient fetch failure");
			}
			return new Uint8Array([1, 2, 3]);
		};
		let stored: Uint8Array | undefined;
		const setEntryBundle = async (_index: bigint, _partial: number, bundle: Uint8Array): Promise<void> => {
			stored = bundle;
		};

		const c = newCopier(1, setEntryBundle, getEntryBundle);
		const done = c.copy(0n, 1n);
		await vi.advanceTimersByTimeAsync(10_000);
		await done;

		expect(attempts).toBe(3);
		expect(stored).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("propagates the final error, prefixed 'copy failed:', after exhausting all 10 retries", async () => {
		vi.useFakeTimers();

		let attempts = 0;
		const getEntryBundle: EntryBundleFetcherFunc = async (): Promise<Uint8Array> => {
			attempts++;
			throw new Error("permanently broken");
		};

		const c = newCopier(1, async () => {}, getEntryBundle);
		const done = c.copy(0n, 1n);
		const assertion = expect(done).rejects.toThrow("copy failed");
		await vi.advanceTimersByTimeAsync(120_000);
		await assertion;

		expect(attempts).toBe(10);
	});
});
