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

// Runs the SQLite ObjectStore on the SQL API of a SQLite-backed Durable Object inside
// workerd: the shared suites, and a log run by newSqliteDriver inside a real object, with
// what survives the runtime evicting or resetting the instance, and what the appender's
// timers do around requests.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EntryBundle } from "../../../api/state.ts";
import { type IndexFuture, newAppender, newAppendOptions } from "../../../append_lifecycle.ts";
import { newPublicationAwaiter, type PublicationAwaiter } from "../../../await.ts";
import { newEntry } from "../../../entry.ts";
import { newFsck } from "../../../fsck/fsck.ts";
import { bytesEqual } from "../../../internal/gostd/bytes.ts";
import { sleep } from "../../../internal/gostd/sync.ts";
import { checkpointUnsafe } from "../../../internal/parse/parse.ts";
import { defaultMerkleLeafHasher, type LogReader } from "../../../lifecycle.ts";
import { generateKey, newSigner, newVerifier } from "../../../vendor/note/note.ts";
import { describeObjectStoreConformance } from "../../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../../objectstore/testing/driver_conformance.ts";
import { newSqliteDriver, openSqliteObjectStore } from "../sqlite.ts";
import { describeSqliteBehaviour } from "../testing/behaviour.ts";
import { type StoreTarget, storeFactory } from "../testing/stores.ts";
import { DurableObjectSqlLimits, StrictSqlDatabase } from "../testing/strict.ts";
import { inFreshObject, inObject, type TestNamespace } from "../testing/workers/objects.ts";
import type { SqliteTestObject } from "../testing/workers/worker.ts";
import { type DurableObjectStorageLike, fromDurableObjectStorage } from "./durableobject.ts";

const ns: TestNamespace = env.SQLITE_OBJECT;

const newTarget = (): StoreTarget => ({ database: inObject(ns.get(ns.newUniqueId())) });
const strictTarget = (): StoreTarget => ({
	database: new StrictSqlDatabase(inObject(ns.get(ns.newUniqueId())), DurableObjectSqlLimits),
});

for (const [name, f] of [
	["Durable Object", storeFactory(newTarget)],
	["Durable Object, 4 KiB chunks, production limits", storeFactory(strictTarget, { maxChunkBytes: 4096 })],
] as const) {
	describeObjectStoreConformance(`SqliteObjectStore (${name})`, f.newStore);
	describeDriverConformance(`SqliteObjectStore (${name})`, f.newStore, { reopen: f.reopen });
}

describeSqliteBehaviour("Durable Object", newTarget);

function filled(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		b[i] = (i * 31 + seed) & 0xff;
	}
	return b;
}

describe("SqliteObjectStore (Durable Object)", () => {
	it("accepts the runtime's storage as it is", async () => {
		await inFreshObject(ns, async (storage) => {
			// The assertion that matters is the assignment, checked by `tsc -p tsconfig.workers.json`.
			const like: DurableObjectStorageLike = storage;
			expect(fromDurableObjectStorage(like)).toBe(fromDurableObjectStorage(storage));
			expect(fromDurableObjectStorage(like).defaultLocking).toBe("local");
		});
	});

	it("keeps objects across eviction", async () => {
		const stub = ns.get(ns.newUniqueId());
		const before = await runInDurableObject(stub, async (instance, state) => {
			const s = await openSqliteObjectStore({ database: fromDurableObjectStorage(state.storage), maxChunkBytes: 1000 });
			await s.put("checkpoint", filled(10, 1));
			await s.put("tile/entries/000", filled(5000 + 3, 2));
			return instance;
		});

		await evictDurableObject(stub);

		await runInDurableObject(stub, async (instance, state) => {
			expect(instance).not.toBe(before);
			const s = await openSqliteObjectStore({ database: fromDurableObjectStorage(state.storage), maxChunkBytes: 1000 });
			expect(await s.get("checkpoint")).toEqual(filled(10, 1));
			const got = await s.get("tile/entries/000");
			expect(got !== undefined && bytesEqual(got, filled(5000 + 3, 2))).toBe(true);
		});
	});
});

const origin = "example.com/webtessera/sqlite-durableobject-test";
const { skey, vkey } = generateKey(undefined, origin);

/** runningLog is what a Durable Object keeps for the log it runs. */
interface runningLog {
	readonly add: (data: Uint8Array) => IndexFuture;
	readonly reader: LogReader;
	readonly awaiter: PublicationAwaiter;
	readonly db: StrictSqlDatabase;
	/** stop shuts the appender down and then aborts its signal, as newAppender documents. */
	readonly stop: () => Promise<void>;
}

interface logOptions {
	readonly checkpointIntervalMs: number;
	readonly republishIntervalMs?: number;
}

/**
 * startLog starts a log on storage the way a Durable Object's constructor would. The
 * StrictSqlDatabase wrapper holds the driver to the production limits and counts its
 * statements.
 */
async function startLog(storage: DurableObjectStorage, o: logOptions): Promise<runningLog> {
	const db = new StrictSqlDatabase(fromDurableObjectStorage(storage), DurableObjectSqlLimits);
	const ac = new AbortController();
	let opts = newAppendOptions()
		.withCheckpointSigner(newSigner(skey))
		.withBatching(256, 10)
		.withCheckpointInterval(o.checkpointIntervalMs)
		.withGarbageCollectionInterval(o.checkpointIntervalMs);
	if (o.republishIntervalMs !== undefined) {
		opts = opts.withCheckpointRepublishInterval(o.republishIntervalMs);
	}
	const { appender, shutdown, reader } = await newAppender(await newSqliteDriver({ database: db }), opts, ac.signal);
	return {
		add: (data) => appender.add(newEntry(data)),
		reader,
		awaiter: newPublicationAwaiter((s) => reader.readCheckpoint(s), 20, ac.signal),
		db,
		stop: async () => {
			await shutdown();
			ac.abort(new Error("log stopped"));
		},
	};
}

/** entry returns the data of the i'th test entry: 4 KiB, so that a full bundle spans two rows. */
function entry(i: number): Uint8Array {
	return new Uint8Array(4096).fill(i & 0xff);
}

/** addRange adds entries [from, from+n) and resolves once each is integrated, to its index. */
async function addRange(log: runningLog, from: number, n: number): Promise<bigint[]> {
	const futures = Array.from({ length: n }, (_, i) => log.add(entry(from + i)));
	return (await Promise.all(futures.map((f) => f()))).map((r) => r.index);
}

async function publishedSize(reader: LogReader): Promise<bigint> {
	return checkpointUnsafe(await reader.readCheckpoint()).size;
}

function seq(from: number, n: number): bigint[] {
	return Array.from({ length: n }, (_, i) => BigInt(from + i));
}

/**
 * reset forcibly resets the Durable Object called id, as a deploy, a crash or the runtime
 * relocating it would: the instance is discarded together with whatever it was running,
 * timers included, and its storage is kept. It returns a stub for the object's next
 * instance; the runtime breaks stubs to the old one.
 *
 * evictDurableObject cannot stand in for this: it evicts an object only once nothing is
 * pending in it, and a running appender always has a timer pending.
 */
async function reset(id: DurableObjectId): Promise<DurableObjectStub<SqliteTestObject>> {
	const err = await runInDurableObject(ns.get(id), (_, state) => state.abort("reset by test")).then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(String(err)).toContain("reset by test");
	return ns.get(id);
}

describe("newSqliteDriver (Durable Object)", () => {
	it("resumes after a reset with every integrated entry intact", async () => {
		const id = ns.newUniqueId();
		const first = await runInDurableObject(ns.get(id), async (instance, state) => {
			const log = await startLog(state.storage, { checkpointIntervalMs: 100 });
			expect(await addRange(log, 0, 300)).toEqual(seq(0, 300));
			await log.awaiter.await(log.add(entry(300)));
			return instance;
		});

		const stub = await reset(id);

		await runInDurableObject(stub, async (instance, state) => {
			expect(instance).not.toBe(first);
			const log = await startLog(state.storage, { checkpointIntervalMs: 100 });
			expect(await log.reader.integratedSize()).toBe(301n);
			expect(await addRange(log, 301, 50)).toEqual(seq(301, 50));
			const [, cp] = await log.awaiter.await(log.add(entry(351)));
			expect(checkpointUnsafe(cp ?? new Uint8Array(0)).size).toBe(352n);

			// Every bundle and tile written by either instance is consistent with the
			// published checkpoint.
			await newFsck(origin, newVerifier(vkey), log.reader, defaultMerkleLeafHasher, { n: 4 }).check();
			const bundle = new EntryBundle();
			bundle.unmarshalText(await log.reader.readEntryBundle(0n, 0));
			expect(bundle.entries).toHaveLength(256);
			expect(bundle.entries[255]).toEqual(entry(255));
			await log.stop();
		});
	});

	it("publishes after a reset what was integrated but not yet published before it", async () => {
		const id = ns.newUniqueId();
		await runInDurableObject(ns.get(id), async (_, state) => {
			const log = await startLog(state.storage, { checkpointIntervalMs: 1000 });
			expect(await addRange(log, 0, 10)).toEqual(seq(0, 10));
			// The checkpoint published when the log was created is younger than the
			// checkpoint interval, so the new entries are not published yet.
			expect(await publishedSize(log.reader)).toBe(0n);
		});

		const stub = await reset(id);

		await runInDurableObject(stub, async (_, state) => {
			const log = await startLog(state.storage, { checkpointIntervalMs: 1000 });
			expect(await log.reader.integratedSize()).toBe(10n);
			const deadline = Date.now() + 5000;
			while ((await publishedSize(log.reader)) < 10n && Date.now() < deadline) {
				await sleep(50);
			}
			expect(await publishedSize(log.reader)).toBe(10n);
			await log.stop();
		});
	});

	it("keeps publishing between requests while the instance stays in memory", async () => {
		const stub = ns.get(ns.newUniqueId());
		const logs = new WeakMap<object, runningLog>();
		await runInDurableObject(stub, async (instance, state) => {
			const log = await startLog(state.storage, { checkpointIntervalMs: 300 });
			logs.set(instance, log);
			expect(await addRange(log, 0, 5)).toEqual(seq(0, 5));
			expect(await publishedSize(log.reader)).toBe(0n);
		});

		// No request is in flight here: only the appender's own timers can publish.
		await sleep(1000);

		await runInDurableObject(stub, async (instance) => {
			const log = logs.get(instance);
			expect(log, "the instance was not evicted").toBeDefined();
			expect(await publishedSize(log?.reader ?? expect.unreachable())).toBe(5n);
			await log?.stop();
		});
	});

	it("stops its background work once shut down and aborted, so the runtime can evict it", async () => {
		const stub = ns.get(ns.newUniqueId());
		const first = await runInDurableObject(stub, async (instance, state) => {
			const log = await startLog(state.storage, { checkpointIntervalMs: 100, republishIntervalMs: 100 });
			await log.awaiter.await(log.add(entry(0)));

			// While running, the publisher, the garbage collector and the awaiter poll the
			// database on their own, even with nothing to do.
			let statements = log.db.statements;
			await sleep(500);
			expect(log.db.statements).toBeGreaterThan(statements);

			await log.stop();
			await sleep(100);
			statements = log.db.statements;
			await sleep(500);
			expect(log.db.statements).toBe(statements);
			return instance;
		});

		// evictDurableObject refuses an object with timers still pending, so this also
		// shows that stopping the log left none behind.
		await evictDurableObject(stub);

		await runInDurableObject(stub, async (instance, state) => {
			expect(instance).not.toBe(first);
			const log = await startLog(state.storage, { checkpointIntervalMs: 100 });
			expect(await log.reader.integratedSize()).toBe(1n);
			expect(await addRange(log, 1, 1)).toEqual([1n]);
			await log.stop();
		});
	});
});
