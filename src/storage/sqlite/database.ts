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

// This file has no upstream counterpart. It defines the one interface through which the
// SQLite ObjectStore reaches a database, whichever engine runs it: an in-process SQLite
// (node:sqlite, bun:sqlite, better-sqlite3, SQLite compiled to WebAssembly), a SQLite-backed
// Durable Object, or a remote one (libSQL/Turso, rqlite, Cloudflare D1). See
// docs/decisions/0150-sqlite-object-store.md.

/**
 * SqlValue is a value bound to, or read from, a SQL statement.
 *
 * Integers may be read back as number or bigint, depending on the engine and its
 * configuration; BLOBs are always Uint8Array. Adapters convert whatever else their engine
 * produces (an ArrayBuffer, base64 text) into these.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * SqlStatement is one SQL statement and the values of its parameters.
 *
 * Parameters are anonymous `?` placeholders, bound in order. That is the one placeholder
 * syntax every engine accepts: better-sqlite3, for one, treats `?NNN` as a named parameter.
 */
export interface SqlStatement {
	readonly sql: string;
	readonly params: readonly SqlValue[];
}

/** SqlRow is one row of a result, keyed by column name. */
export type SqlRow = Readonly<Record<string, SqlValue>>;

/**
 * SqliteLocking selects how a SQLite ObjectStore implements ObjectStore.lock.
 *
 * "lease" locks are rows in the database, held for a bounded time and renewed while held,
 * so they exclude every connection, process, isolate or machine that reaches the database,
 * and every write made while one is held is fenced on it still being held. They are right
 * for every database, and are what stores use unless the adapter can show that nothing
 * outside this JavaScript realm can reach the database (see SqlDatabase.defaultLocking).
 *
 * "local" locks are held in memory and exclude only the stores of this realm that use
 * the same database. Choosing them is the caller's declaration that this realm is the
 * database's only writer, as IndexedDB's `singleWriter` is: a SQLite file that another
 * process, or another connection that is not a store of this realm, also writes is then
 * forked the first time two writers append at once. They suit a database that is private
 * by construction: an in-memory or temporary database, a Durable Object's (the runtime runs
 * one instance of it at a time), or a WebAssembly SQLite in a VFS that holds its files
 * exclusively. They save the lease's writes, and nothing else.
 *
 * Every store over one database must use the same locking: local locks and leases do not
 * see each other.
 */
export type SqliteLocking = "local" | "lease";

/**
 * SqlDatabase is the minimal, engine-neutral interface the SQLite ObjectStore needs from a
 * database. The adapters in ./adapters implement it, each in a few lines, for the common
 * engines; anything else that runs SQLite's SQL dialect can implement it too.
 *
 * Statements use SQL that SQLite 3.35 and later understand (they use RETURNING), and never contain
 * transaction control (BEGIN, COMMIT, SAVEPOINT): grouping statements atomically is
 * batch's job, which lets engines that forbid explicit transactions (D1, Durable Objects)
 * provide it their own way.
 *
 * With "local" locking, every store of this realm over the same database shares one set of
 * in-process locks, whichever SqlDatabase it was opened through: the database itself
 * records a random identity that they all read (see openSqliteObjectStore).
 */
export interface SqlDatabase {
	/**
	 * query runs a single statement and resolves to the rows it returns, which is none
	 * for a statement that is not a query. A single statement is atomic in SQLite, and
	 * a query reads one consistent snapshot of the database.
	 */
	query(statement: SqlStatement): Promise<SqlRow[]>;

	/**
	 * batch runs statements in order as a single transaction, and resolves to the rows
	 * each one returns, once the transaction has committed. If any statement fails,
	 * batch rejects and none of them takes effect.
	 */
	batch(statements: readonly SqlStatement[]): Promise<SqlRow[][]>;

	/**
	 * defaultLocking is the locking stores use over this database when their options do
	 * not choose one. Locking fails closed: it is "lease" if this is undefined, and an
	 * adapter sets it to "local" only for a database it can show nothing outside this
	 * realm can reach, such as one in memory. An adapter that has to ask the database
	 * makes it a function, which each store opened over the database calls once.
	 */
	readonly defaultLocking?: SqliteLocking | (() => Promise<SqliteLocking>) | undefined;

	/**
	 * leaseClock says where "lease" locking reads the time that lease expiries are set
	 * from and compared with, unless the store's options supply a clock of their own.
	 *
	 * "database" is SQLite's own clock, read with julianday('now') inside the statements
	 * that take and renew a lease, so that every contender measures expiry on the same
	 * clock. An adapter chooses it only where every client shares the engine's clock and
	 * the engine evaluates the function once, where the transaction commits, rather than
	 * again on each replica. "client", the default, is the store's own clock, Date.now,
	 * bound as a parameter.
	 */
	readonly leaseClock?: "database" | "client" | undefined;
}
