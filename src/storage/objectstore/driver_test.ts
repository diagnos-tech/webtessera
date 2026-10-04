// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/storage/posix/files_test.go @ 4a6d9f9
//
// Port note: the upstream cases run against a temporary directory; here they run against a
// MemoryObjectStore, the reference ObjectStore backend, and "partial directories" are the
// `.p` path segments of the stored keys. The cases after the ported ones cover driver
// behaviour files_test.go leaves to Tessera's integration suite.

import { describe, expect, it, vi } from "vitest";
import { CheckpointPath, partialTileSize, TileWidth, tilePath } from "../../api/layout/index.ts";
import { HashTile } from "../../api/state.ts";
import { newAppendOptions } from "../../append_lifecycle.ts";
import { newPublicationAwaiter } from "../../await.ts";
import { withCTLayout } from "../../ct_only.ts";
import { newEntry } from "../../entry.ts";
import { newFsck } from "../../fsck/fsck.ts";
import { fromUTF8, toBase64, toHex, toUTF8 } from "../../internal/gostd/bytes.ts";
import { ErrNotExist, errorIs } from "../../internal/gostd/errors.ts";
import { defaultMerkleLeafHasher } from "../../lifecycle.ts";
import { newMigrationOptions } from "../../migrate_lifecycle.ts";
import { parseCheckpoint } from "../../vendor/formats/log/index.ts";
import { DefaultHasher } from "../../vendor/merkle/rfc6962/rfc6962.ts";
import { generateKey, newSigner, newVerifier, type Signer, type Verifier } from "../../vendor/note/note.ts";
import { MemoryObjectStore, newMemoryDriver } from "../memory/memory.ts";
import {
	isLastLeafInParent,
	logResourceStorage,
	type MigrationStorage,
	newObjectStoreDriver,
	type ObjectStoreDriver,
} from "./driver.ts";

// minCheckpointInterval mirrors the unexported constant of the same name in driver.ts.
const minCheckpointInterval = 100;

describe("TestGarbageCollect", () => {
	it("TestGarbageCollect", { timeout: 120_000 }, async () => {
		const ac = new AbortController();
		const ctx = ac.signal;
		try {
			const batchSize = 60000n;
			const integrateEvery = 31343n;

			const store = new MemoryObjectStore();
			const s = newMemoryDriver({ store });
			const [sk, vk] = mustGenerateKeys();

			const opts = newAppendOptions()
				.withCheckpointInterval(1200)
				.withBatching(Number(batchSize), 100)
				// Disable GC so we can manually invoke below.
				.withGarbageCollectionInterval(0)
				.withCheckpointSigner(sk);
			const logStorage = new logResourceStorage(s, opts.entriesPath());
			const { appender, reader: lr } = await s.newAppender(logStorage, opts, ctx);
			await appender.publishCheckpoint(0, 0, ctx);

			// Build a reasonably-sized tree with a bunch of partial resouces present, and wait for
			// it to be published.
			const treeSize = 256n * 384n;

			const a = newPublicationAwaiter((sig) => lr.readCheckpoint(sig), 100, ctx);

			// grow and garbage collect the tree several times to check continued correct operation over lifetime of the log
			for (let size = 0n; size < treeSize; ) {
				for (let i = 0n; i < batchSize; i++) {
					const f = appender.add(newEntry(toUTF8(`entry ${size}`)), ctx);
					if (size % integrateEvery === 0n) {
						await a.await(f, ctx);
					}
					size++;
				}
				const last = size - 1n;
				await a.await(async () => ({ index: last, isDup: false }), ctx);

				await s.garbageCollect(size, 1000, appender.logStorage.entriesPath, ctx);

				// Compare any remaining partial resources to the list of places
				// we'd expect them to be, given the tree size.
				const wantPartialPrefixes = new Set(expectedPartialPrefixes(size, appender.logStorage.entriesPath));
				for (const k of findAllPartialDirs(store)) {
					expect(wantPartialPrefixes.has(k), `Found unwanted partial: ${k}`).toBe(true);
				}
			}

			// And finally, for good measure, assert that all the resources implied by the log's checkpoint
			// are present.
			const f = newFsck(vk.name(), vk, lr, defaultMerkleLeafHasher, { n: 1 });
			await f.check(ctx);
		} finally {
			ac.abort();
		}
	});
});

describe("TestGarbageCollectOption", () => {
	const batchSize = 60000n;
	const integrateEvery = 31343n;
	const garbageCollectionInterval = 100;

	const tests: { name: string; withCTLayout: boolean; withGarbageCollectionInterval: number }[] = [
		{ name: "on", withGarbageCollectionInterval: garbageCollectionInterval, withCTLayout: false },
		{ name: "on-ct", withGarbageCollectionInterval: garbageCollectionInterval, withCTLayout: true },
		{ name: "off", withGarbageCollectionInterval: 0, withCTLayout: false },
	];
	for (const test of tests) {
		it(test.name, { timeout: 120_000 }, async () => {
			const ac = new AbortController();
			const ctx = ac.signal;
			try {
				const store = new MemoryObjectStore();
				const s = newMemoryDriver({ store });
				const [sk, vk] = mustGenerateKeys();

				const opts = newAppendOptions()
					.withCheckpointInterval(1200)
					.withBatching(Number(batchSize), 100)
					.withGarbageCollectionInterval(test.withGarbageCollectionInterval)
					.withCheckpointSigner(sk);

				if (test.withCTLayout) {
					withCTLayout(opts);
				}

				const logStorage = new logResourceStorage(s, opts.entriesPath());
				const { appender, reader: lr } = await s.newAppender(logStorage, opts, ctx);
				await appender.publishCheckpoint(0, 0, ctx);

				// Build a reasonably-sized tree with a bunch of partial resouces present, and wait for
				// it to be published.
				const treeSize = 256n * 384n;

				const a = newPublicationAwaiter((sig) => lr.readCheckpoint(sig), 100, ctx);
				const wantPartialPrefixes = new Set<string>();

				// Grow the tree several times to check continued correct operation over lifetime of the log.
				// Let garbage collection happen in the background.
				for (let size = 0n; size < treeSize; ) {
					for (let i = 0n; i < batchSize; i++) {
						const f = appender.add(newEntry(toUTF8(`entry ${size}`)), ctx);
						if (size % integrateEvery === 0n) {
							await a.await(f, ctx);
							// If garbage collection is off, we want partial tiles and bundles to stick around.
							if (test.withGarbageCollectionInterval === 0) {
								for (const p of expectedPartialPrefixes(size, appender.logStorage.entriesPath)) {
									wantPartialPrefixes.add(p);
								}
							}
						}
						size++;
					}
					const last = size - 1n;
					await a.await(async () => ({ index: last, isDup: false }), ctx);

					// Leave a bit of time for Garbage Collection to run.
					await new Promise((r) => setTimeout(r, 3 * garbageCollectionInterval));

					// Compare any remaining partial resources to the list of places
					// we'd expect them to be, given the tree size.

					// Regardless of whether garbage collection is on, partial tiles corresponding to the last
					// checkpoint should alway be here.
					for (const p of expectedPartialPrefixes(size, appender.logStorage.entriesPath)) {
						wantPartialPrefixes.add(p);
					}
					const allPartialDirs = findAllPartialDirs(store);
					// If gargabe collection is on, no partial tiles other than the ones we expect should be
					// present.
					for (const k of allPartialDirs) {
						if (!wantPartialPrefixes.has(k) && test.withGarbageCollectionInterval > 0) {
							expect.fail(`Found unwanted partial: ${k}`);
						}
						wantPartialPrefixes.delete(k);
					}
					expect([...wantPartialPrefixes], "Did not find expected partials").toEqual([]);
				}

				// And finally, for good measure, assert that all the resources implied by the log's checkpoint
				// are present.
				const f = newFsck(vk.name(), vk, lr, defaultMerkleLeafHasher, { n: 1 });
				await f.check(ctx);
			} finally {
				ac.abort();
			}
		});
	}
});

describe.concurrent("TestPublishTree", () => {
	const tests: {
		name: string;
		publishInterval: number;
		republishInterval?: number;
		attempts: number[];
		growTree?: boolean;
		wantUpdates: number;
	}[] = [
		{
			name: "publish: works ok",
			publishInterval: 100,
			attempts: [1000],
			growTree: true,
			wantUpdates: 1,
		},
		{
			name: "publish: too soon, skip update",
			publishInterval: 10_000,
			growTree: true,
			attempts: [100],
			wantUpdates: 0,
		},
		{
			name: "publish: too soon, skip update, but recovers",
			publishInterval: 2000,
			growTree: true,
			attempts: [100, 2000],
			wantUpdates: 1,
		},
		{
			name: "publish: many attempts, eventually one succeeds",
			publishInterval: 1000,
			growTree: true,
			attempts: [300, 300, 300, 300],
			wantUpdates: 1,
		},
		{
			name: "republish: works ok",
			publishInterval: minCheckpointInterval,
			republishInterval: 100,
			attempts: [1000],
			wantUpdates: 1,
		},
		{
			name: "republish: too soon, skip update",
			publishInterval: minCheckpointInterval,
			republishInterval: 10_000,
			attempts: [100],
			wantUpdates: 0,
		},
		{
			name: "republish: too soon, skip update, but recovers",
			publishInterval: minCheckpointInterval,
			republishInterval: 2000,
			attempts: [100, 2000],
			wantUpdates: 1,
		},
		{
			name: "republish: many attempts, eventually one succeeds",
			publishInterval: minCheckpointInterval,
			republishInterval: 1000,
			attempts: [300, 300, 300, 300],
			wantUpdates: 1,
		},
	];
	for (const test of tests) {
		it(test.name, async () => {
			const ac = new AbortController();
			const ctx = ac.signal;
			try {
				const s = newMemoryDriver();
				const [sk] = mustGenerateKeys();
				const opts = newAppendOptions()
					.withCheckpointInterval(10 * 60_000) // Prevent tessera from publishing checkpoints on our behalf
					.withBatching(1, minCheckpointInterval)
					.withCheckpointSigner(sk);

				const logStorage = new logResourceStorage(s, opts.entriesPath());
				const { appender, reader: lr } = await s.newAppender(logStorage, opts, ctx);

				// Add time as an extension line on the checkpoint so we can easily tell when it's been updated.
				//
				// Port note: upstream renders the hash with %x. This port refuses to publish a
				// checkpoint that does not parse as one for the tree it was asked to sign
				// (docs/decisions/0205-checkpoint-publication-fails-closed.md), and a hex root is
				// not the base64 root a checkpoint carries, so the fake publisher writes base64.
				// The timestamp extension line, which is what the test observes, is unchanged.
				appender.newCP = async (size: bigint, hash: Uint8Array): Promise<Uint8Array> =>
					toUTF8(`origin\n${size}\n${toBase64(hash)}\n${Math.floor(Date.now() / 1000)}\n,`);

				await appender.publishCheckpoint(test.publishInterval, test.republishInterval ?? 0, ctx);

				let updatesSeen = 0;
				let cpOld: Uint8Array | undefined;
				try {
					cpOld = await lr.readCheckpoint(ctx);
				} catch (err) {
					if (!errorIs(err, ErrNotExist)) {
						throw err;
					}
				}

				if (test.growTree === true) {
					// Fake the tree growing here - we don't want Tessera creating a new checkpoint for us, as we'll do that
					// manually below.
					await appender.s.writeTreeState(1n, toUTF8("root)"));
				}

				for (const d of test.attempts) {
					await new Promise((r) => setTimeout(r, d));
					await appender.publishCheckpoint(test.publishInterval, test.republishInterval ?? 0, ctx);
					const cpNew = await lr.readCheckpoint(ctx);
					if (cpOld === undefined || toHex(cpOld) !== toHex(cpNew)) {
						updatesSeen++;
						cpOld = cpNew;
					}
				}
				expect(updatesSeen, `Saw ${updatesSeen} updates, want ${test.wantUpdates}`).toBe(test.wantUpdates);
			} finally {
				ac.abort();
			}
		});
	}
});

/**
 * findAllPartialDirs returns the "directories" holding partial resources: every key prefix
 * that ends in a path segment containing ".p", the counterpart of the `.p` directories Go's
 * version finds by walking the log directory.
 */
function findAllPartialDirs(store: MemoryObjectStore): Set<string> {
	const dirs = new Set<string>();
	for (const key of store.keys()) {
		const segments = key.split("/");
		for (let i = 1; i < segments.length; i++) {
			if ((segments[i - 1] as string).includes(".p")) {
				dirs.add(segments.slice(0, i).join("/"));
			}
		}
	}
	return dirs;
}

/**
 * expectedPartialPrefixes returns a slice containing resource prefixes where it's acceptable for a
 * tree of the provided size to have partial resources.
 *
 * These are really just the right-hand tiles/entry bundle in the tree.
 */
function expectedPartialPrefixes(size: bigint, entriesPath: (n: bigint, p: number) => string): string[] {
	const r: string[] = [];
	for (let l = 0n, c = size; c > 0n; l++, c >>= 8n) {
		const idx = c / 256n;
		const p = c % 256n;
		if (p !== 0n) {
			if (l === 0n) {
				r.push(`${entriesPath(idx, 0)}.p`);
			}
			r.push(`${tilePath(l, idx, 0)}.p`);
		}
	}
	return r;
}

function mustGenerateKeys(): [Signer, Verifier] {
	const { skey, vkey } = generateKey(undefined, "testlog");
	return [newSigner(skey), newVerifier(vkey)];
}

// The cases below have no counterpart in files_test.go.

describe("ObjectStoreDriver", () => {
	// Go's text for each interval, from the POSIX driver's NewAppender with the same Duration.
	describe("rejects a CheckpointInterval below the minimum, formatted as Go formats a Duration", () => {
		for (const [ms, want] of [
			[50, "50ms"],
			[0, "0s"],
			[0.5, "500µs"],
			[0.001, "1µs"],
			[0.000001, "1ns"],
			[1.5, "1.5ms"],
			[99.999999, "99.999999ms"],
			[-5, "-5ms"],
		] as const) {
			it(`${ms} ms -> ${want}`, async () => {
				const [sk] = mustGenerateKeys();
				const d = newMemoryDriver();
				await expect(
					d.appender(newAppendOptions().withCheckpointSigner(sk).withCheckpointInterval(ms)),
				).rejects.toThrow(`requested CheckpointInterval (${want}) is less than minimum permitted 100ms`);
			});
		}
	});

	it("initialises a new log: version file, empty tree state, and a signed empty checkpoint", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			const [sk, vk] = mustGenerateKeys();
			const { reader } = await newMemoryDriver({ store }).appender(testOptions(sk), ac.signal);

			expect(fromUTF8((await store.get(".state/version")) as Uint8Array)).toBe("1");
			expect(fromUTF8((await store.get(".state/treeState")) as Uint8Array)).toBe(
				'{"size":0,"root":"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="}',
			);
			const cp = parseCheckpoint(await reader.readCheckpoint(), vk.name(), vk).checkpoint;
			expect(cp.size).toBe(0n);
			expect(cp.hash).toEqual(DefaultHasher.emptyRoot());
			expect(store.keys()).toEqual([".state/treeState", ".state/version", CheckpointPath]);
		} finally {
			ac.abort();
		}
	});

	it("does not republish the checkpoint of an existing log on startup", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			const [sk] = mustGenerateKeys();
			await newMemoryDriver({ store }).appender(testOptions(sk), ac.signal);
			const first = await store.stat(CheckpointPath);
			await new Promise((r) => setTimeout(r, 5));
			await newMemoryDriver({ store }).appender(testOptions(sk), ac.signal);
			expect(await store.stat(CheckpointPath)).toEqual(first);
		} finally {
			ac.abort();
		}
	});

	const versionTests: { name: string; version: string; wantErr: string }[] = [
		{ name: "a different version", version: "2", wantErr: "wanted version 1 but found 2" },
		{
			name: "an unparsable version",
			version: "one",
			wantErr: 'failed to parse version: strconv.ParseUint: parsing "one": invalid syntax',
		},
		{
			name: "a version that overflows uint16",
			version: "65537",
			wantErr: 'failed to parse version: strconv.ParseUint: parsing "65537": value out of range',
		},
	];
	for (const test of versionTests) {
		it(`refuses a log whose version file holds ${test.name}`, async () => {
			const store = new MemoryObjectStore();
			await store.put(".state/version", toUTF8(test.version));
			const [sk] = mustGenerateKeys();
			await expect(newMemoryDriver({ store }).appender(testOptions(sk))).rejects.toThrow(test.wantErr);
			expect(await store.get(".state/treeState")).toBeUndefined();
		});
	}

	it("reports a corrupt tree state rather than reinitialising over it", async () => {
		const store = new MemoryObjectStore();
		await store.put(".state/treeState", toUTF8('{"size":12}'));
		const [sk] = mustGenerateKeys();
		await expect(newMemoryDriver({ store }).appender(testOptions(sk))).rejects.toThrow(
			"failed to load checkpoint for log: error in Unmarshal: json: missing field treeState.root",
		);
		expect(fromUTF8((await store.get(".state/treeState")) as Uint8Array)).toBe('{"size":12}');
	});

	// Not upstream: docs/decisions/0205-checkpoint-publication-fails-closed.md. Go's posix
	// driver starts a fresh tree here.
	it("refuses to start a new tree over a published checkpoint when the tree state is missing", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			const [sk] = mustGenerateKeys();
			const opts = testOptions(sk);
			const s = newMemoryDriver({ store });
			const { appender } = await s.newAppender(new logResourceStorage(s, opts.entriesPath()), opts, ac.signal);
			await appender.sequenceBatch([newEntry(toUTF8("a")), newEntry(toUTF8("b"))]);
			await appender.publishCheckpoint(0, 0, ac.signal);
			const published = await store.get(CheckpointPath);
			const bundle = await store.get("tile/entries/000.p/2");

			await store.deletePrefix(".state/treeState");
			await expect(newMemoryDriver({ store }).appender(opts, ac.signal)).rejects.toThrow(
				new Error(
					'refusing to initialise a new tree: .state/treeState does not exist but a checkpoint is already published at "checkpoint"; starting over would fork the published log (restore .state/treeState, or start the new log in an empty store)',
				),
			);
			// Nothing was rewritten.
			expect(await store.get(CheckpointPath)).toEqual(published);
			expect(await store.get("tile/entries/000.p/2")).toEqual(bundle);
			expect(await store.get(".state/treeState")).toBeUndefined();
		} finally {
			ac.abort();
		}
	});

	// The ADR's own scenario: the public tlog-tiles files survive, .state/ does not. The
	// refusal comes before ensureVersion would create .state/version, so not a key changes.
	it("refuses, and writes nothing, over published files with no .state/ at all", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			const [sk] = mustGenerateKeys();
			const opts = testOptions(sk);
			const s = newMemoryDriver({ store });
			const { appender } = await s.newAppender(new logResourceStorage(s, opts.entriesPath()), opts, ac.signal);
			await appender.sequenceBatch([newEntry(toUTF8("a")), newEntry(toUTF8("b"))]);
			await appender.publishCheckpoint(0, 0, ac.signal);

			await store.deletePrefix(".state/");
			const before = new Map<string, Uint8Array | undefined>();
			for (const key of store.keys()) {
				before.set(key, await store.get(key));
			}
			expect([...before.keys()]).toEqual([CheckpointPath, "tile/0/000.p/2", "tile/entries/000.p/2"]);

			await expect(newMemoryDriver({ store }).appender(opts, ac.signal)).rejects.toThrow(
				"refusing to initialise a new tree: .state/treeState does not exist but a checkpoint is already published",
			);
			expect(store.keys()).toEqual([...before.keys()]);
			for (const [key, value] of before) {
				expect(await store.get(key)).toEqual(value);
			}
		} finally {
			ac.abort();
		}
	});

	// Go checks the version file before it reads the tree state, so a version error comes
	// first; the refusal keeps that order wherever the version file exists.
	it("reports a bad version before refusing to start a new tree", async () => {
		const store = new MemoryObjectStore();
		await store.put(".state/version", toUTF8("2"));
		await store.put(CheckpointPath, toUTF8("published\n"));
		const [sk] = mustGenerateKeys();
		await expect(newMemoryDriver({ store }).appender(testOptions(sk))).rejects.toThrow(
			new Error("wanted version 1 but found 2"),
		);
		expect(store.keys()).toEqual([".state/version", CheckpointPath]);
	});

	it("still initialises a store that has neither tree state nor checkpoint", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			await store.put(".state/version", toUTF8("1"));
			const [sk] = mustGenerateKeys();
			await newMemoryDriver({ store }).appender(testOptions(sk), ac.signal);
			expect(await store.stat(CheckpointPath)).toBeDefined();
		} finally {
			ac.abort();
		}
	});

	it("reports a missing tree state as ErrNotExist", async () => {
		const d = newMemoryDriver();
		const err = await d.readTreeState().catch((e: unknown) => e);
		expect(errorIs(err, ErrNotExist)).toBe(true);
		expect((err as Error).message).toBe('error in get(".state/treeState"): get .state/treeState: file does not exist');
	});

	it("reads a tree state written by Go's encoding/json", async () => {
		const store = new MemoryObjectStore();
		await store.put(".state/treeState", toUTF8('{"size":18446744073709551615,"root":"//4="}'));
		expect(await newMemoryDriver({ store }).readTreeState()).toEqual({
			size: (1n << 64n) - 1n,
			root: new Uint8Array([0xff, 0xfe]),
		});
	});

	it("wraps a failure to take a lock, and keeps the abort reason reachable", async () => {
		const ac = new AbortController();
		const reason = new Error("shutting down");
		ac.abort(reason);
		const d = newMemoryDriver();
		const err = await d.garbageCollect(0n, 1, newAppendOptions().entriesPath(), ac.signal).catch((e: unknown) => e);
		expect((err as Error).message).toBe("lockFile(gcState.lock): shutting down");
		expect(errorIs(err, reason)).toBe(true);
	});

	it("does not wrap errors thrown while holding a lock", async () => {
		const d = newMemoryDriver();
		await expect(
			d.lockFile("treeState.lock", async () => {
				throw new Error("inside");
			}),
		).rejects.toThrow(/^inside$/);
	});

	it("names locks after the files posix flocks", async () => {
		const store = new MemoryObjectStore();
		const names: string[] = [];
		const lock = store.lock.bind(store);
		store.lock = <T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
			names.push(name);
			return lock(name, fn, signal);
		};
		const [sk] = mustGenerateKeys();
		const ac = new AbortController();
		try {
			const { appender } = await newMemoryDriver({ store }).appender(testOptions(sk), ac.signal);
			await appender.add(newEntry(toUTF8("x")))();
			await newMemoryDriver({ store }).garbageCollect(0n, 1, newAppendOptions().entriesPath());
		} finally {
			ac.abort();
		}
		expect(new Set(names)).toEqual(new Set([".state/treeState.lock", ".state/publish.lock", ".state/gcState.lock"]));
	});

	it("defaults to the global fetch, looked up when called and called without a receiver", async () => {
		let receiver: unknown = "unset";
		const stub = vi.fn(function (this: unknown): Promise<Response> {
			receiver = this;
			return Promise.resolve(new Response("stubbed"));
		});
		const d = newObjectStoreDriver({ store: new MemoryObjectStore() });
		vi.stubGlobal("fetch", stub);
		try {
			const r = await d.cfg.fetch("https://witness.example/add-checkpoint");
			expect(await r.text()).toBe("stubbed");
		} finally {
			vi.unstubAllGlobals();
		}
		expect(stub).toHaveBeenCalledOnce();
		expect(receiver).toBeUndefined();
	});
});

describe("logResourceStorage", () => {
	it("reports a missing checkpoint as exactly ErrNotExist", async () => {
		const d = newMemoryDriver();
		const { reader } = await d.migrationWriter(newMigrationOptions());
		await expect(reader.readCheckpoint()).rejects.toBe(ErrNotExist);
	});

	it("falls back from a missing partial resource to the full one", async () => {
		const store = new MemoryObjectStore();
		const d = newMemoryDriver({ store });
		const lrs = new logResourceStorage(d, newAppendOptions().entriesPath());
		await store.put(tilePath(0n, 3n, 0), toUTF8("full tile"));
		await store.put("tile/entries/003", toUTF8("full bundle"));

		expect(fromUTF8(await lrs.readTile(0n, 3n, 17))).toBe("full tile");
		expect(fromUTF8(await lrs.readEntryBundle(3n, 17))).toBe("full bundle");

		const err = await lrs.readTile(0n, 4n, 17).catch((e: unknown) => e);
		expect(errorIs(err, ErrNotExist)).toBe(true);
		expect((err as Error).message).toBe("neither partial nor full resource found: get tile/0/004: file does not exist");
	});

	it("prefers the partial resource when it exists", async () => {
		const store = new MemoryObjectStore();
		const lrs = new logResourceStorage(newMemoryDriver({ store }), newAppendOptions().entriesPath());
		await store.put("tile/entries/000.p/9", toUTF8("partial"));
		await store.put("tile/entries/000", toUTF8("full"));
		expect(fromUTF8(await lrs.readEntryBundle(0n, 9))).toBe("partial");
	});

	it("rejects tiles of impossible widths", async () => {
		const lrs = new logResourceStorage(newMemoryDriver(), newAppendOptions().entriesPath());
		await expect(lrs.storeTile(0n, 0n, 1n, new HashTile([]))).rejects.toThrow("tileSize 0 must be > 0 and <= 256");
		const tooWide = new HashTile(Array.from({ length: TileWidth + 1 }, () => new Uint8Array(32)));
		await expect(lrs.storeTile(0n, 0n, 1n, tooWide)).rejects.toThrow("tileSize 257 must be > 0 and <= 256");
	});

	it("stores a tile at the partial path implied by the log size", async () => {
		const store = new MemoryObjectStore();
		const lrs = new logResourceStorage(newMemoryDriver({ store }), newAppendOptions().entriesPath());
		const nodes = Array.from({ length: 3 }, (_, i) => new Uint8Array(32).fill(i));
		await lrs.storeTile(1n, 0n, 3n * 256n + 5n, new HashTile(nodes));
		expect(partialTileSize(1n, 0n, 3n * 256n + 5n)).toBe(3);
		expect(store.keys()).toEqual(["tile/1/000.p/3"]);
	});

	it("leaves superseded partial tiles in place when the full tile is written", async () => {
		const store = new MemoryObjectStore();
		const lrs = new logResourceStorage(newMemoryDriver({ store }), newAppendOptions().entriesPath());
		await lrs.writeTile(0n, 0n, 7, toUTF8("partial"));
		await lrs.writeTile(0n, 0n, 0, toUTF8("full"));
		expect(store.keys()).toEqual(["tile/0/000", "tile/0/000.p/7"]);
		expect(fromUTF8(await lrs.readTile(0n, 0n, 7))).toBe("partial");
	});
});

describe("appender", () => {
	it("sequenceBatch with no entries changes nothing", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			const s = newMemoryDriver({ store });
			const [sk] = mustGenerateKeys();
			const opts = testOptions(sk);
			const { appender } = await s.newAppender(new logResourceStorage(s, opts.entriesPath()), opts, ac.signal);
			const before = store.keys();
			const treeState = await store.get(".state/treeState");
			await appender.sequenceBatch([]);
			expect(store.keys()).toEqual(before);
			expect(await store.get(".state/treeState")).toEqual(treeState);
		} finally {
			ac.abort();
		}
	});

	it("extends a partial bundle written by an earlier batch", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			const s = newMemoryDriver({ store });
			const [sk] = mustGenerateKeys();
			const opts = testOptions(sk);
			const { appender, reader } = await s.newAppender(new logResourceStorage(s, opts.entriesPath()), opts, ac.signal);
			await appender.sequenceBatch([newEntry(toUTF8("a")), newEntry(toUTF8("b"))]);
			await appender.sequenceBatch([newEntry(toUTF8("c"))]);
			expect(store.keys("tile/entries/")).toEqual(["tile/entries/000.p/2", "tile/entries/000.p/3"]);
			expect(fromUTF8(await reader.readEntryBundle(0n, 3))).toBe("\0\x01a\0\x01b\0\x01c");
			expect(await reader.integratedSize()).toBe(3n);
		} finally {
			ac.abort();
		}
	});

	it("reports a publishedSize of zero when there is no checkpoint", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			const s = newMemoryDriver({ store });
			const [sk] = mustGenerateKeys();
			const opts = testOptions(sk);
			const { appender } = await s.newAppender(new logResourceStorage(s, opts.entriesPath()), opts, ac.signal);
			await store.deletePrefix(CheckpointPath);
			expect(await appender.publishedSize()).toBe(0n);
			await store.put(CheckpointPath, toUTF8("garbage"));
			await expect(appender.publishedSize()).rejects.toThrow(
				'failed to parse published checkpoint: invalid checkpoint: "garbage"',
			);
		} finally {
			ac.abort();
		}
	});

	// Not upstream: docs/decisions/0205-checkpoint-publication-fails-closed.md.
	for (const test of [
		{
			name: "an empty checkpoint",
			cp: (): Uint8Array => new Uint8Array(0),
			want: 'does not parse, refusing to publish it: invalid checkpoint: ""',
		},
		{
			name: "garbage",
			cp: (): Uint8Array => toUTF8("garbage"),
			want: 'does not parse, refusing to publish it: invalid checkpoint: "garbage"',
		},
		{
			name: "a checkpoint for another size",
			cp: (): Uint8Array => toUTF8(`testlog\n7\n${"A".repeat(43)}=\n`),
			want: "newCP returned a checkpoint for a different tree (size 7,",
		},
	]) {
		it(`refuses to publish ${test.name} and keeps the published checkpoint`, async () => {
			const ac = new AbortController();
			try {
				const store = new MemoryObjectStore();
				const [sk] = mustGenerateKeys();
				const opts = testOptions(sk);
				const s = newMemoryDriver({ store });
				const { appender } = await s.newAppender(new logResourceStorage(s, opts.entriesPath()), opts, ac.signal);
				await appender.sequenceBatch([newEntry(toUTF8("a"))]);
				const before = await store.get(CheckpointPath);
				appender.newCP = async () => test.cp();
				const err = await appender.publishCheckpoint(0, 0, ac.signal).catch((e: unknown) => e);
				expect((err as Error).message).toContain(test.want);
				expect(await store.get(CheckpointPath)).toEqual(before);
				// The log can still publish once the publisher behaves.
				expect(await appender.publishedSize()).toBe(0n);
			} finally {
				ac.abort();
			}
		});
	}

	it("waits out the checkpoint interval before publishing an integration", async () => {
		const ac = new AbortController();
		try {
			const [sk, vk] = mustGenerateKeys();
			const s = newMemoryDriver();
			const opts = testOptions(sk).withCheckpointInterval(60_000).withCheckpointRepublishInterval(0);
			const { appender, reader } = await s.appender(opts, ac.signal);
			// The empty log's checkpoint was published moments ago, so the first integration's
			// notification arrives while it is still fresh: publication waits for the interval.
			const idx = await appender.add(newEntry(toUTF8("x")))();
			expect(idx.index).toBe(0n);
			await new Promise((r) => setTimeout(r, 200));
			const cp = parseCheckpoint(await reader.readCheckpoint(), vk.name(), vk).checkpoint;
			expect(cp.size).toBe(0n);
			expect(await reader.integratedSize()).toBe(1n);
		} finally {
			ac.abort();
		}
	});
});

describe("garbageCollect", () => {
	it("processes at most maxBundles+1 bundles per run and records its progress", async () => {
		const ac = new AbortController();
		try {
			const store = new MemoryObjectStore();
			const s = newMemoryDriver({ store });
			const [sk] = mustGenerateKeys();
			const opts = testOptions(sk);
			const { appender } = await s.newAppender(new logResourceStorage(s, opts.entriesPath()), opts, ac.signal);
			// Four full bundles and a partial fifth, each written in batches of 100 so that every
			// bundle and bottom tile has superseded partial versions.
			let n = 0;
			while (n < 4 * 256 + 10) {
				const batch = Array.from({ length: Math.min(100, 4 * 256 + 10 - n) }, (_, i) => newEntry(toUTF8(`e${n + i}`)));
				await appender.sequenceBatch(batch);
				n += batch.length;
			}
			const size = BigInt(n);
			const partialDirs = (): string[] => [...findAllPartialDirs(store)].sort();
			expect(partialDirs()).toEqual([
				"tile/0/000.p",
				"tile/0/001.p",
				"tile/0/002.p",
				"tile/0/003.p",
				"tile/0/004.p",
				"tile/1/000.p",
				"tile/entries/000.p",
				"tile/entries/001.p",
				"tile/entries/002.p",
				"tile/entries/003.p",
				"tile/entries/004.p",
			]);

			// Go's loop tests `d > maxBundles` after counting, so a limit of 1 lets two bundles through.
			await s.garbageCollect(size, 1, opts.entriesPath());
			expect(fromUTF8((await store.get(".state/gcState")) as Uint8Array)).toBe('{"fromSize":512}');
			expect(partialDirs()).toEqual([
				"tile/0/002.p",
				"tile/0/003.p",
				"tile/0/004.p",
				"tile/1/000.p",
				"tile/entries/002.p",
				"tile/entries/003.p",
				"tile/entries/004.p",
			]);

			await s.garbageCollect(size, 100, opts.entriesPath());
			expect(fromUTF8((await store.get(".state/gcState")) as Uint8Array)).toBe('{"fromSize":1024}');
			expect(partialDirs()).toEqual(["tile/0/004.p", "tile/1/000.p", "tile/entries/004.p"]);
			expect(new Set(partialDirs())).toEqual(new Set(expectedPartialPrefixes(size, opts.entriesPath())));
		} finally {
			ac.abort();
		}
	});

	it("does nothing when it has already reached the tree size", async () => {
		const store = new MemoryObjectStore();
		await store.put(".state/gcState", toUTF8('{"fromSize":256}'));
		await store.put("tile/entries/000.p/7", toUTF8("kept"));
		await newMemoryDriver({ store }).garbageCollect(256n, 100, newAppendOptions().entriesPath());
		expect(store.keys()).toEqual([".state/gcState", "tile/entries/000.p/7"]);
	});
});

describe("isLastLeafInParent", () => {
	const tests: { i: bigint; want: boolean }[] = [
		{ i: 0n, want: false },
		{ i: 254n, want: false },
		{ i: 255n, want: true },
		{ i: 256n, want: false },
		{ i: 511n, want: true },
		{ i: (1n << 64n) - 1n, want: true },
	];
	for (const test of tests) {
		it(`${test.i}`, () => {
			expect(isLastLeafInParent(test.i)).toBe(test.want);
		});
	}
});

describe("MigrationStorage", () => {
	it("initialises the tree state without publishing a checkpoint", async () => {
		const store = new MemoryObjectStore();
		const { writer } = await newMemoryDriver({ store }).migrationWriter(newMigrationOptions());
		expect(await writer.integratedSize()).toBe(0n);
		expect(store.keys()).toEqual([".state/treeState", ".state/version"]);
	});

	it("rejects a bundle holding fewer entries than its path implies", async () => {
		const store = new MemoryObjectStore();
		const d: ObjectStoreDriver = newMemoryDriver({ store });
		const { writer } = await d.migrationWriter(newMigrationOptions());
		const ms = writer as MigrationStorage;
		await ms.setEntryBundle(0n, 3, toUTF8("\0\x01a\0\x01b"));
		await expect(ms.fetchLeafHashes(0n, 3n, 3n)).rejects.toThrow(
			"bundleHasherFunc for bundle index 0: slice bounds out of range [:3] with capacity 2",
		);
		await expect(ms.buildTree(3n)).rejects.toThrow("fetchLeafHashes(0, 3): bundleHasherFunc for bundle index 0");
		expect(await ms.integratedSize()).toBe(0n);
	});

	it("waits quietly for bundles it does not have yet", async () => {
		const { writer } = await newMemoryDriver().migrationWriter(newMigrationOptions());
		const ms = writer as MigrationStorage;
		await ms.buildTree(10n);
		expect(await ms.integratedSize()).toBe(0n);
	});
});

/** testOptions returns options suited to short tests: small batches and the minimum intervals. */
function testOptions(sk: Signer) {
	return newAppendOptions()
		.withCheckpointSigner(sk)
		.withBatching(64, 10)
		.withCheckpointInterval(minCheckpointInterval)
		.withGarbageCollectionInterval(0);
}
