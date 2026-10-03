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

// This file has no upstream counterpart. It adapts the official build of SQLite compiled
// to WebAssembly (@sqlite.org/sqlite-wasm), through its "OO1" object-oriented API, to
// SqlDatabase. See docs/decisions/0150-sqlite-object-store.md and
// docs/decisions/0152-sqlite-locking-local-and-lease.md.

import type { SqlDatabase, SqliteLocking, SqlValue } from "../database.ts";
import { memoize } from "./normalize.ts";
import { newSyncDatabase } from "./syncengine.ts";

/** SqliteWasmExecOptions is the form of `exec` options fromSqliteWasm uses. */
export interface SqliteWasmExecOptions {
	readonly sql: string;
	readonly bind: SqlValue[];
	readonly rowMode: "object";
	readonly returnValue: "resultRows";
}

/**
 * SqliteWasmDatabaseLike is the part of a `sqlite3.oo1.DB` fromSqliteWasm uses. It is
 * declared structurally, so that this package does not depend on @sqlite.org/sqlite-wasm:
 * a DB of any VFS satisfies it.
 */
export interface SqliteWasmDatabaseLike {
	exec(options: SqliteWasmExecOptions): unknown[];
	/** dbFilename returns the main database's file name: "" for an in-memory or temporary database. */
	dbFilename?(): string | null;
	/** dbVfsName returns the name of the main database's VFS. */
	dbVfsName?(): string | undefined;
}

// privateVfses are the VFSes whose databases no other tab or worker can open while this
// connection has them: "memdb" lives in this instance's memory, and the OPFS SAH pool
// holds its files exclusively.
const privateVfses = new Set(["memdb", "opfs-sahpool"]);

const databases = new WeakMap<SqliteWasmDatabaseLike, SqlDatabase>();

/**
 * fromSqliteWasm adapts a database opened with SQLite's WebAssembly build to the
 * SqlDatabase the SQLite ObjectStore runs on:
 *
 *	const sqlite3 = await sqlite3InitModule();
 *	const driver = await newSqliteDriver({ database: fromSqliteWasm(new sqlite3.oo1.OpfsDb("/log.db")) });
 *
 * Locking fails closed. Stores default to "local" locking, which excludes holders in
 * this tab or worker only, just for a database nothing else can open: one in memory, or
 * in the "memdb" or "opfs-sahpool" VFS. A database in any other VFS ("opfs", say) may be
 * opened by every tab and worker of the origin at once, so stores over it default to
 * "lease" locking, kept in the database itself, which excludes all of them; so does a DB
 * that cannot say what it is.
 *
 * Durability is the VFS's: an in-memory database has none, and an OPFS one is as durable
 * as the browser keeps the origin's storage. As for any in-process engine, it raises the
 * connection's `synchronous` setting to FULL and gives it a busy timeout (see
 * fromSqliteSync). Calling it again with the same DB returns the same SqlDatabase.
 */
export function fromSqliteWasm(db: SqliteWasmDatabaseLike): SqlDatabase {
	return memoize(databases, db, () =>
		newSyncDatabase(
			(sql, params) => db.exec({ sql, bind: [...params], rowMode: "object", returnValue: "resultRows" }),
			lockingFor(db),
		),
	);
}

/** lockingFor returns "local" if db is certainly private to this context, and "lease" otherwise. */
function lockingFor(db: SqliteWasmDatabaseLike): SqliteLocking {
	const file = db.dbFilename?.();
	const vfs = db.dbVfsName?.();
	return file === "" || (vfs !== undefined && privateVfses.has(vfs)) ? "local" : "lease";
}
