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

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fromSqliteSync } from "./adapters/sync.ts";
import type { SqlDatabase } from "./database.ts";
import { openSqliteObjectStore } from "./index.ts";
import { ensureSchema, type Migration, SchemaVersion, schemaMigrations, tableNames } from "./schema.ts";

function newDatabase(): SqlDatabase {
	return fromSqliteSync(new DatabaseSync(":memory:"));
}

async function versionOf(db: SqlDatabase, namespace?: string): Promise<number | undefined> {
	const rows = await db.query({
		sql: `SELECT value FROM ${tableNames(namespace).meta} WHERE name = 'schema_version'`,
		params: [],
	});
	return rows[0] === undefined ? undefined : Number(rows[0].value);
}

async function tablesOf(db: SqlDatabase): Promise<string[]> {
	const rows = await db.query({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", params: [] });
	return rows.map((r) => String(r.name));
}

// toNextVersion is a stand-in for a future migration: it adds an index.
const toNextVersion: Migration = (t) => [
	{ sql: `CREATE INDEX IF NOT EXISTS ${t.objects}_by_mod_time ON ${t.objects} (mod_time)`, params: [] },
];

describe("SQLite ObjectStore schema", () => {
	it("creates prefixed tables at the current schema version", async () => {
		const db = newDatabase();
		await openSqliteObjectStore({ database: db });
		expect(await tablesOf(db)).toEqual([
			"webtessera_chunks",
			"webtessera_fence",
			"webtessera_locks",
			"webtessera_meta",
			"webtessera_objects",
		]);
		expect(await versionOf(db)).toBe(SchemaVersion);
		expect(SchemaVersion).toBe(2);
	});

	it("names a namespace's tables after it", async () => {
		const db = newDatabase();
		await openSqliteObjectStore({ database: db, namespace: "log_2" });
		expect(await tablesOf(db)).toEqual([
			"webtessera_log_2_chunks",
			"webtessera_log_2_fence",
			"webtessera_log_2_locks",
			"webtessera_log_2_meta",
			"webtessera_log_2_objects",
		]);
		expect(tableNames()).toEqual({
			meta: "webtessera_meta",
			objects: "webtessera_objects",
			chunks: "webtessera_chunks",
			locks: "webtessera_locks",
			fence: "webtessera_fence",
		});
	});

	it("opens tables it created before, and tables several stores create at once", async () => {
		const db = newDatabase();
		await Promise.all(Array.from({ length: 5 }, () => openSqliteObjectStore({ database: db })));
		const s = await openSqliteObjectStore({ database: db });
		await s.put("checkpoint", new Uint8Array([1]));
		await openSqliteObjectStore({ database: db });
		expect(await s.get("checkpoint")).toEqual(new Uint8Array([1]));
		expect(await versionOf(db)).toBe(SchemaVersion);
	});

	it("refuses tables a newer webtessera wrote, naming the versions", async () => {
		const db = newDatabase();
		await openSqliteObjectStore({ database: db });
		await db.query({ sql: "UPDATE webtessera_meta SET value = 7 WHERE name = 'schema_version'", params: [] });
		await expect(openSqliteObjectStore({ database: db })).rejects.toThrow(
			"schema version 7, written by a newer webtessera; this version supports schema version 2 and earlier",
		);
	});

	it("upgrades older tables one migration at a time, once, however many stores open them", async () => {
		const db = newDatabase();
		const t = tableNames();
		await ensureSchema(db, t);
		const next = [...schemaMigrations, toNextVersion];
		await Promise.all(Array.from({ length: 3 }, () => ensureSchema(db, t, undefined, next)));
		expect(await versionOf(db)).toBe(SchemaVersion + 1);
		const indexes = await db.query({
			sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'webtessera_objects_by_mod_time'",
			params: [],
		});
		expect(indexes).toHaveLength(1);
		// This version of the code now meets tables newer than it.
		await expect(ensureSchema(db, t)).rejects.toThrow("newer webtessera");
	});

	it("reports a migration that fails, and leaves the version where it was", async () => {
		const db = newDatabase();
		const t = tableNames();
		await ensureSchema(db, t);
		const broken: Migration = () => [{ sql: "ALTER TABLE webtessera_missing ADD COLUMN x INTEGER", params: [] }];
		await expect(ensureSchema(db, t, undefined, [...schemaMigrations, broken])).rejects.toThrow(
			"upgrading webtessera_objects",
		);
		expect(await versionOf(db)).toBe(SchemaVersion);
	});

	it("upgrades version 1 tables to a fence that no connection setting turns off", async () => {
		const raw = new DatabaseSync(":memory:");
		const db = fromSqliteSync(raw);
		const t = tableNames();
		await ensureSchema(db, t, undefined, []);
		await Promise.all(Array.from({ length: 3 }, () => ensureSchema(db, t)));
		expect(await versionOf(db)).toBe(SchemaVersion);
		raw.exec("PRAGMA ignore_check_constraints = ON");
		// The fence of this version, and that of a version 1 store still running, both
		// refuse a batch whose lease is gone.
		expect(() => raw.exec("INSERT INTO webtessera_fence (webtessera_lease_lost) SELECT NULL")).toThrow(
			"webtessera_lease_lost",
		);
		raw.exec("PRAGMA ignore_check_constraints = OFF");
		expect(() => raw.exec("INSERT INTO webtessera_fence (lost) SELECT 1")).toThrow("webtessera_lease_lost");
		expect(raw.prepare("SELECT count(*) AS n FROM webtessera_fence").all()).toEqual([{ n: 0 }]);
	});

	it("refuses a database that does not store text as UTF-8, before creating anything in it", async () => {
		for (const encoding of ["UTF-16le", "UTF-16be"]) {
			const raw = new DatabaseSync(":memory:");
			raw.exec(`PRAGMA encoding = '${encoding}'`);
			const db = fromSqliteSync(raw);
			await expect(openSqliteObjectStore({ database: db }), encoding).rejects.toThrow("does not store text as UTF-8");
			expect(await tablesOf(db), encoding).toEqual([]);
		}
		const utf8 = new DatabaseSync(":memory:");
		utf8.exec("PRAGMA encoding = 'UTF-8'");
		await openSqliteObjectStore({ database: fromSqliteSync(utf8) });
	});

	it("stops when the signal aborts", async () => {
		const ac = new AbortController();
		ac.abort(new Error("stop"));
		await expect(openSqliteObjectStore({ database: newDatabase() }, ac.signal)).rejects.toThrow("stop");
	});
});
