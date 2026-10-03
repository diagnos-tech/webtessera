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

// fromSqliteSync on node:sqlite, and on a stand-in for better-sqlite3's statement API, which
// refuses all() for statements that return no rows.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlValue } from "../database.ts";
import { openSqliteObjectStore } from "../sqlite.ts";
import { fromSqliteSync, type SqliteSyncDatabase, type SqliteSyncStatement } from "./sync.ts";
import { DefaultBusyTimeoutMs } from "./syncengine.ts";

function pragma(db: DatabaseSync, name: string): unknown {
	return Object.values(db.prepare(`PRAGMA ${name}`).all()[0] ?? {})[0];
}

/**
 * betterSqlite3Like wraps a node:sqlite connection in better-sqlite3's statement
 * contract: `reader` says whether a statement returns rows, and all() throws for one that
 * does not.
 */
function betterSqlite3Like(db: DatabaseSync): SqliteSyncDatabase & { runs: number } {
	const like = {
		runs: 0,
		prepare(sql: string): SqliteSyncStatement {
			const stmt: StatementSync = db.prepare(sql);
			const reader = /^\s*(SELECT|PRAGMA [a-z_]+$)/i.test(sql) || /\bRETURNING\b/i.test(sql);
			return {
				reader,
				all: (...params: SqlValue[]) => {
					if (!reader) {
						throw new TypeError("This statement does not return data. Use run() instead");
					}
					return stmt.all(...params);
				},
				run: (...params: SqlValue[]) => {
					like.runs++;
					return stmt.run(...params);
				},
			};
		},
	};
	return like;
}

describe("fromSqliteSync", () => {
	it("raises synchronous to FULL and sets a busy timeout on a connection that lacks them", () => {
		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA synchronous = NORMAL");
		fromSqliteSync(db);
		expect(pragma(db, "synchronous")).toBe(2);
		expect(pragma(db, "busy_timeout")).toBe(DefaultBusyTimeoutMs);
	});

	it("leaves stricter settings alone", () => {
		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA synchronous = EXTRA");
		db.exec("PRAGMA busy_timeout = 123");
		fromSqliteSync(db);
		expect(pragma(db, "synchronous")).toBe(3);
		expect(pragma(db, "busy_timeout")).toBe(123);
	});

	it("returns one SqlDatabase per connection, timing leases on the database's clock", () => {
		const db = new DatabaseSync(":memory:");
		const a = fromSqliteSync(db);
		expect(fromSqliteSync(db)).toBe(a);
		expect(fromSqliteSync(new DatabaseSync(":memory:"))).not.toBe(a);
		expect(a.leaseClock).toBe("database");
	});

	it("defaults to local locking only for a database no other connection can open", () => {
		const dir = mkdtempSync(`${tmpdir()}/webtessera-sync-`);
		try {
			const cases = [
				{ path: ":memory:", want: "local" },
				{ path: "", want: "local" },
				{ path: `${dir}/log.db`, want: "lease" },
				{ path: `file:${dir}/uri.db`, want: "lease" },
				{ path: "file::memory:", want: "local" },
			];
			for (const c of cases) {
				const db = new DatabaseSync(c.path);
				expect(fromSqliteSync(db).defaultLocking, c.path).toBe(c.want);
				// node:sqlite's own report of the file agrees.
				expect(db.location() === null ? "local" : "lease", c.path).toBe(c.want);
				db.close();
			}
			// A binding the adapter knows nothing about is judged by SQLite's answer alone.
			expect(fromSqliteSync(betterSqlite3Like(new DatabaseSync(`${dir}/other.db`))).defaultLocking).toBe("lease");
			expect(fromSqliteSync(betterSqlite3Like(new DatabaseSync(":memory:"))).defaultLocking).toBe("local");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs statements that return no rows through run() where all() refuses them", async () => {
		const like = betterSqlite3Like(new DatabaseSync(":memory:"));
		const s = await openSqliteObjectStore({ database: fromSqliteSync(like), maxChunkBytes: 4 });
		await s.put("k", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
		expect(await s.create("k", new Uint8Array([1]))).toBe(false);
		expect(await s.create("j", new Uint8Array([2, 3, 4, 5, 6]))).toBe(true);
		expect(await s.get("k")).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
		expect(await s.get("j")).toEqual(new Uint8Array([2, 3, 4, 5, 6]));
		await s.deletePrefix("");
		expect(await s.stat("k")).toBeUndefined();
		expect(like.runs).toBeGreaterThan(0);
	});

	it("rolls a batch back when a statement fails, leaving the connection usable", async () => {
		const db = new DatabaseSync(":memory:");
		const sql = fromSqliteSync(db);
		await sql.query({ sql: "CREATE TABLE t (x INTEGER NOT NULL)", params: [] });
		await expect(
			sql.batch([
				{ sql: "INSERT INTO t (x) VALUES (?)", params: [1] },
				{ sql: "INSERT INTO t (x) VALUES (?)", params: [null] },
			]),
		).rejects.toThrow("NOT NULL");
		expect(await sql.query({ sql: "SELECT count(*) AS n FROM t", params: [] })).toEqual([{ n: 0 }]);
		expect(await sql.batch([{ sql: "INSERT INTO t (x) VALUES (?) RETURNING x", params: [2] }])).toEqual([[{ x: 2 }]]);
	});
});
