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

// This file has no upstream counterpart. It is what the adapters for in-process SQLite
// engines share: node:sqlite, bun:sqlite and better-sqlite3 (./sync.ts) and SQLite
// compiled to WebAssembly (./wasm.ts) all run statements synchronously on one connection
// the caller opened. See docs/decisions/0153-sqlite-durability.md.

import type { SqlDatabase, SqliteLocking, SqlRow, SqlValue } from "../database.ts";
import { asInteger } from "../values.ts";
import { normalizeRow } from "./normalize.ts";

/** runFunc runs one statement synchronously and returns its rows as objects keyed by column name. */
export type runFunc = (sql: string, params: readonly SqlValue[]) => unknown[];

/**
 * DefaultBusyTimeoutMs is the busy timeout an in-process adapter sets on a connection
 * that has none, so that a write waits this long for another process's write lock
 * instead of failing at once with SQLITE_BUSY.
 */
export const DefaultBusyTimeoutMs = 5000;

/**
 * newSyncDatabase returns a SqlDatabase over a synchronous engine, after making the
 * connection safe for a log:
 *
 *   - `PRAGMA synchronous` is raised to FULL if it is lower, so that a committed batch has
 *     reached stable storage, in rollback-journal and WAL mode alike, by the time it
 *     resolves. better-sqlite3, for one, builds SQLite with WAL commits at NORMAL, which
 *     can lose the latest commits on power loss.
 *   - `PRAGMA busy_timeout` is set to DefaultBusyTimeoutMs if it is 0, SQLite's default.
 *
 * Both settings belong to the connection and are not persisted; the journal mode, which
 * is persisted and affects every user of the file, is left alone.
 *
 * A batch is BEGIN IMMEDIATE ... COMMIT. Running it synchronously means nothing else in
 * this realm can interleave with it, and IMMEDIATE takes the write lock up front, so a
 * batch never fails half-way to upgrade a read lock that another process's write blocks.
 * The connection must not be inside a transaction of the caller's when a store uses it.
 *
 * Leases are timed by SQLite's clock, which for an in-process engine is the machine's:
 * the one clock every process sharing a database file on it reads.
 */
export function newSyncDatabase(run: runFunc, defaultLocking: SqliteLocking = "local"): SqlDatabase {
	const rows = (sql: string, params: readonly SqlValue[]): SqlRow[] => run(sql, params).map(normalizeRow);
	if (asInteger(rows("PRAGMA synchronous", [])[0]?.synchronous, "PRAGMA synchronous") < 2) {
		run("PRAGMA synchronous = FULL", []);
	}
	if (asInteger(rows("PRAGMA busy_timeout", [])[0]?.timeout, "PRAGMA busy_timeout") === 0) {
		run(`PRAGMA busy_timeout = ${DefaultBusyTimeoutMs}`, []);
	}

	return {
		defaultLocking,
		leaseClock: "database",
		query: async (s) => rows(s.sql, s.params),
		batch: async (statements) => {
			run("BEGIN IMMEDIATE", []);
			try {
				const out = statements.map((s) => rows(s.sql, s.params));
				run("COMMIT", []);
				return out;
			} catch (err) {
				try {
					run("ROLLBACK", []);
				} catch {
					// Some failures (SQLITE_FULL, SQLITE_IOERR) roll the transaction back
					// themselves, leaving nothing to roll back.
				}
				throw err;
			}
		},
	};
}
