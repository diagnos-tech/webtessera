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
// End-to-end tests of the migration lifecycle (migrate.ts, migrate_lifecycle.ts) with this
// driver as the MigrationTarget. docs/decisions/0074-migrate-untestable-without-driver.md
// left exactly these paths untested for want of a driver: newMigrationTarget's success path,
// and MigrationTarget.migrate copying a real source log's bundles into a real driver that
// integrates them and checks the resulting root. See
// docs/decisions/0105-migration-tested-end-to-end-closes-adr-0074.md.
//
// The source logs are fixtures/data/log_<N>.json, written by the real Tessera POSIX
// driver, served to the copier straight from the fixture. Upstream has no test of the
// migration lifecycle at the pinned commit (its integration/ suite only appends to and
// verifies a live log), so these tests add coverage rather than port it.

import { describe, expect, it } from "vitest";
import { partialOrFullResource } from "../../internal/fetcher/fallback.ts";
import { bytesEqual, toHex } from "../../internal/gostd/bytes.ts";
import { ErrNotExist, errorIs, wrapError } from "../../internal/gostd/errors.ts";
import { newMigrationOptions, newMigrationTarget } from "../../migrate_lifecycle.ts";
import { hexToBytes, loadFixture } from "../../testonly/fixtures.ts";
import { MemoryObjectStore } from "../memory/memory.ts";
import { newObjectStoreDriver } from "./driver.ts";

interface LogFixture {
	readonly size: string;
	readonly checkpointHash: string;
	readonly tiles: readonly { readonly path: string; readonly raw: string }[];
	readonly entryBundles: readonly { readonly path: string; readonly raw: string }[];
}

/** source serves a fixture log's entry bundles the way an HTTP fetcher would serve the real log. */
function source(fx: LogFixture): (i: bigint, p: number, signal?: AbortSignal) => Promise<Uint8Array> {
	const bundles = new Map(fx.entryBundles.map((b) => [b.path, hexToBytes(b.raw)]));
	const entriesPath = newMigrationOptions().entriesPath();
	return (i, p, signal) =>
		partialOrFullResource(
			p,
			async (p: number) => {
				const b = bundles.get(entriesPath(i, p));
				if (b === undefined) {
					throw wrapError(`get ${entriesPath(i, p)}`, ErrNotExist);
				}
				return b;
			},
			signal,
		);
}

/** publicResources returns a store's resources outside the driver's private .state/ prefix. */
async function publicResources(store: MemoryObjectStore): Promise<Map<string, Uint8Array>> {
	const m = new Map<string, Uint8Array>();
	for (const k of store.keys()) {
		if (!k.startsWith(".state/")) {
			m.set(k, (await store.get(k)) as Uint8Array);
		}
	}
	return m;
}

/** fixtureResources returns a fixture's tiles and bundles keyed by path; a migration target publishes no checkpoint. */
function fixtureResources(fx: LogFixture): Map<string, Uint8Array> {
	return new Map([...fx.tiles, ...fx.entryBundles].map((r) => [r.path, hexToBytes(r.raw)]));
}

function expectSameResources(got: Map<string, Uint8Array>, want: Map<string, Uint8Array>): void {
	expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
	for (const [k, v] of want) {
		expect(bytesEqual(got.get(k) as Uint8Array, v), `${k} differs`).toBe(true);
	}
}

async function migrate(store: MemoryObjectStore, fx: LogFixture, root?: Uint8Array): Promise<void> {
	const ac = new AbortController();
	try {
		const mt = await newMigrationTarget(newObjectStoreDriver({ store }), newMigrationOptions(), ac.signal);
		await mt.migrate(4, BigInt(fx.size), root ?? hexToBytes(fx.checkpointHash), source(fx), ac.signal);
	} finally {
		ac.abort();
	}
}

// Each migration waits at least a second (MigrationStorage.awaitIntegration polls once a
// second, as posix's does), so the cases run concurrently.
describe.concurrent("MigrationTarget with the ObjectStore driver", () => {
	for (const size of [0, 1, 257, 5000]) {
		it(`migrates log_${size} into an empty store, reproducing its tiles and bundles`, async () => {
			const fx = await loadFixture<LogFixture>(`log_${size}`);
			const store = new MemoryObjectStore();

			await migrate(store, fx);

			expectSameResources(await publicResources(store), fixtureResources(fx));
			const { writer } = await newObjectStoreDriver({ store }).migrationWriter(newMigrationOptions());
			expect(await writer.integratedSize()).toBe(BigInt(size));
		});
	}

	it("continues a migration from where the target's tree ends", async () => {
		const fx1000 = await loadFixture<LogFixture>("log_1000");
		const fx5000 = await loadFixture<LogFixture>("log_5000");
		const store = new MemoryObjectStore();

		await migrate(store, fx1000);
		const copied: string[] = [];
		const counting = source(fx5000);
		const ac = new AbortController();
		try {
			const mt = await newMigrationTarget(newObjectStoreDriver({ store }), newMigrationOptions(), ac.signal);
			await mt.migrate(
				4,
				5000n,
				hexToBytes(fx5000.checkpointHash),
				(i, p, s) => {
					copied.push(`${i}.${p}`);
					return counting(i, p, s);
				},
				ac.signal,
			);
		} finally {
			ac.abort();
		}

		// Only the bundles beyond the first three full ones were fetched again.
		expect(copied.sort()).toEqual(
			Array.from({ length: 16 }, (_, i) => `${i + 3}.0`)
				.concat(["19.136"])
				.sort(),
		);
		// The partials log_1000 implied stay behind, as they would in posix without GC.
		const want = fixtureResources(fx5000);
		for (const k of ["tile/entries/003.p/232", "tile/0/003.p/232", "tile/1/000.p/3"]) {
			want.set(k, fixtureResources(fx1000).get(k) as Uint8Array);
		}
		expectSameResources(await publicResources(store), want);
	});

	it("rejects a source whose root hash does not match the migrated tree", async () => {
		const fx = await loadFixture<LogFixture>("log_257");
		const wrong = new Uint8Array(32).fill(7);
		const err = await migrate(new MemoryObjectStore(), fx, wrong).catch((e: unknown) => e);
		expect((err as Error).message).toBe(
			`migration completed, but local root hash ${fx.checkpointHash} != source root hash ${toHex(wrong)}`,
		);
	});

	it("does not publish a checkpoint", async () => {
		const fx = await loadFixture<LogFixture>("log_2");
		const store = new MemoryObjectStore();
		await migrate(store, fx);
		const { reader } = await newObjectStoreDriver({ store }).migrationWriter(newMigrationOptions());
		const err = await reader.readCheckpoint().catch((e: unknown) => e);
		expect(errorIs(err, ErrNotExist)).toBe(true);
	});
});
