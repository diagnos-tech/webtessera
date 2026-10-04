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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { isBusy } from "./busy.ts";

const dir = mkdtempSync(`${tmpdir()}/webtessera-busy-`);

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** lockedBy returns what fn throws while another connection holds path's write lock. */
async function lockedBy(path: string, fn: () => unknown): Promise<unknown> {
	const holder = new DatabaseSync(path);
	holder.exec("CREATE TABLE IF NOT EXISTS t (v)");
	holder.exec("BEGIN IMMEDIATE");
	try {
		await fn();
		return undefined;
	} catch (err) {
		return err;
	} finally {
		holder.exec("ROLLBACK");
		holder.close();
	}
}

describe("isBusy", () => {
	it("recognises node:sqlite's error for a locked database", async () => {
		const path = `${dir}/node.db`;
		const db = new DatabaseSync(path);
		db.exec("PRAGMA busy_timeout = 0");
		const err = await lockedBy(path, () => db.exec("INSERT INTO t VALUES (1)"));
		db.close();
		expect(err).toBeInstanceOf(Error);
		expect(isBusy(err)).toBe(true);
	});

	it("recognises libSQL's error for a locked database", async () => {
		// The lock is held through libSQL too: two SQLite libraries in one process do not see
		// each other's locks, as POSIX record locks are per process.
		const url = `file:${dir}/libsql.db`;
		const holder = createClient({ url });
		await holder.execute("CREATE TABLE t (v)");
		const tx = await holder.transaction("write");
		const client = createClient({ url });
		const err = await client.batch([{ sql: "INSERT INTO t VALUES (1)", args: [] }], "write").then(
			() => undefined,
			(e: unknown) => e,
		);
		tx.close();
		client.close();
		holder.close();
		expect(err).toBeInstanceOf(Error);
		expect(isBusy(err)).toBe(true);
	});

	it("recognises the other engines' shapes, and causes", () => {
		for (const err of [
			Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }), // better-sqlite3, bun:sqlite
			Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }),
			Object.assign(new Error("x"), { code: "SQLITE_LOCKED_SHAREDCACHE" }),
			Object.assign(new Error("x"), { resultCode: 5 }), // sqlite-wasm
			Object.assign(new Error("x"), { errcode: 517 }), // SQLITE_BUSY_SNAPSHOT
			new Error("D1_ERROR: database is locked"),
			new Error("database table is locked"),
			new Error("lockFile(treeState.lock)", { cause: new Error("SQLITE_BUSY: database is locked") }),
		]) {
			expect(isBusy(err), String(err)).toBe(true);
		}
	});

	it("does not mistake other errors for a busy database", () => {
		for (const err of [
			new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: t.v"),
			Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }),
			Object.assign(new Error("EIO: i/o error"), { errno: 5 }), // an operating-system errno, not SQLite's
			Object.assign(new Error("x"), { errcode: 19 }),
			new Error("the database is unlocked"),
			undefined,
			null,
			"busy",
		]) {
			expect(isBusy(err), String(err)).toBe(false);
		}
	});
});
