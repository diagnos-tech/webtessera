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

// This file has no upstream counterpart. It adapts the synchronous SQLite bindings of
// server runtimes, node:sqlite (Node.js and Deno), bun:sqlite and better-sqlite3, to
// SqlDatabase. See docs/decisions/0150-sqlite-object-store.md.

import type { SqlDatabase, SqlValue } from "../database.ts";
import { memoize } from "./normalize.ts";
import { newSyncDatabase } from "./syncengine.ts";

/**
 * SqliteSyncStatement is the part of a prepared statement fromSqliteSync uses: node:sqlite's
 * StatementSync, bun:sqlite's Statement and better-sqlite3's Statement all have it.
 */
export interface SqliteSyncStatement {
	/** all runs the statement with params bound to its `?` placeholders and returns its rows as objects. */
	all(...params: SqlValue[]): unknown[];
	/** run runs a statement that returns no rows. better-sqlite3 requires it for those. */
	run?(...params: SqlValue[]): unknown;
	/** reader is false, in better-sqlite3, for a statement that returns no rows. */
	readonly reader?: boolean;
}

/**
 * SqliteSyncDatabase is the part of a synchronous SQLite connection fromSqliteSync uses.
 * It is declared structurally, so that this package depends on none of the bindings:
 * `new DatabaseSync(path)` from node:sqlite, `new Database(path)` from bun:sqlite and
 * `new Database(path)` from better-sqlite3 all satisfy it.
 */
export interface SqliteSyncDatabase {
	prepare(sql: string): SqliteSyncStatement;
}

// maxCachedStatements bounds the prepared statements kept per connection. A store uses
// a few dozen distinct statements; the bound only matters to callers that share the
// connection with a store and prepare many statements of their own through it.
const maxCachedStatements = 256;

const databases = new WeakMap<SqliteSyncDatabase, SqlDatabase>();

/**
 * fromSqliteSync adapts a synchronous SQLite connection, from node:sqlite, bun:sqlite or
 * better-sqlite3, to the SqlDatabase the SQLite ObjectStore runs on:
 *
 *	import { DatabaseSync } from "node:sqlite";
 *	const driver = await newSqliteDriver({ database: fromSqliteSync(new DatabaseSync("log.db")) });
 *
 * It raises the connection's `synchronous` setting to FULL if it is lower, so that every
 * write has reached the disk when it resolves, and gives it a busy timeout if it has none.
 * Stores default to "local" locking, which excludes the other stores of this process;
 * choose "lease" locking when several processes open the same file.
 *
 * Calling it again with the same connection returns the same SqlDatabase, so that every
 * store over the connection shares its locks. The connection stays the caller's to close.
 */
export function fromSqliteSync(db: SqliteSyncDatabase): SqlDatabase {
	return memoize(databases, db, () => {
		const statements = new Map<string, SqliteSyncStatement>();
		return newSyncDatabase((sql, params) => {
			let stmt = statements.get(sql);
			if (stmt === undefined) {
				if (statements.size >= maxCachedStatements) {
					statements.clear();
				}
				stmt = db.prepare(sql);
				statements.set(sql, stmt);
			}
			if (stmt.reader === false && stmt.run !== undefined) {
				stmt.run(...params);
				return [];
			}
			return stmt.all(...params);
		});
	});
}
