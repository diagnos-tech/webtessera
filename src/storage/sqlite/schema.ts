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

// This file has no upstream counterpart. It owns the SQLite ObjectStore's tables: their
// names, their definitions, and the versioning that lets a later webtessera change them
// without stranding logs written by an earlier one. See
// docs/decisions/0151-sqlite-schema-and-chunking.md.

import type { SqlDatabase, SqlStatement } from "./database.ts";
import { asInteger } from "./values.ts";

/**
 * Tables names the tables of one store's namespace.
 *
 * - meta holds named integers, of which `schema_version` is the version of the other
 *   tables. Its definition is frozen forever, so that any webtessera can read the version
 *   of tables written by any other.
 * - objects holds one row per object: its size, its modification time in milliseconds
 *   since the Unix epoch, and its first maxChunkBytes bytes.
 * - chunks holds the rest of each larger object, in rows numbered from 1.
 * - locks holds the leases behind lease-mode locks: who holds each lock and until when.
 * - fence never holds a row. A batch inserts into it, and so fails on its CHECK
 *   constraint, exactly when a lease the batch is fenced on has been lost (./lease.ts).
 */
export interface Tables {
	readonly meta: string;
	readonly objects: string;
	readonly chunks: string;
	readonly locks: string;
	readonly fence: string;
}

/**
 * leaseLostConstraint names the fence table's CHECK constraint. SQLite names it in the
 * error a fenced-out batch fails with, which is how that error is recognised.
 */
export const leaseLostConstraint = "webtessera_lease_lost";

/**
 * Migration upgrades a namespace's tables by one schema version. Its statements run in
 * one batch together with the version bump; they must be safe to run against tables
 * another opener has already upgraded (IF NOT EXISTS, and the like), since two stores
 * may open the same outdated namespace at once.
 */
export type Migration = (t: Tables) => SqlStatement[];

/**
 * schemaMigrations upgrades tables of version i+1 to version i+2 at index i. Adding a
 * schema version means appending one; never edit or remove an existing one.
 */
const schemaMigrations: readonly Migration[] = [];

/** SchemaVersion is the version of the tables this code creates and expects. */
export const SchemaVersion = 1 + schemaMigrations.length;

const namespacePattern = /^[a-z0-9_]{1,64}$/;

/**
 * tableNames returns the names of the tables of namespace: `webtessera_<table>`, or
 * `webtessera_<namespace>_<table>` when namespace is given.
 *
 * A namespace is lowercase because SQLite compares table names case-insensitively. No
 * table suffix contains an underscore, so distinct namespaces can never produce the same
 * table name.
 */
export function tableNames(namespace?: string): Tables {
	if (namespace !== undefined && !namespacePattern.test(namespace)) {
		throw new RangeError(
			`sqlite: namespace ${JSON.stringify(namespace)} must be 1 to 64 lowercase letters, digits and underscores`,
		);
	}
	const p = namespace === undefined ? "webtessera_" : `webtessera_${namespace}_`;
	return { meta: `${p}meta`, objects: `${p}objects`, chunks: `${p}chunks`, locks: `${p}locks`, fence: `${p}fence` };
}

/**
 * ensureSchema creates the tables of t if they do not exist, upgrades them if an earlier
 * webtessera created them, and fails if a later one did.
 *
 * Every step is idempotent, so any number of stores may open one namespace concurrently.
 *
 * @internal migrations is replaceable for tests only.
 */
export async function ensureSchema(
	db: SqlDatabase,
	t: Tables,
	signal?: AbortSignal,
	migrations: readonly Migration[] = schemaMigrations,
): Promise<void> {
	const want = 1 + migrations.length;
	signal?.throwIfAborted();
	await db.query({
		sql: `CREATE TABLE IF NOT EXISTS ${t.meta} (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
		params: [],
	});
	let version = await readVersion(db, t);
	if (version === undefined) {
		signal?.throwIfAborted();
		await db.batch(createVersion1(t));
		version = (await readVersion(db, t)) ?? 0;
	}
	while (version < want) {
		signal?.throwIfAborted();
		const from = version;
		const step = migrations[from - 1];
		if (step === undefined) {
			throw new Error(`sqlite: ${t.meta} records schema version ${from}, which no migration upgrades`);
		}
		try {
			await db.batch([
				...step(t),
				{ sql: `UPDATE ${t.meta} SET value = ? WHERE name = 'schema_version' AND value = ?`, params: [from + 1, from] },
			]);
		} catch (err) {
			// Another store may have run this step first, making it fail here; carry on
			// from wherever that left the version.
			version = (await readVersion(db, t)) ?? 0;
			if (version > from) {
				continue;
			}
			throw new Error(`sqlite: upgrading ${t.objects} from schema version ${from}`, { cause: err });
		}
		version = (await readVersion(db, t)) ?? 0;
	}
	if (version > want) {
		throw new Error(
			`sqlite: the tables of ${t.objects} have schema version ${version}, written by a newer webtessera; ` +
				`this version supports schema version ${want} and earlier`,
		);
	}
}

/** readVersion returns the schema version recorded in t.meta, or undefined if none is. */
async function readVersion(db: SqlDatabase, t: Tables): Promise<number | undefined> {
	const rows = await db.query({ sql: `SELECT value FROM ${t.meta} WHERE name = 'schema_version'`, params: [] });
	const row = rows[0];
	return row === undefined ? undefined : asInteger(row.value, `${t.meta}.value`);
}

/** createVersion1 returns the statements that create the tables at schema version 1. */
function createVersion1(t: Tables): SqlStatement[] {
	return [
		`CREATE TABLE IF NOT EXISTS ${t.objects} (
			key TEXT PRIMARY KEY,
			size INTEGER NOT NULL,
			mod_time INTEGER NOT NULL,
			data BLOB NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS ${t.chunks} (
			key TEXT NOT NULL,
			seq INTEGER NOT NULL,
			data BLOB NOT NULL,
			PRIMARY KEY (key, seq)
		)`,
		`CREATE TABLE IF NOT EXISTS ${t.locks} (
			name TEXT PRIMARY KEY,
			holder TEXT NOT NULL,
			expires INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS ${t.fence} (
			lost INTEGER,
			CONSTRAINT ${leaseLostConstraint} CHECK (lost IS NULL)
		)`,
		`INSERT OR IGNORE INTO ${t.meta} (name, value) VALUES ('schema_version', 1)`,
	].map((sql) => ({ sql, params: [] }));
}
