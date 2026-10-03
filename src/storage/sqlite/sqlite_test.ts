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

// Runs the SQLite ObjectStore on Node's built-in node:sqlite: in memory and in a file, with
// the default and with explicit locking, two connections to one file as two processes would
// open it, and through a double that enforces Cloudflare D1's and Durable Objects'
// production limits.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { newFsck } from "../../fsck/fsck.ts";
import { bytesEqual, toBase64 } from "../../internal/gostd/bytes.ts";
import { checkpointUnsafe } from "../../internal/parse/parse.ts";
import { defaultMerkleLeafHasher } from "../../lifecycle.ts";
import { newSinkTarget } from "../../mirror/sink.ts";
import { parseCheckpoint } from "../../vendor/formats/log/note.ts";
import { newSignerForCosignatureV1 } from "../../vendor/formats/note/note_cosigv1.ts";
import { generateKey, newSigner, newVerifier, sign } from "../../vendor/note/note.ts";
import { newWitnessServer } from "../../witness/server.ts";
import { describeObjectStoreConformance } from "../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../objectstore/testing/driver_conformance.ts";
import { fromSqliteSync } from "./adapters/sync.ts";
import type { SqlDatabase } from "./database.ts";
import { DefaultMaxChunkBytes, newSqliteDriver, openSqliteObjectStore } from "./index.ts";
import { describeSqliteBehaviour } from "./testing/behaviour.ts";
import { appendConcurrently } from "./testing/concurrent.ts";
import { otherProcess, type StoreOptions, type StoreTarget, storeFactory, uniqueNamespace } from "./testing/stores.ts";
import { D1Limits, StrictSqlDatabase } from "./testing/strict.ts";

const dir = mkdtempSync(`${tmpdir()}/webtessera-sqlite-`);
const connections: DatabaseSync[] = [];

afterAll(() => {
	for (const c of connections.splice(0)) {
		c.close();
	}
	rmSync(dir, { recursive: true, force: true });
});

function connect(path: string): DatabaseSync {
	const c = new DatabaseSync(path);
	connections.push(c);
	return c;
}

let files = 0;

/** newFile returns the path of a SQLite file no test has used yet. */
function newFile(): string {
	return `${dir}/log-${++files}.db`;
}

const memory = (): StoreTarget => ({ database: fromSqliteSync(connect(":memory:")) });
const file = (): StoreTarget => ({ database: fromSqliteSync(connect(newFile())) });

// fileOf maps each file-backed database to its path, so that a second connection to the
// same file can be opened.
const fileOf = new WeakMap<SqlDatabase, string>();
const fileTarget = (): StoreTarget => {
	const path = newFile();
	const database = fromSqliteSync(connect(path));
	fileOf.set(database, path);
	return { database };
};
const secondConnection = (db: SqlDatabase): SqlDatabase => fromSqliteSync(connect(fileOf.get(db) ?? ":memory:"));

const variants: readonly {
	name: string;
	target: () => StoreTarget;
	options?: StoreOptions;
	reopenDatabase?: (db: SqlDatabase) => SqlDatabase;
}[] = [
	{ name: "node:sqlite in memory", target: memory },
	{ name: "node:sqlite file", target: file },
	{ name: "node:sqlite file, namespaced", target: () => ({ ...file(), namespace: uniqueNamespace() }) },
	{
		name: "node:sqlite in memory, lease locking, second store as another process",
		target: memory,
		options: { locking: "lease" },
		reopenDatabase: otherProcess,
	},
	{
		name: "node:sqlite file, lease locking, second store on a second connection",
		target: fileTarget,
		options: { locking: "lease" },
		reopenDatabase: secondConnection,
	},
	{
		name: "node:sqlite file, default options, second store on a second connection",
		target: fileTarget,
		reopenDatabase: secondConnection,
	},
	{
		name: "node:sqlite in memory, 4 KiB chunks, D1 limits",
		target: () => ({ database: new StrictSqlDatabase(fromSqliteSync(connect(":memory:")), D1Limits) }),
		options: { maxChunkBytes: 4096 },
	},
	{
		name: "node:sqlite in memory, D1 limits, lease locking",
		target: () => ({ database: new StrictSqlDatabase(fromSqliteSync(connect(":memory:")), D1Limits) }),
		options: { locking: "lease" },
		reopenDatabase: otherProcess,
	},
];

for (const v of variants) {
	const f = storeFactory(v.target, v.options, v.reopenDatabase);
	describeObjectStoreConformance(`SqliteObjectStore (${v.name})`, f.newStore);
	describeDriverConformance(`SqliteObjectStore (${v.name})`, f.newStore, { reopen: f.reopen });
}

describeSqliteBehaviour("node:sqlite", memory);
describeSqliteBehaviour("node:sqlite, lease locking", memory, { locking: "lease" });

describe("SqliteObjectStore on node:sqlite", () => {
	it("keeps every statement within D1's and Durable Objects' limits at the default chunk size", async () => {
		const strict = new StrictSqlDatabase(fromSqliteSync(connect(":memory:")), D1Limits);
		const s = await openSqliteObjectStore({ database: strict });
		// The largest entry bundle tlog-tiles allows: 256 entries of 65535 bytes, each with
		// its two-byte length prefix.
		const bundle = new Uint8Array(256 * (2 + 0xffff)).fill(7);
		await s.put("tile/entries/000", bundle);
		const got = await s.get("tile/entries/000");
		expect(got !== undefined && bytesEqual(got, bundle)).toBe(true);
		expect(await s.create("tile/entries/001", bundle)).toBe(true);
		await s.deletePrefix("tile/");
		expect(DefaultMaxChunkBytes).toBeLessThan(D1Limits.maxValueBytes);
	});

	it("writes each put, create and deletePrefix as one batch", async () => {
		const strict = new StrictSqlDatabase(fromSqliteSync(connect(":memory:")), D1Limits);
		const s = await openSqliteObjectStore({ database: strict, maxChunkBytes: 100 });
		const before = strict.batches;
		await s.put("a", new Uint8Array(1000));
		await s.create("b", new Uint8Array(1000));
		await s.deletePrefix("");
		expect(strict.batches - before).toBe(3);
	});

	it("rolls a failed batch back entirely", async () => {
		const db = fromSqliteSync(connect(":memory:"));
		const s = await openSqliteObjectStore({ database: db, maxChunkBytes: 100 });
		await s.put("k", new Uint8Array(250).fill(1));
		await expect(
			db.batch([
				{ sql: "DELETE FROM webtessera_chunks", params: [] },
				{ sql: "INSERT INTO webtessera_objects (key) VALUES ('broken')", params: [] },
			]),
		).rejects.toThrow("NOT NULL");
		expect(await s.get("k")).toEqual(new Uint8Array(250).fill(1));
	});

	it("shares local locks between the stores of a realm over one database, and only those", async () => {
		const path = newFile();
		const local = { locking: "local" } as const;
		const a = await openSqliteObjectStore({ database: fromSqliteSync(connect(path)), ...local });
		// A second connection to the same file, as another part of this process would open.
		const b = await openSqliteObjectStore({ database: fromSqliteSync(connect(path)), ...local });
		const other = await openSqliteObjectStore({
			database: fromSqliteSync(connect(path)),
			namespace: uniqueNamespace(),
			...local,
		});
		const elsewhere = await openSqliteObjectStore({ database: fromSqliteSync(connect(newFile())), ...local });
		const events: string[] = [];
		let release = (): void => {};
		const held = a.lock("treeState.lock", async () => {
			events.push("a");
			await new Promise<void>((r) => {
				release = r;
			});
		});
		const waiting = b.lock("treeState.lock", async () => void events.push("b"));
		await other.lock("treeState.lock", async () => void events.push("other namespace"));
		await elsewhere.lock("treeState.lock", async () => void events.push("other database"));
		expect(events).toEqual(["a", "other namespace", "other database"]);
		release();
		await Promise.all([held, waiting]);
		expect(events).toEqual(["a", "other namespace", "other database", "b"]);
	});

	it("defaults to lease locking unless the adapter shows that nothing else can reach the database", async () => {
		const lockingOf = async (database: SqlDatabase) => (await openSqliteObjectStore({ database })).locking;
		const memory = fromSqliteSync(connect(":memory:"));
		expect(await lockingOf(memory)).toBe("local");
		expect(await lockingOf(fromSqliteSync(connect("")))).toBe("local");
		expect(await lockingOf(fromSqliteSync(connect(newFile())))).toBe("lease");
		// An adapter that does not say gets leases.
		expect(await lockingOf({ query: (q) => memory.query(q), batch: (b) => memory.batch(b) })).toBe("lease");
		expect(await lockingOf({ ...otherProcess(memory), defaultLocking: async () => "local" })).toBe("local");
		// The caller's choice wins either way.
		expect((await openSqliteObjectStore({ database: memory, locking: "lease" })).locking).toBe("lease");
		expect(
			(await openSqliteObjectStore({ database: fromSqliteSync(connect(newFile())), locking: "local" })).locking,
		).toBe("local");
	});

	it("rejects invalid options", async () => {
		const database = fromSqliteSync(connect(":memory:"));
		for (const maxChunkBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(openSqliteObjectStore({ database, maxChunkBytes }), String(maxChunkBytes)).rejects.toThrow(
				RangeError,
			);
		}
		for (const namespace of ["", "Log", "a-b", "a b", "x".repeat(65), "ü"]) {
			await expect(openSqliteObjectStore({ database, namespace }), namespace).rejects.toThrow(RangeError);
		}
		for (const lease of [
			{ ttlMs: 0 },
			{ ttlMs: Number.NaN },
			{ ttlMs: Number.POSITIVE_INFINITY },
			{ ttlMs: 1000.5 },
			{ ttlMs: 1000, renewIntervalMs: 1000 },
			{ ttlMs: 1000, renewIntervalMs: Number.NaN },
			{ maxPollIntervalMs: 0 },
			{ maxPollIntervalMs: -1 },
			{ maxPollIntervalMs: Number.NaN },
		]) {
			await expect(openSqliteObjectStore({ database, locking: "lease", lease }), JSON.stringify(lease)).rejects.toThrow(
				RangeError,
			);
		}
		await expect(openSqliteObjectStore({ database, locking: "global" as "local" })).rejects.toThrow(RangeError);
	});

	it("keeps one consistent log when drivers on separate connections to one file append at once", async () => {
		const path = newFile();
		await appendConcurrently(() => ({ database: fromSqliteSync(connect(path)) }), 3, 150);
	});

	it("keeps one consistent log when processes append to one file with default options", {
		timeout: 60_000,
	}, async () => {
		const path = newFile();
		const origin = "example.com/webtessera-sqlite-processes";
		const { skey, vkey } = generateKey(undefined, origin);
		const script = decodeURIComponent(new URL("./testing/append_process.ts", import.meta.url).pathname);
		const perProcess = 100;
		const tags = ["p0", "p1", "p2"];
		const outputs = await Promise.all(
			tags.map(
				(tag) =>
					new Promise<string[]>((resolve, reject) => {
						const child = spawn(execPath, ["--no-warnings", script, path, tag, String(perProcess), skey], {
							stdio: ["ignore", "pipe", "pipe"],
						});
						let out = "";
						let err = "";
						child.stdout.on("data", (d) => {
							out += String(d);
						});
						child.stderr.on("data", (d) => {
							err += String(d);
						});
						child.on("error", reject);
						child.on("close", (code) =>
							code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(`${tag} exited ${code}: ${err}`)),
						);
					}),
			),
		);
		const total = tags.length * perProcess;
		const indices = outputs.flat();
		expect(new Set(indices).size).toBe(total);
		expect(indices.every((i) => BigInt(i) < BigInt(total))).toBe(true);

		// Read the log back as any static tlog-tiles reader would.
		const reader = newSinkTarget(await openSqliteObjectStore({ database: fromSqliteSync(connect(path)) }));
		const verifier = newVerifier(vkey);
		const { checkpoint } = parseCheckpoint(await reader.readCheckpoint(), origin, verifier);
		expect(checkpoint.size).toBe(BigInt(total));
		await newFsck(origin, verifier, reader, defaultMerkleLeafHasher, { n: 4 }).check();
	});

	it("lets exactly one of two witnesses on separate connections to one file cosign from a size", async () => {
		const path = newFile();
		const logKey = generateKey(undefined, "example.com/log");
		const witnessKey = generateKey(undefined, "witness.example/w1");
		const origins = Array.from({ length: 4 }, (_, i) => `example.com/log${i}`);
		const witness = async () =>
			newWitnessServer({
				signer: newSignerForCosignatureV1(witnessKey.skey),
				store: await openSqliteObjectStore({ database: fromSqliteSync(connect(path)) }),
				logs: origins.map((origin) => ({ origin, verifierKeys: [logKey.vkey] })),
			});
		const checkpoint = (origin: string, size: bigint) =>
			sign(
				{ text: `${origin}\n${size}\n${toBase64(new Uint8Array(32).fill(Number(size)))}\n` },
				newSigner(logKey.skey),
			);
		for (const origin of origins) {
			const [w1, w2] = [await witness(), await witness()];
			const results = await Promise.allSettled([
				w1.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: checkpoint(origin, 5n) }),
				w2.addCheckpoint({ oldSize: 0n, proof: [], checkpoint: checkpoint(origin, 3n) }),
			]);
			expect(
				results.filter((r) => r.status === "fulfilled"),
				origin,
			).toHaveLength(1);
			const won = results[0]?.status === "fulfilled" ? 5n : 3n;
			const latest = await w2.latestCheckpoint(origin);
			expect(latest === undefined ? undefined : checkpointUnsafe(latest).size, origin).toBe(won);
		}
	});

	it("returns the engine's ObjectStoreDriver from newSqliteDriver", async () => {
		const driver = await newSqliteDriver({ database: fromSqliteSync(connect(":memory:")) });
		expect(typeof driver.appender).toBe("function");
		const ac = new AbortController();
		ac.abort(new Error("gave up"));
		await expect(newSqliteDriver({ database: fromSqliteSync(connect(":memory:")) }, ac.signal)).rejects.toThrow(
			"gave up",
		);
	});
});
