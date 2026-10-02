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
// Tests for migrate_lifecycle.ts. There is no migrate_lifecycle_test.go upstream:
// migrate_lifecycle.go's coverage comes from Tessera's integration/ end-to-end suite,
// which needs a real storage Driver. See
// docs/decisions/0074-migrate-untestable-without-driver.md for exactly what that leaves
// untested here: `MigrationTarget.migrate`'s full copy+integrate+follower orchestration
// against a *real* MigrationWriter, and `newMigrationTarget`'s success path through a real
// driver's `migrationWriter` lifecycle method. This file is original to this project and
// covers what does not need one: `MigrationOptions`'s pure accessors, `progress()`'s
// formatting, `awaitFollower`'s follower-catch-up polling loop (driven by a minimal fake
// Follower -- an interface with three methods, not a storage driver), and
// `newMigrationTarget`'s driver-rejection path (which only needs a driver *without* a
// migrationWriter method to prove the type guard itself is correct -- not a working fake
// driver).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddFn } from "./append_lifecycle.ts";
import type { Follower } from "./lifecycle.ts";
import {
	awaitFollower,
	MigrationOptions,
	newMigrationOptions,
	newMigrationTarget,
	progress,
} from "./migrate_lifecycle.ts";

describe("progress", () => {
	const tests: { desc: string; n: string; p: bigint; total: bigint; want: string }[] = [
		{ desc: "typical progress", n: "copy", p: 12n, total: 26n, want: "copy: 12 (46.15%)" },
		{ desc: "zero progress", n: "integration", p: 0n, total: 100n, want: "integration: 0 (0.00%)" },
		{ desc: "complete", n: "copy", p: 100n, total: 100n, want: "copy: 100 (100.00%)" },
		{ desc: "rounds to two decimal places", n: "copy", p: 1n, total: 3n, want: "copy: 1 (33.33%)" },
		{
			desc: "total zero and p zero renders NaN%, matching Go's 0.0/0.0",
			n: "copy",
			p: 0n,
			total: 0n,
			want: "copy: 0 (NaN%)",
		},
		{
			desc: "total zero and p positive renders +Inf%, matching Go's %.2f on +Inf",
			n: "copy",
			p: 5n,
			total: 0n,
			want: "copy: 5 (+Inf%)",
		},
	];

	for (const test of tests) {
		it(test.desc, () => {
			expect(progress(test.n, test.p, test.total)).toBe(test.want);
		});
	}
});

/** fakeFollower builds a minimal Follower -- three methods, not a storage driver. */
function fakeFollower(entriesProcessed: () => Promise<bigint>): Follower {
	return {
		name: () => "fake",
		follow: () => {},
		entriesProcessed,
	};
}

describe("awaitFollower", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves once entriesProcessed reaches the target index", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const f = fakeFollower(async () => {
			calls++;
			return calls < 3 ? BigInt(calls) : 10n;
		});

		const controller = new AbortController();
		const done = awaitFollower(f, 10n, controller.signal)();
		await vi.advanceTimersByTimeAsync(10_000);
		await done;

		expect(calls).toBeGreaterThanOrEqual(3);
	});

	it("resolves immediately when entriesProcessed already meets the target (no sleep needed first)", async () => {
		vi.useFakeTimers();
		const f = fakeFollower(async () => 10n);

		const controller = new AbortController();
		const done = awaitFollower(f, 10n, controller.signal)();
		await vi.advanceTimersByTimeAsync(1_000);
		await done;
	});

	it("keeps polling past a transient entriesProcessed error instead of throwing", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const f = fakeFollower(async () => {
			calls++;
			if (calls === 1) {
				throw new Error("transient");
			}
			return 5n;
		});

		const controller = new AbortController();
		const done = awaitFollower(f, 5n, controller.signal)();
		await vi.advanceTimersByTimeAsync(10_000);
		await done;

		expect(calls).toBe(2);
	});

	it("returns without throwing once the signal aborts", async () => {
		vi.useFakeTimers();
		const f = fakeFollower(async () => 0n);

		const controller = new AbortController();
		const done = awaitFollower(f, 100n, controller.signal)();
		controller.abort();
		await vi.advanceTimersByTimeAsync(1);

		await expect(done).resolves.toBeUndefined();
	});
});

describe("MigrationOptions", () => {
	it("newMigrationOptions defaults to Tessera's own tlog-tiles layout and hashers", () => {
		const o = newMigrationOptions();
		// api/layout's own entriesPath/tile.ts is exhaustively covered elsewhere
		// (layout_paths.json, 2393 cases); this just confirms MigrationOptions wires the
		// same function in as its default, not a copy of it.
		expect(o.entriesPath()(0n, 0)).toBe("tile/entries/000");
		expect(typeof o.leafHasher()).toBe("function");
	});

	it("withAntispam appends a follower built from the configured bundleIDHasher, and returns the same options for chaining", () => {
		const o = new MigrationOptions();
		let gotHasher: ((bundle: Uint8Array) => Uint8Array[]) | undefined;
		const follower = fakeFollower(async () => 0n);
		const as = {
			decorator:
				() =>
				(fn: AddFn): AddFn =>
					fn,
			follower: (idHasher: (bundle: Uint8Array) => Uint8Array[]): Follower => {
				gotHasher = idHasher;
				return follower;
			},
		};

		const returned = o.withAntispam(as);

		expect(returned).toBe(o);
		expect(o.internal.followers).toEqual([follower]);
		expect(gotHasher).toBe(o.internal.bundleIDHasher);
	});

	it("withAntispam(undefined) is a no-op, mirroring Go's `if as != nil`", () => {
		const o = new MigrationOptions();
		o.withAntispam(undefined);
		expect(o.internal.followers).toEqual([]);
	});
});

describe("newMigrationTarget", () => {
	it("rejects a driver that does not implement the MigrationTarget lifecycle", async () => {
		// Not a working fake driver -- just a plain object without a migrationWriter
		// method, which is all the `d.(migrateLifecycle)` type-guard rejection path
		// needs to prove itself correct. See this file's header comment and
		// docs/decisions/0074-migrate-untestable-without-driver.md for why the success
		// path (a real driver's migrationWriter lifecycle method) is not tested here.
		const notADriver = {};
		await expect(newMigrationTarget(notADriver, newMigrationOptions())).rejects.toThrow(
			"does not implement MigrationTarget lifecycle",
		);
	});
});
