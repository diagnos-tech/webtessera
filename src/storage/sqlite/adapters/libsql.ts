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
// docs/decisions/0150-sqlite-object-store.md.

import type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from "../database.ts";
import { memoize, normalizeValue } from "./normalize.ts";

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
 * A remote database (`libsql:`, `https:`, `wss:` URLs) is shared by every client of the
 * server, so stores over one default to "lease" locking; stores over a local `file:`
 * database default to "local". Leases are timed by the database's clock: a libSQL server
 * runs every write on its primary and replicates the resulting pages, not the
 * statements, so the clock is read once. A batch runs as one "write" transaction, and a
 * write resolves once the server, or the local database, has committed it.
 *
 * Calling it again with the same client returns the same SqlDatabase, so that every
 * store over the client shares its locks. The client stays the caller's to close.
 */
export function fromLibsql(client: LibsqlClientLike): SqlDatabase {
	return memoize(databases, client, () => {
		const statement = (s: SqlStatement): LibsqlStatementLike => ({ sql: s.sql, args: [...s.params] });
		return {
			defaultLocking: client.protocol === "file" ? "local" : "lease",
			leaseClock: "database",
			query: async (s) => rowsOf(await client.execute(statement(s))),
			batch: async (statements) => (await client.batch(statements.map(statement), "write")).map(rowsOf),
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
