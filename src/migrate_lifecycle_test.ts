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
// Tests for migrate_lifecycle.ts. There is no migrate_lifecycle_test.go upstream:
// migrate_lifecycle.go's coverage comes from Tessera's integration/ end-to-end suite,
// which needs a real storage Driver. See
// docs/decisions/0074-migrate-untestable-without-driver.md for exactly what that leaves
// untested here: `MigrationTarget.migrate`'s full copy+integrate+follower orchestration
// against a *real* MigrationWriter (docs/decisions/0105-migration-tested-end-to-end-closes-adr-0074.md
// covers that against the real drivers). This file is original to this project and covers what
// does not need one: `MigrationOptions`'s pure accessors, `awaitFollower`'s follower-catch-up
// polling loop (driven by a minimal fake Follower -- an interface with three methods, not a
// storage driver), `newMigrationTarget`'s driver-rejection path, and how `newMigrationTarget`
// and `migrate` treat followers, driven by a stub MigrationWriter that copies nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddFn } from "./append_lifecycle.ts";
import type { MigrationWriter } from "./internal/migrate/migrate.ts";
import type { Follower, LogReader } from "./lifecycle.ts";
import { awaitFollower, MigrationOptions, newMigrationOptions, newMigrationTarget } from "./migrate_lifecycle.ts";

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

	it("resolves after its first one-second sleep when entriesProcessed already meets the target", async () => {
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

	it("withAntispam(null) is a no-op too, as Go's nil interface is", () => {
		const o = new MigrationOptions();
		o.withAntispam(null);
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

describe("MigrationTarget followers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const root = new Uint8Array(32).fill(9);

	/** stubDriver migrates an empty log: nothing to copy, and integration is already done. */
	function stubDriver(): {
		migrationWriter(): Promise<{ writer: MigrationWriter; reader: LogReader }>;
	} {
		const writer: MigrationWriter = {
			setEntryBundle: async (): Promise<void> => {},
			awaitIntegration: async (): Promise<Uint8Array> => root,
			integratedSize: async (): Promise<bigint> => 0n,
		};
		const reader: LogReader = {
			readCheckpoint: async (): Promise<Uint8Array> => new Uint8Array(0),
			readTile: async (): Promise<Uint8Array> => new Uint8Array(0),
			readEntryBundle: async (): Promise<Uint8Array> => new Uint8Array(0),
			nextIndex: async (): Promise<bigint> => 0n,
			integratedSize: async (): Promise<bigint> => 0n,
		};
		return { migrationWriter: async () => ({ writer, reader }) };
	}

	function antispamWith(f: Follower): { decorator: () => (fn: AddFn) => AddFn; follower: () => Follower } {
		return {
			decorator:
				() =>
				(fn: AddFn): AddFn =>
					fn,
			follower: (): Follower => f,
		};
	}

	it("runs only the followers configured before newMigrationTarget, each as a detached task", async () => {
		vi.useFakeTimers();
		const started: string[] = [];
		const follower = (name: string): Follower => ({
			name: () => name,
			follow: (): Promise<void> => {
				started.push(name);
				// Never settles: migrate must not wait for it, only for awaitFollower.
				return new Promise<void>(() => {});
			},
			entriesProcessed: async (): Promise<bigint> => 0n,
		});
		const opts = newMigrationOptions().withAntispam(antispamWith(follower("before")));
		const mt = await newMigrationTarget(stubDriver(), opts);
		opts.withAntispam(antispamWith(follower("after")));

		const done = mt.migrate(1, 0n, root, async () => new Uint8Array(0));
		await vi.advanceTimersByTimeAsync(1_000);
		await done;

		expect(started).toEqual(["before"]);
	});
});
