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
import { ensureSchema, type Migration, SchemaVersion, tableNames } from "./schema.ts";

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

// toVersion2 is a stand-in for a future migration: it adds an index.
const toVersion2: Migration = (t) => [
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
		expect(SchemaVersion).toBe(1);
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
		expect(await versionOf(db)).toBe(1);
	});

	it("refuses tables a newer webtessera wrote, naming the versions", async () => {
		const db = newDatabase();
		await openSqliteObjectStore({ database: db });
		await db.query({ sql: "UPDATE webtessera_meta SET value = 7 WHERE name = 'schema_version'", params: [] });
		await expect(openSqliteObjectStore({ database: db })).rejects.toThrow(
			"schema version 7, written by a newer webtessera; this version supports schema version 1 and earlier",
		);
	});

	it("upgrades older tables one migration at a time, once, however many stores open them", async () => {
		const db = newDatabase();
		const t = tableNames();
		await ensureSchema(db, t);
		await Promise.all(Array.from({ length: 3 }, () => ensureSchema(db, t, undefined, [toVersion2])));
		expect(await versionOf(db)).toBe(2);
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
		await expect(ensureSchema(db, t, undefined, [broken])).rejects.toThrow("upgrading webtessera_objects");
		expect(await versionOf(db)).toBe(1);
	});

	it("stops when the signal aborts", async () => {
		const ac = new AbortController();
		ac.abort(new Error("stop"));
		await expect(openSqliteObjectStore({ database: newDatabase() }, ac.signal)).rejects.toThrow("stop");
	});
});
