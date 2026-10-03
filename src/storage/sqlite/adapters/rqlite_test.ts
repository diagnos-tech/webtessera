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

// fromRqlite against a fake rqlite node (testing/fake_rqlite.ts), so that its wire format
// and error handling are covered by `bun run test:unit`. rqlite_services_test.ts runs the
// same suites against a real rqlite.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { describeObjectStoreConformance } from "../../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../../objectstore/testing/driver_conformance.ts";
import type { SqlDatabase } from "../database.ts";
import { openSqliteObjectStore } from "../sqlite.ts";
import { describeSqliteBehaviour } from "../testing/behaviour.ts";
import { type FakeRqlite, newFakeRqlite } from "../testing/fake_rqlite.ts";
import { type StoreTarget, storeFactory } from "../testing/stores.ts";
import { fromRqlite } from "./rqlite.ts";

const fakes = new WeakMap<SqlDatabase, FakeRqlite>();

function newTarget(): StoreTarget {
	const fake = newFakeRqlite(new DatabaseSync(":memory:"));
	const database = fromRqlite({ url: "http://rqlite.test:4001/", fetch: fake.fetch });
	fakes.set(database, fake);
	return { database };
}

// A reopened store gets a client of its own, as another process would.
const reopenDatabase = (db: SqlDatabase): SqlDatabase => {
	const fake = fakes.get(db);
	if (fake === undefined) {
		throw new Error("not a fake rqlite database");
	}
	return fromRqlite({ url: "http://rqlite.test:4001", fetch: fake.fetch });
};

const f = storeFactory(newTarget, {}, reopenDatabase);
describeObjectStoreConformance("SqliteObjectStore (rqlite, fake node)", f.newStore);
describeDriverConformance("SqliteObjectStore (rqlite, fake node)", f.newStore, { reopen: f.reopen });
describeSqliteBehaviour("rqlite, fake node", newTarget);

describe("fromRqlite", () => {
	it("defaults to lease locking on the store's clock, and linearizable reads", async () => {
		const { database } = newTarget();
		expect(database.defaultLocking).toBe("lease");
		expect(database.leaseClock).toBe("client");
		const s = await openSqliteObjectStore({ database });
		expect(s.locking).toBe("lease");
		await s.get("checkpoint");
		const fake = fakes.get(database);
		expect(fake?.requests.at(-1)?.url).toBe("http://rqlite.test:4001/db/request?level=linearizable");
	});

	it("sends batches as transactions, with the configured level and headers", async () => {
		const fake = newFakeRqlite(new DatabaseSync(":memory:"));
		const db = fromRqlite({
			url: "http://rqlite.test:4001",
			fetch: fake.fetch,
			level: "strong",
			headers: { Authorization: "Basic dXNlcjpwYXNz" },
		});
		await db.batch([{ sql: "CREATE TABLE t (b BLOB)", params: [] }]);
		expect(fake.requests[0]?.url).toBe("http://rqlite.test:4001/db/request?level=strong&transaction");
		expect(fake.requests[0]?.headers.get("Authorization")).toBe("Basic dXNlcjpwYXNz");
		expect(fake.requests[0]?.headers.get("Content-Type")).toBe("application/json");
	});

	it("round-trips BLOBs, including empty ones and every byte value", async () => {
		const fake = newFakeRqlite(new DatabaseSync(":memory:"));
		const db = fromRqlite({ url: "http://rqlite.test", fetch: fake.fetch });
		const all = Uint8Array.from({ length: 256 }, (_, i) => i);
		await db.query({ sql: "CREATE TABLE t (i INTEGER, b BLOB)", params: [] });
		await db.batch([
			{ sql: "INSERT INTO t (i, b) VALUES (?, ?)", params: [1, all] },
			{ sql: "INSERT INTO t (i, b) VALUES (?, ?)", params: [2, new Uint8Array(0)] },
		]);
		const rows = await db.query({ sql: "SELECT i, b FROM t ORDER BY i", params: [] });
		expect(rows).toEqual([
			{ i: 1, b: all },
			{ i: 2, b: new Uint8Array(0) },
		]);
	});

	it("rolls a batch back and rejects with rqlite's error when a statement fails", async () => {
		const fake = newFakeRqlite(new DatabaseSync(":memory:"));
		const db = fromRqlite({ url: "http://rqlite.test", fetch: fake.fetch });
		await db.query({ sql: "CREATE TABLE t (x INTEGER NOT NULL)", params: [] });
		await expect(
			db.batch([
				{ sql: "INSERT INTO t (x) VALUES (?)", params: [1] },
				{ sql: "INSERT INTO t (x) VALUES (?)", params: [null] },
			]),
		).rejects.toThrow("rqlite: NOT NULL constraint failed");
		expect(await db.query({ sql: "SELECT count(*) AS n FROM t", params: [] })).toEqual([{ n: 0 }]);
	});

	it("reports HTTP failures", async () => {
		const fake = newFakeRqlite(new DatabaseSync(":memory:"));
		const db = fromRqlite({ url: "http://rqlite.test", fetch: fake.fetch });
		fake.failNext = 503;
		await expect(db.query({ sql: "SELECT 1", params: [] })).rejects.toThrow("HTTP 503: leader not found");
	});

	it("refuses parameters rqlite would bind as something else", async () => {
		const fake = newFakeRqlite(new DatabaseSync(":memory:"));
		const db = fromRqlite({ url: "http://rqlite.test", fetch: fake.fetch });
		for (const s of ["X'00'", " x'' ", "x'abc'"]) {
			await expect(db.query({ sql: "SELECT ?", params: [s] }), s).rejects.toThrow("would be bound as a BLOB");
		}
		expect(await db.query({ sql: "SELECT ? AS s", params: ["x'yz'"] })).toEqual([{ s: "x'yz'" }]);
		await expect(db.query({ sql: "SELECT ?", params: [2n ** 60n] })).rejects.toThrow(RangeError);
		expect(await db.query({ sql: "SELECT ? AS n", params: [7n] })).toEqual([{ n: 7 }]);
	});
});
