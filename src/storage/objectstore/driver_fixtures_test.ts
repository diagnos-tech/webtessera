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
// Golden-fixture coverage for driver.ts: the compatibility proof for the whole driver. See
// the header of api/layout/paths_fixtures_test.ts for why these live outside the
// Go-mirrored test file.
//
// fixtures/data/log_<N>.json is a complete log built by the real Tessera POSIX driver
// (fixtures/gen/log.go): every tile, every entry bundle and the signed checkpoint, read back
// off disk. storage/internal/integrate_fixtures_test.ts already shows that the tree-building
// engine computes the same tiles. These tests go further and run the same appends through
// the public newAppender API and this driver, over a MemoryObjectStore, and then compare the
// store with the directory Go left behind: the same set of paths, the same bytes at each,
// and the same checkpoint. The fixture's signing key is a published test key
// (fixtures/gen/note.go), and Ed25519 signatures are deterministic, so even the signed
// checkpoint must match byte for byte.

import { describe, expect, it } from "vitest";
import { CheckpointPath, tilePath } from "../../api/layout/index.ts";
import { type AppendOptions, newAppender, newAppendOptions } from "../../append_lifecycle.ts";
import { newPublicationAwaiter } from "../../await.ts";
import { newEntry } from "../../entry.ts";
import { bytesEqual, fromUTF8, toBase64, toUTF8 } from "../../internal/gostd/bytes.ts";
import { hexToBytes, loadFixture } from "../../testonly/fixtures.ts";
import { newSigner } from "../../vendor/note/note.ts";
import { MemoryObjectStore } from "../memory/memory.ts";
import { newObjectStoreDriver, type ObjectStoreDriver } from "./driver.ts";

interface LogFixture {
	readonly size: string;
	readonly checkpoint: string;
	readonly checkpointHash: string;
	readonly tiles: readonly { readonly path: string; readonly raw: string }[];
	readonly entryBundles: readonly { readonly path: string; readonly raw: string }[];
}

/** logSKey is fixtures/gen/note.go's logSKey, the key every log_<N> checkpoint is signed with. */
const logSKey = "PRIVATE+KEY+webtessera.fixture.log+dc00151b+AcwDSjtCWhsc7xNHRYufTeqK6/OA73GaH/GCwyT1xsvP";

const sizes = [0, 1, 2, 255, 256, 257, 1000, 5000];

/** entryData reproduces fixtures/gen/log.go's entry scheme: entry i is the UTF-8 bytes of "entry-<i>". */
function entryData(i: number): Uint8Array {
	return toUTF8(`entry-${i}`);
}

/** resources returns a fixture's public resources, the checkpoint included, keyed by path. */
function resources(fx: LogFixture): Map<string, Uint8Array> {
	const m = new Map<string, Uint8Array>();
	for (const r of [...fx.tiles, ...fx.entryBundles]) {
		m.set(r.path, hexToBytes(r.raw));
	}
	m.set(CheckpointPath, hexToBytes(fx.checkpoint));
	return m;
}

/** publicKeys returns every key in store outside the driver's private .state/ prefix. */
function publicKeys(store: MemoryObjectStore): string[] {
	return store.keys().filter((k) => !k.startsWith(".state/"));
}

/** goTreeState is the .state/treeState file Go's encoding/json writes for a log of the fixture's size. */
function goTreeState(fx: LogFixture): string {
	return `{"size":${fx.size},"root":"${toBase64(hexToBytes(fx.checkpointHash))}"}`;
}

/**
 * fixtureOptions mirrors fixtures/gen/log.go's runLog options, with the batch size left to
 * the caller: checkpoint republication and garbage collection disabled, the minimum
 * checkpoint interval.
 */
function fixtureOptions(batchSize: number, batchMaxAgeMs: number): AppendOptions {
	return newAppendOptions()
		.withCheckpointSigner(newSigner(logSKey))
		.withBatching(batchSize, batchMaxAgeMs)
		.withCheckpointInterval(100)
		.withCheckpointRepublishInterval(0)
		.withGarbageCollectionInterval(0);
}

/**
 * appendEntries appends entries [from, to) in order and waits for a checkpoint covering them.
 *
 * It waits with a PublicationAwaiter, as fixtures/gen/log.go does, rather than relying on
 * shutdown alone: shutdown treats an appender whose largest issued index is 0 as having done
 * no work (append_lifecycle.go's "special case no work done"), so it would return before a
 * one-entry log's first checkpoint is published.
 */
async function appendEntries(driver: ObjectStoreDriver, opts: AppendOptions, from: number, to: number): Promise<void> {
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
			expect(idx.index, `entry ${from + i}`).toBe(BigInt(from + i));
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
}

/**
 * partialKeysAt returns the keys of the partial resources on the right-hand edge of a tree of
 * the given size: the ones a batch ending at that size writes.
 */
function partialKeysAt(size: bigint, entriesPath: (n: bigint, p: number) => string): string[] {
	const r: string[] = [];
	for (let l = 0n, c = size; c > 0n; l++, c >>= 8n) {
		const idx = c / 256n;
		const p = Number(c % 256n);
		if (p !== 0) {
			if (l === 0n) {
				r.push(entriesPath(idx, p));
			}
			r.push(tilePath(l, idx, p));
		}
	}
	return r;
}

/**
 * expectedKeys returns the public keys a store must hold once a log has grown through the
 * given batch end sizes (the size the log started from included) to the fixture's size: the
 * fixture's resources, plus every superseded partial version those batches wrote. After a GC
 * at the final size only the superseded partials in a partial directory of the final tree
 * survive; garbageCollect, like posix's, removes the `.p/` directories of full resources only.
 */
function expectedKeys(fx: LogFixture, batchEnds: readonly bigint[], afterGC: boolean): string[] {
	const entriesPath = newAppendOptions().entriesPath();
	const size = BigInt(fx.size);
	const keep = new Set(partialKeysAt(size, entriesPath).map((k) => k.slice(0, k.lastIndexOf("/") + 1)));
	const keys = new Set(resources(fx).keys());
	for (const end of batchEnds) {
		for (const k of partialKeysAt(end, entriesPath)) {
			if (!afterGC || keep.has(k.slice(0, k.lastIndexOf("/") + 1))) {
				keys.add(k);
			}
		}
	}
	return [...keys].sort();
}

/** batchEndsOf returns the sizes at which batches of batchSize end when growing a log from `from` to `to`. */
function batchEndsOf(from: number, to: number, batchSize: number): bigint[] {
	const ends: bigint[] = [BigInt(from)];
	for (let s = from + batchSize; s < to; s += batchSize) {
		ends.push(BigInt(s));
	}
	ends.push(BigInt(to));
	return ends;
}

/** expectResources asserts that store holds every one of want's resources, byte for byte. */
async function expectResources(store: MemoryObjectStore, want: Map<string, Uint8Array>): Promise<void> {
	for (const [path, raw] of want) {
		const got = await store.get(path);
		expect(got, `missing ${path}`).toBeDefined();
		expect(bytesEqual(got as Uint8Array, raw), `${path} differs`).toBe(true);
	}
}

/** expectExactly asserts that store's public resources are exactly want's, byte for byte. */
async function expectExactly(store: MemoryObjectStore, want: Map<string, Uint8Array>): Promise<void> {
	expect(publicKeys(store)).toEqual([...want.keys()].sort());
	await expectResources(store, want);
}

describe("golden fixtures: log_<N> built by the driver", () => {
	for (const size of sizes) {
		it(`log_${size}: a single batch leaves exactly the resources Go's POSIX driver left`, async () => {
			const fx = await loadFixture<LogFixture>(`log_${size}`);
			const store = new MemoryObjectStore();
			const driver = newObjectStoreDriver({ store });

			// As in runLog: one batch holding every entry, which only filling up can flush.
			await appendEntries(driver, fixtureOptions(Math.max(size, 1), 3_600_000), 0, size);

			await expectExactly(store, resources(fx));
			expect(fromUTF8((await store.get(".state/treeState")) as Uint8Array)).toBe(goTreeState(fx));
			expect(fromUTF8((await store.get(".state/version")) as Uint8Array)).toBe("1");
		});
	}

	for (const size of [257, 1000, 5000]) {
		it(`log_${size}: many small batches converge on the same resources once garbage collected`, async () => {
			const fx = await loadFixture<LogFixture>(`log_${size}`);
			const want = resources(fx);
			const store = new MemoryObjectStore();
			const driver = newObjectStoreDriver({ store });
			const opts = fixtureOptions(37, 5);

			await appendEntries(driver, opts, 0, size);

			// Every resource the final size implies is identical; everything else is a superseded
			// partial version, which posix too leaves behind (as a symlink, for tiles) until GC.
			await expectResources(store, want);
			const ends = batchEndsOf(0, size, 37);
			expect(publicKeys(store)).toEqual(expectedKeys(fx, ends, false));

			await driver.garbageCollect(BigInt(size), 1000, opts.entriesPath());
			expect(publicKeys(store)).toEqual(expectedKeys(fx, ends, true));
			await expectResources(store, want);
		});
	}
});

describe("golden fixtures: resuming a log written by Go's POSIX driver", () => {
	const crossings: readonly [number, number][] = [
		[0, 1],
		[255, 257],
		[256, 257],
		[1000, 5000],
	];
	for (const [from, to] of crossings) {
		it(`log_${from} + entries [${from}, ${to}) == log_${to}`, async () => {
			const fromFx = await loadFixture<LogFixture>(`log_${from}`);
			const toFx = await loadFixture<LogFixture>(`log_${to}`);

			// Lay the Go log out in the store exactly as it sits on disk, private state included.
			const store = new MemoryObjectStore();
			for (const [path, raw] of resources(fromFx)) {
				await store.put(path, raw);
			}
			await store.put(".state/treeState", toUTF8(goTreeState(fromFx)));
			await store.put(".state/version", toUTF8("1"));

			const driver = newObjectStoreDriver({ store });
			const opts = fixtureOptions(to - from, 3_600_000);
			await appendEntries(driver, opts, from, to);

			const ends = batchEndsOf(from, to, to - from);
			await expectResources(store, resources(toFx));
			expect(publicKeys(store)).toEqual(expectedKeys(toFx, ends, false));
			await driver.garbageCollect(BigInt(to), 1000, opts.entriesPath());
			expect(publicKeys(store)).toEqual(expectedKeys(toFx, ends, true));
			await expectResources(store, resources(toFx));
			expect(fromUTF8((await store.get(".state/treeState")) as Uint8Array)).toBe(goTreeState(toFx));
		});
	}
});
