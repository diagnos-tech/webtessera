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

// End-to-end tests for the ObjectStore driver running on a given backend. Where
// ./conformance.ts checks that a backend honours the ObjectStore contract, this suite
// checks that a whole Tessera log runs correctly on it: appending, publishing, serving
// verifiable tiles and bundles, restarting, sharing a store between drivers, garbage
// collection, migration and clean shutdown. Every backend's test file calls
// describeDriverConformance with a factory for fresh, empty stores.
//
// The suite runs in Node, in browsers and in workerd alike, so it uses only vitest and
// library code, and keeps logs small and intervals short so that each case takes at most a
// few seconds. Test-only: excluded from the published build.

import { describe, expect, it } from "vitest";
import { CheckpointPath, tilePath } from "../../../api/layout/index.ts";
import {
	type AppendOptions,
	type IndexFuture,
	type NewAppenderResult,
	newAppender,
	newAppendOptions,
} from "../../../append_lifecycle.ts";
import { newPublicationAwaiter, type PublicationAwaiter } from "../../../await.ts";
import { getEntryBundle, newProofBuilder } from "../../../client/index.ts";
import { newEntry } from "../../../entry.ts";
import { bytesEqual, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { ErrNotExist, errorIs } from "../../../internal/gostd/errors.ts";
import { checkpointUnsafe } from "../../../internal/parse/parse.ts";
import type { LogReader } from "../../../lifecycle.ts";
import { newMigrationOptions, newMigrationTarget } from "../../../migrate_lifecycle.ts";
import { type Checkpoint, parseCheckpoint } from "../../../vendor/formats/log/index.ts";
import { RangeFactory } from "../../../vendor/merkle/compact/index.ts";
import { verifyConsistency, verifyInclusion } from "../../../vendor/merkle/proof/index.ts";
import { DefaultHasher } from "../../../vendor/merkle/rfc6962/rfc6962.ts";
import { generateKey, newSigner, newVerifier, type Signer, type Verifier } from "../../../vendor/note/note.ts";
import { MemoryObjectStore } from "../../memory/memory.ts";
import { newObjectStoreDriver } from "../driver.ts";
import type { ObjectInfo, ObjectStore } from "../objectstore.ts";

/** NewStore returns a fresh, empty store. Each test calls it once. */
export type NewStore = () => ObjectStore | Promise<ObjectStore>;

/** DriverConformanceOptions tunes describeDriverConformance for a backend. */
export interface DriverConformanceOptions {
	/**
	 * reopen returns a second, independent handle onto the data held by store, as a second
	 * browser tab, a second process or a restarted server would obtain it. The restart and shared-store
	 * cases run their second driver over the returned handle. It defaults to returning store
	 * itself.
	 */
	readonly reopen?: (store: ObjectStore) => ObjectStore | Promise<ObjectStore>;
}

/** caseTimeout bounds each case generously; on Node every case finishes in a few seconds. */
const caseTimeout = 30_000;

/**
 * describeDriverConformance registers the end-to-end driver suite under a describe block
 * called name.
 */
export function describeDriverConformance(
	name: string,
	newStore: NewStore,
	options: DriverConformanceOptions = {},
): void {
	const reopen = options.reopen ?? ((s: ObjectStore) => s);

	describe(`${name}: ObjectStore driver conformance`, () => {
		it("assigns sequential indices and publishes a checkpoint committing to them", {
			timeout: caseTimeout,
		}, async () => {
			const k = newKeys();
			const log = await startLog(await newStore(), fastOptions(k.signer));
			try {
				const data = entries("seq", 0, 300);
				const futures = data.map((d) => log.appender.add(newEntry(d)));
				const indices = await Promise.all(futures.map((f) => f()));
				expect(indices.map((i) => i.index)).toEqual(data.map((_, i) => BigInt(i)));
				expect(indices.every((i) => !i.isDup)).toBe(true);

				await log.shutdown();
				const cp = await verifiedCheckpoint(log.reader, k.verifier);
				expect(cp.size).toBe(300n);
				expect(bytesEqual(cp.hash, referenceRoot(data))).toBe(true);
				expect(await log.reader.integratedSize()).toBe(300n);
				expect(await log.reader.nextIndex()).toBe(300n);
			} finally {
				log.stop();
			}
		});

		it("resolves a PublicationAwaiter once a checkpoint commits to the entry", { timeout: caseTimeout }, async () => {
			const k = newKeys();
			const log = await startLog(await newStore(), fastOptions(k.signer));
			try {
				log.appender.add(newEntry(toUTF8("first")));
				const [idx, cp] = await log.awaiter.await(log.appender.add(newEntry(toUTF8("second"))));
				expect(idx.index).toBe(1n);
				expect(cp).toBeDefined();
				const parsed = parseCheckpoint(cp as Uint8Array, k.verifier.name(), k.verifier).checkpoint;
				expect(parsed.size > idx.index).toBe(true);
			} finally {
				log.stop();
			}
		});

		it("serves tiles and bundles from which clients verify inclusion and consistency", {
			timeout: caseTimeout,
		}, async () => {
			const k = newKeys();
			const log = await startLog(await newStore(), fastOptions(k.signer));
			try {
				const first = entries("proof", 0, 100);
				const [, cp1Raw] = await log.awaiter.await(addAll(log, first).at(-1) as IndexFuture);
				const cp1 = parseCheckpoint(cp1Raw as Uint8Array, k.verifier.name(), k.verifier).checkpoint;
				expect(cp1.size).toBe(100n);

				const second = entries("proof", 100, 500);
				const [, cp2Raw] = await log.awaiter.await(addAll(log, second).at(-1) as IndexFuture);
				const cp2 = parseCheckpoint(cp2Raw as Uint8Array, k.verifier.name(), k.verifier).checkpoint;
				expect(cp2.size).toBe(500n);
				const all = [...first, ...second];
				expect(bytesEqual(cp2.hash, referenceRoot(all))).toBe(true);

				const readTile = (l: bigint, i: bigint, p: number, s?: AbortSignal) => log.reader.readTile(l, i, p, s);
				const readBundle = (i: bigint, p: number, s?: AbortSignal) => log.reader.readEntryBundle(i, p, s);
				for (let b = 0n; b * 256n < cp2.size; b++) {
					const bundle = await getEntryBundle(readBundle, b, cp2.size);
					const want = all.slice(Number(b) * 256, Number(b) * 256 + 256);
					expect(bundle.entries.length, `bundle ${b}`).toBe(want.length);
					for (const [i, e] of bundle.entries.entries()) {
						expect(bytesEqual(e, want[i] as Uint8Array), `bundle ${b} entry ${i}`).toBe(true);
					}
				}

				const pb = await newProofBuilder(cp2.size, readTile);
				for (const i of [0n, 1n, 99n, 255n, 256n, 499n]) {
					const proof = await pb.inclusionProof(i);
					verifyInclusion(DefaultHasher, i, cp2.size, leafHash(all, i), proof, cp2.hash);
				}
				const consistency = await pb.consistencyProof(cp1.size, cp2.size);
				verifyConsistency(DefaultHasher, cp1.size, cp2.size, consistency, cp1.hash, cp2.hash);

				// A client still holding the older checkpoint can keep using the partial tiles it implies.
				const pb1 = await newProofBuilder(cp1.size, readTile);
				const proof = await pb1.inclusionProof(50n);
				verifyInclusion(DefaultHasher, 50n, cp1.size, leafHash(all, 50n), proof, cp1.hash);
			} finally {
				log.stop();
			}
		});

		it("reports resources that do not exist as ErrNotExist", { timeout: caseTimeout }, async () => {
			const k = newKeys();
			const log = await startLog(await newStore(), fastOptions(k.signer));
			try {
				// Each read's rejection is handled as soon as the read is issued: on backends whose
				// reads settle in separate tasks, a rejection left unhandled until the loop below
				// reached it would be reported as an unhandled error.
				const missing = [
					log.reader.readTile(3n, 7n, 0),
					log.reader.readTile(0n, 9n, 5),
					log.reader.readEntryBundle(1000n, 0),
					log.reader.readEntryBundle(4n, 17),
				].map((p) =>
					p.then(
						() => undefined,
						(e: unknown) => e,
					),
				);
				for (const p of missing) {
					const err = await p;
					expect(errorIs(err, ErrNotExist), String(err)).toBe(true);
				}
			} finally {
				log.stop();
			}
		});

		it("deduplicates identical entries only when antispam is configured", { timeout: caseTimeout }, async () => {
			const k = newKeys();
			const store = await newStore();
			const deduped = await startLog(store, fastOptions(k.signer).withAntispam(256, null));
			try {
				const a1 = deduped.appender.add(newEntry(toUTF8("same")));
				const a2 = deduped.appender.add(newEntry(toUTF8("same")));
				const b = deduped.appender.add(newEntry(toUTF8("different")));
				const [i1, i2, i3] = await Promise.all([a1(), a2(), b()]);
				expect(i1).toEqual({ index: 0n, isDup: false });
				expect(i2).toEqual({ index: 0n, isDup: true });
				expect(i3).toEqual({ index: 1n, isDup: false });
				await deduped.shutdown();
			} finally {
				deduped.stop();
			}

			const plain = await startLog(store, fastOptions(k.signer));
			try {
				const p1 = plain.appender.add(newEntry(toUTF8("same")));
				const p2 = plain.appender.add(newEntry(toUTF8("same")));
				const [j1, j2] = await Promise.all([p1(), p2()]);
				expect([j1.index, j2.index]).toEqual([2n, 3n]);
				expect(j1.isDup || j2.isDup).toBe(false);
			} finally {
				plain.stop();
			}
		});

		it("resumes from the stored tree after a restart", { timeout: caseTimeout }, async () => {
			const k = newKeys();
			const store = await newStore();
			const before = entries("restart", 0, 300);
			const first = await startLog(store, fastOptions(k.signer));
			try {
				await Promise.all(addAll(first, before).map((f) => f()));
				await first.shutdown();
			} finally {
				first.stop();
			}

			const second = await startLog(await reopen(store), fastOptions(k.signer));
			try {
				expect(await second.reader.integratedSize()).toBe(300n);
				const after = entries("restart", 300, 350);
				const indices = await Promise.all(addAll(second, after).map((f) => f()));
				expect(indices.map((i) => i.index)).toEqual(after.map((_, i) => BigInt(300 + i)));
				await second.shutdown();

				const cp = await verifiedCheckpoint(second.reader, k.verifier);
				expect(cp.size).toBe(350n);
				expect(bytesEqual(cp.hash, referenceRoot([...before, ...after]))).toBe(true);
			} finally {
				second.stop();
			}
		});

		it("never assigns an index twice when two drivers share a store", { timeout: caseTimeout }, async () => {
			const k = newKeys();
			const store = await newStore();
			const a = await startLog(store, fastOptions(k.signer).withBatching(16, 5));
			const b = await startLog(await reopen(store), fastOptions(k.signer).withBatching(16, 5));
			try {
				const perDriver = 200;
				const byData = new Map<string, Uint8Array>();
				const futures: { data: Uint8Array; f: IndexFuture }[] = [];
				for (let i = 0; i < perDriver; i++) {
					for (const [log, tag] of [
						[a, "a"],
						[b, "b"],
					] as const) {
						const data = toUTF8(`${tag}-${i}`);
						byData.set(`${tag}-${i}`, data);
						futures.push({ data, f: log.appender.add(newEntry(data)) });
						if (i % 37 === 0) {
							// Let batches flush part-way through, so that the two drivers' batches interleave.
							await new Promise((r) => setTimeout(r, 7));
						}
					}
				}
				const assigned = await Promise.all(futures.map(async ({ data, f }) => ({ data, idx: await f() })));
				const total = 2 * perDriver;
				const byIndex: Uint8Array[] = new Array(total);
				for (const { data, idx } of assigned) {
					expect(idx.index < BigInt(total), `index ${idx.index} out of range`).toBe(true);
					expect(byIndex[Number(idx.index)], `index ${idx.index} assigned twice`).toBeUndefined();
					byIndex[Number(idx.index)] = data;
				}
				await Promise.all([a.shutdown(), b.shutdown()]);

				const cp = await verifiedCheckpoint(a.reader, k.verifier);
				expect(cp.size).toBe(BigInt(total));
				expect(bytesEqual(cp.hash, referenceRoot(byIndex))).toBe(true);
				const readBundle = (i: bigint, p: number, s?: AbortSignal) => b.reader.readEntryBundle(i, p, s);
				for (let bi = 0n; bi * 256n < cp.size; bi++) {
					const bundle = await getEntryBundle(readBundle, bi, cp.size);
					for (const [i, e] of bundle.entries.entries()) {
						const want = byIndex[Number(bi) * 256 + i] as Uint8Array;
						expect(bytesEqual(e, want), `entry ${Number(bi) * 256 + i}`).toBe(true);
					}
				}
			} finally {
				a.stop();
				b.stop();
			}
		});

		it("garbage collects superseded partial resources below the published size only", {
			timeout: caseTimeout,
		}, async () => {
			const k = newKeys();
			const store = await newStore();
			const entriesPath = newAppendOptions().entriesPath();

			// 600 entries in batches of 7: two full bundles and tiles, each with many superseded
			// partial versions, and a partial third bundle (88 entries) and level-1 tile (2 nodes).
			const build = await startLog(store, fastOptions(k.signer).withBatching(7, 5));
			try {
				await Promise.all(addAll(build, entries("gc", 0, 600)).map((f) => f()));
				await build.shutdown();
			} finally {
				build.stop();
			}
			const supersededPrefixes = [
				`${entriesPath(0n, 0)}.p/`,
				`${entriesPath(1n, 0)}.p/`,
				`${tilePath(0n, 0n, 0)}.p/`,
				`${tilePath(0n, 1n, 0)}.p/`,
			];
			for (const prefix of supersededPrefixes) {
				expect((await existingPartials(store, prefix)).length, `${prefix} before GC`).toBeGreaterThan(0);
			}
			const implied = [`${entriesPath(2n, 0)}.p/88`, `${tilePath(0n, 2n, 0)}.p/88`, `${tilePath(1n, 0n, 0)}.p/2`];

			// Restart with GC enabled; it runs against the published checkpoint, of size 600, and
			// records that it has collected everything below 512 once its run completes.
			const gc = await startLog(store, fastOptions(k.signer).withGarbageCollectionInterval(50));
			try {
				await waitFor(async () => {
					const state = await store.get(".state/gcState");
					return state !== undefined && bytesEqual(state, toUTF8('{"fromSize":512}'));
				}, "a GC run to complete");
				for (const prefix of supersededPrefixes) {
					expect(await existingPartials(store, prefix), prefix).toEqual([]);
				}
				for (const key of [...implied, entriesPath(0n, 0), entriesPath(1n, 0), tilePath(0n, 1n, 0)]) {
					expect(await store.get(key), key).toBeDefined();
				}
			} finally {
				gc.stop();
			}

			// Grow the tree past the end of the third bundle without publishing (the checkpoint is
			// fresh, and the interval long): the partials the published checkpoint implies must stay.
			const lagging = await startLog(
				store,
				fastOptions(k.signer).withCheckpointInterval(600_000).withGarbageCollectionInterval(50),
			);
			try {
				await Promise.all(addAll(lagging, entries("gc", 600, 800)).map((f) => f()));
				expect(await lagging.reader.integratedSize()).toBe(800n);
				expect(checkpointUnsafe(await lagging.reader.readCheckpoint()).size).toBe(600n);
				await new Promise((r) => setTimeout(r, 300));
				for (const key of implied.slice(0, 2)) {
					expect(await store.get(key), `${key} is implied by the published checkpoint`).toBeDefined();
				}
			} finally {
				lagging.stop();
			}
		});

		it("migrates a log into an empty store", { timeout: caseTimeout }, async () => {
			// The source log is built in memory: what is under test is the target backend.
			const k = newKeys();
			const source = new MemoryObjectStore();
			const data = entries("migrate", 0, 700);
			const src = await startLog(source, fastOptions(k.signer).withBatching(256, 5));
			let cp: Checkpoint;
			try {
				await Promise.all(addAll(src, data).map((f) => f()));
				await src.shutdown();
				cp = await verifiedCheckpoint(src.reader, k.verifier);
			} finally {
				src.stop();
			}

			const target = await newStore();
			const ac = new AbortController();
			try {
				const mt = await newMigrationTarget(newObjectStoreDriver({ store: target }), newMigrationOptions(), ac.signal);
				const getEntries = (i: bigint, p: number, s?: AbortSignal) => src.reader.readEntryBundle(i, p, s);
				await mt.migrate(4, cp.size, cp.hash, getEntries, ac.signal);
			} finally {
				ac.abort();
			}
			for (const key of [
				"tile/entries/000",
				"tile/entries/001",
				"tile/entries/002.p/188",
				"tile/0/002.p/188",
				"tile/1/000.p/2",
			]) {
				const want = await source.get(key);
				const got = await target.get(key);
				expect(want, key).toBeDefined();
				expect(got !== undefined && bytesEqual(got, want as Uint8Array), key).toBe(true);
			}
			// A migration target does not publish checkpoints of its own.
			expect(await target.stat(CheckpointPath)).toBeUndefined();
		});

		it("stops every background task once shut down and aborted", { timeout: caseTimeout }, async () => {
			const k = newKeys();
			const baselineTimers = activeTimers();
			const store = countingStore(await newStore());
			const log = await startLog(
				store,
				fastOptions(k.signer).withGarbageCollectionInterval(50).withCheckpointRepublishInterval(100),
			);
			try {
				await log.awaiter.await(addAll(log, entries("stop", 0, 40)).at(-1) as IndexFuture);
				// While running, the background tasks (publication, republication, GC, stats) keep
				// using the store even with nothing being appended; that is what must stop below.
				store.calls = 0;
				await new Promise((r) => setTimeout(r, 300));
				expect(store.calls, "store calls made by a running, idle appender").toBeGreaterThan(0);

				await log.shutdown();
				await expect(log.appender.add(newEntry(toUTF8("late")))()).rejects.toThrow("appender has been shut down");
			} finally {
				log.stop();
			}
			// Let any operation that was already in flight when the signal aborted complete.
			await new Promise((r) => setTimeout(r, 150));
			store.calls = 0;
			await new Promise((r) => setTimeout(r, 400));
			expect(store.calls, "store calls made after abort").toBe(0);
			const timers = activeTimers();
			if (timers !== undefined && baselineTimers !== undefined) {
				expect(timers, "timers still pending after abort").toBeLessThanOrEqual(baselineTimers);
			}
		});
	});
}

/** keys is a log's signing identity. */
interface keys {
	readonly signer: Signer;
	readonly verifier: Verifier;
}

function newKeys(): keys {
	const { skey, vkey } = generateKey(undefined, "example.com/conformance");
	return { signer: newSigner(skey), verifier: newVerifier(vkey) };
}

/** fastOptions returns options that keep a test log fast: small batches, the minimum checkpoint interval, no GC. */
function fastOptions(signer: Signer): AppendOptions {
	return newAppendOptions()
		.withCheckpointSigner(signer)
		.withBatching(32, 5)
		.withCheckpointInterval(100)
		.withCheckpointRepublishInterval(0)
		.withGarbageCollectionInterval(0);
}

/** runningLog is an appender together with what a test needs to drive and stop it. */
interface runningLog extends NewAppenderResult {
	readonly awaiter: PublicationAwaiter;
	/** stop aborts the appender's signal, stopping every background task it started. */
	stop(): void;
}

async function startLog(store: ObjectStore, opts: AppendOptions): Promise<runningLog> {
	const ac = new AbortController();
	const r = await newAppender(newObjectStoreDriver({ store }), opts, ac.signal);
	const awaiter = newPublicationAwaiter((s?: AbortSignal) => r.reader.readCheckpoint(s), 10, ac.signal);
	return {
		appender: r.appender,
		reader: r.reader,
		shutdown: (s?: AbortSignal) => r.shutdown(s),
		awaiter,
		stop: () => ac.abort(),
	};
}

function addAll(log: runningLog, data: readonly Uint8Array[]): IndexFuture[] {
	return data.map((d) => log.appender.add(newEntry(d)));
}

function entries(prefix: string, from: number, to: number): Uint8Array[] {
	const r: Uint8Array[] = [];
	for (let i = from; i < to; i++) {
		r.push(toUTF8(`${prefix}-${i}`));
	}
	return r;
}

function leafHash(data: readonly Uint8Array[], i: bigint): Uint8Array {
	return DefaultHasher.hashLeaf(data[Number(i)] as Uint8Array);
}

/** referenceRoot computes the RFC 6962 root of a log holding data, independently of any tiles. */
function referenceRoot(data: readonly Uint8Array[]): Uint8Array {
	if (data.length === 0) {
		return DefaultHasher.emptyRoot();
	}
	const r = new RangeFactory((l, rr) => DefaultHasher.hashChildren(l, rr)).newEmptyRange(0n);
	for (const d of data) {
		r.append(DefaultHasher.hashLeaf(d), null);
	}
	return r.getRootHash(null) as Uint8Array;
}

async function verifiedCheckpoint(reader: LogReader, v: Verifier): Promise<Checkpoint> {
	return parseCheckpoint(await reader.readCheckpoint(), v.name(), v).checkpoint;
}

/** existingPartials returns which of the 255 possible partial resources under prefix exist. */
async function existingPartials(store: ObjectStore, prefix: string): Promise<string[]> {
	const found: string[] = [];
	for (let p = 1; p < 256; p++) {
		if ((await store.stat(`${prefix}${p}`)) !== undefined) {
			found.push(`${prefix}${p}`);
		}
	}
	return found;
}

async function waitFor(cond: () => Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await cond())) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** countingStore wraps store, counting every call made to it. */
function countingStore(store: ObjectStore): ObjectStore & { calls: number } {
	const c = {
		calls: 0,
		get(key: string): Promise<Uint8Array | undefined> {
			c.calls++;
			return store.get(key);
		},
		stat(key: string): Promise<ObjectInfo | undefined> {
			c.calls++;
			return store.stat(key);
		},
		put(key: string, data: Uint8Array): Promise<void> {
			c.calls++;
			return store.put(key, data);
		},
		create(key: string, data: Uint8Array): Promise<boolean> {
			c.calls++;
			return store.create(key, data);
		},
		deletePrefix(prefix: string): Promise<void> {
			c.calls++;
			return store.deletePrefix(prefix);
		},
		lock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
			c.calls++;
			return store.lock(name, fn, signal);
		},
	};
	return c;
}

/**
 * activeTimers returns the number of pending timers where the runtime can report it (Node's
 * process.getActiveResourcesInfo), and undefined elsewhere. Where it is undefined, the
 * "no store calls after abort" check is the evidence that every background task stopped.
 */
function activeTimers(): number | undefined {
	const p = (globalThis as { process?: { getActiveResourcesInfo?: () => string[] } }).process;
	try {
		return p?.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length;
	} catch {
		// workerd's nodejs_compat defines the method but throws "not implemented" when it is called.
		return undefined;
	}
}
