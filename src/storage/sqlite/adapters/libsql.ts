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

// This file has no upstream counterpart. It adapts a libSQL client (@libsql/client),
// local or remote (sqld, Turso), to SqlDatabase. See
// docs/decisions/0150-sqlite-object-store.md and
// docs/decisions/0210-sqlite-locking-fails-closed.md.

import { isBusy } from "../busy.ts";
import type { SqlDatabase, SqliteLocking, SqlRow, SqlStatement, SqlValue } from "../database.ts";
import { memoize, normalizeValue } from "./normalize.ts";
import { DefaultBusyTimeoutMs, mainDatabaseLocking } from "./syncengine.ts";

/** LibsqlStatementLike is the statement shape fromLibsql passes to the client. */
export interface LibsqlStatementLike {
	readonly sql: string;
	readonly args: SqlValue[];
}

/** LibsqlResultSetLike is the part of libSQL's ResultSet fromLibsql reads. */
export interface LibsqlResultSetLike {
	readonly columns: readonly string[];
	readonly rows: readonly ArrayLike<unknown>[];
}

/**
 * LibsqlClientLike is the part of libSQL's Client fromLibsql uses. It is declared
 * structurally, so that this package does not depend on @libsql/client: the client
 * `createClient(...)` returns satisfies it, whatever its URL scheme.
 */
export interface LibsqlClientLike {
	/** protocol is the scheme the client connects with: "file" for a local database. */
	readonly protocol: string;
	execute(statement: LibsqlStatementLike): Promise<LibsqlResultSetLike>;
	batch(statements: LibsqlStatementLike[], mode: "write"): Promise<LibsqlResultSetLike[]>;
}

const databases = new WeakMap<LibsqlClientLike, SqlDatabase>();

/**
 * fromLibsql adapts a libSQL client to the SqlDatabase the SQLite ObjectStore runs on:
 *
 *	const client = createClient({ url: "libsql://my-db.turso.io", authToken });
 *	const driver = await newSqliteDriver({ database: fromLibsql(client) });
 *
 * Locking fails closed. Stores default to "lease" locking, which excludes every client of
 * the database, for a remote database (`libsql:`, `https:`, `wss:` URLs), which every
 * client of the server shares, for a local `file:` database, which other processes may
 * open, and for an embedded replica (a `file:` URL with a `syncUrl`), whose writes go to
 * its remote primary. Only an in-memory database, which the adapter recognises by asking
 * it, defaults to "local".
 *
 * Leases are timed by the database's clock: a libSQL server runs every write on its
 * primary and replicates the resulting pages, not the statements, so the clock is read
 * once. A batch runs as one "write" transaction, and a write resolves once the server, or
 * the local database, has committed it. An embedded replica answers reads from its local
 * copy, which lags writes made through other clients, so it is not a safe home for a log
 * that more than one client writes, with any locking: see
 * docs/decisions/0153-sqlite-durability.md.
 *
 * A local database is shared with other processes only as safely as its connections wait
 * for each other's locks. Unlike the in-process adapters, this one cannot give them a busy
 * timeout: the client keeps a pool of connections, and a `PRAGMA busy_timeout` would
 * reach only one of them. Create a client whose file other processes or clients also
 * open with the client's own `timeout` option, which every connection gets:
 *
 *	const client = createClient({ url: "file:log.db", timeout: 5000 });
 *
 * Without one, a write that meets another connection's lock fails at once with
 * SQLITE_BUSY (the log is never forked); the error then says so.
 *
 * Calling it again with the same client returns the same SqlDatabase. The client stays
 * the caller's to close.
 */
export function fromLibsql(client: LibsqlClientLike): SqlDatabase {
	return memoize(databases, client, () => {
		const statement = (s: SqlStatement): LibsqlStatementLike => ({ sql: s.sql, args: [...s.params] });
		// busyTimeout is the client's busy timeout, read the first time a local database
		// reports SQLITE_BUSY. The client gives every connection in its pool the same one.
		let busyTimeout: Promise<number> | undefined;
		const explainBusy = async (err: unknown): Promise<never> => {
			if (client.protocol === "file" && isBusy(err)) {
				busyTimeout ??= client.execute({ sql: "PRAGMA busy_timeout", args: [] }).then(
					(rs) => Number(rowsOf(rs)[0]?.timeout ?? 0),
					() => -1,
				);
				if ((await busyTimeout) === 0) {
					throw new Error(
						`${err instanceof Error ? err.message : String(err)} (this libSQL client has no busy timeout, so a write that meets another connection's lock fails at once: when other processes or clients open the same file, create it with one, as createClient({ url, timeout: ${DefaultBusyTimeoutMs} }))`,
						{ cause: err },
					);
				}
			}
			throw err;
		};
		const query = async (s: SqlStatement): Promise<SqlRow[]> => {
			try {
				return rowsOf(await client.execute(statement(s)));
			} catch (err) {
				return explainBusy(err);
			}
		};
		return {
			// A client's protocol says only how it connects: "file" is a local database or an
			// embedded replica alike, so the database is asked what it is.
			defaultLocking:
				client.protocol === "file"
					? async (): Promise<SqliteLocking> =>
							mainDatabaseLocking(await query({ sql: "PRAGMA database_list", params: [] }))
					: "lease",
			leaseClock: "database",
			query,
			batch: async (statements) => {
				try {
					return (await client.batch(statements.map(statement), "write")).map(rowsOf);
				} catch (err) {
					return explainBusy(err);
				}
			},
		};
	});
}

/** rowsOf returns a result set's rows as SqlRows. libSQL rows are array-like, in column order. */
function rowsOf(rs: LibsqlResultSetLike): SqlRow[] {
	return rs.rows.map((row) => {
		const out: Record<string, SqlValue> = {};
		for (const [i, column] of rs.columns.entries()) {
			out[column] = normalizeValue(row[i]);
		}
		return out;
	});
}
