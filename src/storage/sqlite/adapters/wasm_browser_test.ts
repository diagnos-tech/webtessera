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

// Runs the SQLite ObjectStore in Chromium on the official WebAssembly build of SQLite,
// through its OO1 API, on in-memory databases.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { describeObjectStoreConformance } from "../../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../../objectstore/testing/driver_conformance.ts";
import { openSqliteObjectStore } from "../sqlite.ts";
import { describeSqliteBehaviour } from "../testing/behaviour.ts";
import { otherProcess, type StoreTarget, storeFactory } from "../testing/stores.ts";
import { D1Limits, StrictSqlDatabase } from "../testing/strict.ts";
import { fromSqliteWasm, type SqliteWasmDatabaseLike } from "./wasm.ts";

const sqlite3 = await sqlite3InitModule();

const memory = (): StoreTarget => ({ database: fromSqliteWasm(new sqlite3.oo1.DB(":memory:")) });

for (const [name, f] of [
	["sqlite-wasm in memory", storeFactory(memory)],
	["sqlite-wasm in memory, lease locking", storeFactory(memory, { locking: "lease" }, otherProcess)],
	[
		"sqlite-wasm in memory, 4 KiB chunks, D1 limits",
		storeFactory(() => ({ database: new StrictSqlDatabase(memory().database, D1Limits) }), { maxChunkBytes: 4096 }),
	],
] as const) {
	describeObjectStoreConformance(`SqliteObjectStore (${name})`, f.newStore);
	describeDriverConformance(`SqliteObjectStore (${name})`, f.newStore, { reopen: f.reopen });
}

describeSqliteBehaviour("sqlite-wasm", memory);

describe("fromSqliteWasm", () => {
	it("accepts an OO1 DB as it is, and returns one SqlDatabase per DB", () => {
		// The assertion that matters is the assignment, checked by tsc against sqlite-wasm's types.
		const db = new sqlite3.oo1.DB(":memory:");
		const like: SqliteWasmDatabaseLike = db;
		expect(fromSqliteWasm(like)).toBe(fromSqliteWasm(db));
	});

	it("raises synchronous to FULL", () => {
		const db = new sqlite3.oo1.DB(":memory:");
		db.exec("PRAGMA synchronous = OFF");
		fromSqliteWasm(db);
		expect(db.selectValue("PRAGMA synchronous")).toBe(2);
	});

	it("uses local locks only for a database no other tab or worker can open", async () => {
		expect(fromSqliteWasm(new sqlite3.oo1.DB(":memory:")).defaultLocking).toBe("local");
		expect(fromSqliteWasm(new sqlite3.oo1.DB("file:/log.db?vfs=memdb")).defaultLocking).toBe("local");
		// kvvfs keeps the database in Web Storage, which other contexts of the origin can reach.
		const shared = new sqlite3.oo1.JsStorageDb("session");
		expect(fromSqliteWasm(shared).defaultLocking).toBe("lease");
		expect((await openSqliteObjectStore({ database: fromSqliteWasm(shared) })).locking).toBe("lease");
		// A DB that cannot say where it lives is treated as shared.
		const opaque: SqliteWasmDatabaseLike = { exec: (o) => new sqlite3.oo1.DB(":memory:").exec(o) };
		expect(fromSqliteWasm(opaque).defaultLocking).toBe("lease");
	});
});
