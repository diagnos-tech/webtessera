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

// Runs the SQLite ObjectStore on libSQL through @libsql/client, in memory and in a local
// file, with local and with lease locking, and in a file that several processes share.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Client, createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { describeObjectStoreConformance } from "../../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../../objectstore/testing/driver_conformance.ts";
import type { SqlDatabase } from "../database.ts";
import { openSqliteObjectStore } from "../sqlite.ts";
import { describeSqliteBehaviour } from "../testing/behaviour.ts";
import { appendFromProcesses } from "../testing/processes.ts";
import { otherProcess, type StoreTarget, storeFactory } from "../testing/stores.ts";
import { D1Limits, StrictSqlDatabase } from "../testing/strict.ts";
import { fromLibsql, type LibsqlClientLike } from "./libsql.ts";

const dir = mkdtempSync(`${tmpdir()}/webtessera-libsql-`);
const clients: Client[] = [];

afterAll(() => {
	for (const c of clients.splice(0)) {
		c.close();
	}
	rmSync(dir, { recursive: true, force: true });
});

function client(url: string): Client {
	const c = createClient({ url });
	clients.push(c);
	return c;
}

let files = 0;
const fileOf = new WeakMap<SqlDatabase, string>();

const memory = (): StoreTarget => ({ database: fromLibsql(client(":memory:")) });
const file = (): StoreTarget => {
	const url = `file:${dir}/log-${++files}.db`;
	const database = fromLibsql(client(url));
	fileOf.set(database, url);
	return { database };
};
// secondClient opens another client on the same file, as a second process would.
const secondClient = (db: SqlDatabase): SqlDatabase => fromLibsql(client(fileOf.get(db) ?? ":memory:"));

for (const [name, f] of [
	["libSQL in memory", storeFactory(memory)],
	["libSQL file", storeFactory(file)],
	[
		"libSQL file, lease locking, second store on a second client",
		storeFactory(file, { locking: "lease" }, secondClient),
	],
	[
		"libSQL in memory, D1 limits, lease locking",
		storeFactory(
			() => ({ database: new StrictSqlDatabase(fromLibsql(client(":memory:")), D1Limits) }),
			{
				locking: "lease",
			},
			otherProcess,
		),
	],
] as const) {
	describeObjectStoreConformance(`SqliteObjectStore (${name})`, f.newStore);
	describeDriverConformance(`SqliteObjectStore (${name})`, f.newStore, { reopen: f.reopen });
}

describeSqliteBehaviour("libSQL", memory);
describeSqliteBehaviour("libSQL file, lease locking", file, { locking: "lease" });

describe("fromLibsql", () => {
	it("accepts @libsql/client's Client as it is", () => {
		// The assertion that matters is the assignment, checked by tsc against @libsql/client's types.
		const like: LibsqlClientLike = client(":memory:");
		expect(like.protocol).toBe("file");
	});

	it("defaults to local locking for an in-memory database only", async () => {
		const lockingOf = async (database: SqlDatabase) => (await openSqliteObjectStore({ database })).locking;
		expect(await lockingOf(fromLibsql(client(":memory:")))).toBe("local");
		expect(await lockingOf(fromLibsql(client("file::memory:")))).toBe("local");
		expect(await lockingOf(fromLibsql(client(`file:${dir}/default-${++files}.db`)))).toBe("lease");

		// An embedded replica's protocol is "file" too, and its local database is a file:
		// the client refuses to keep one in memory.
		expect(() => createClient({ url: ":memory:", syncUrl: "http://127.0.0.1:1" })).toThrow(/[Ee]mbedded replica/);
		const replica: LibsqlClientLike = {
			protocol: "file",
			execute: async () => ({ columns: ["seq", "name", "file"], rows: [[0, "main", `${dir}/replica.db`]] }),
			batch: () => Promise.reject(new Error("not connected")),
		};
		const defaultLocking = fromLibsql(replica).defaultLocking;
		expect(typeof defaultLocking === "function" ? await defaultLocking() : defaultLocking).toBe("lease");

		const remote: LibsqlClientLike = {
			protocol: "https",
			execute: () => Promise.reject(new Error("not connected")),
			batch: () => Promise.reject(new Error("not connected")),
		};
		expect(fromLibsql(remote).defaultLocking).toBe("lease");
		expect(fromLibsql(remote).leaseClock).toBe("database");
	});

	it("returns one SqlDatabase per client", () => {
		const c = client(":memory:");
		expect(fromLibsql(c)).toBe(fromLibsql(c));
	});

	// The libSQL counterpart of sqlite_test.ts's three-process test. The client keeps a pool
	// of connections, which only its `timeout` option gives a busy timeout; the children
	// create theirs with one, as fromLibsql's documentation asks of a shared file.
	it("keeps one consistent log when processes append to one file with default options", {
		timeout: 60_000,
	}, async () => {
		const path = `${dir}/processes-${++files}.db`;
		await appendFromProcesses("libsql", path, 100, () =>
			openSqliteObjectStore({ database: fromLibsql(client(`file:${path}`)) }),
		);
	});

	it("says how to give a client a busy timeout when a local database is busy", async () => {
		const busy = Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY", rawCode: 5 });
		const local = (timeout: number): LibsqlClientLike => ({
			protocol: "file",
			execute: async (s) => {
				if (s.sql === "PRAGMA busy_timeout") {
					return { columns: ["timeout"], rows: [[timeout]] };
				}
				throw busy;
			},
			batch: () => Promise.reject(busy),
		});
		const hint =
			"SQLITE_BUSY: database is locked (this libSQL client has no busy timeout, so a write that meets another connection's lock fails at once: when other processes or clients open the same file, create it with one, as createClient({ url, timeout: 5000 }))";
		for (const call of [
			(db: SqlDatabase) => db.query({ sql: "SELECT 1", params: [] }),
			(db: SqlDatabase) => db.batch([{ sql: "SELECT 1", params: [] }]),
		]) {
			await expect(call(fromLibsql(local(0)))).rejects.toThrow(new Error(hint));
			await expect(call(fromLibsql(local(0)))).rejects.toMatchObject({ cause: busy });
			// A client that has a busy timeout, or a remote one, reports the error as it is.
			await expect(call(fromLibsql(local(5000)))).rejects.toBe(busy);
			await expect(call(fromLibsql({ ...local(0), protocol: "https" }))).rejects.toBe(busy);
		}
		// Other errors pass through untouched.
		const other = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed");
		await expect(
			fromLibsql({ ...local(0), batch: () => Promise.reject(other) }).batch([{ sql: "SELECT 1", params: [] }]),
		).rejects.toBe(other);
	});
});
