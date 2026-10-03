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

// This file has no upstream counterpart. It adapts a Cloudflare D1 database binding to
// SqlDatabase. See docs/decisions/0150-sqlite-object-store.md.

import type { SqlDatabase, SqlStatement, SqlValue } from "../database.ts";
import { normalizeRow } from "./normalize.ts";

/** D1PreparedStatementLike is the part of D1's D1PreparedStatement fromD1 uses. */
export interface D1PreparedStatementLike {
	bind(...values: unknown[]): D1PreparedStatementLike;
	all(): Promise<{ readonly results: readonly unknown[] }>;
}

/**
 * D1DatabaseLike is the part of D1's D1Database fromD1 uses. It is declared structurally,
 * so that this package does not depend on @cloudflare/workers-types: a Worker passes the
 * binding (`env.DB`) as it is.
 */
export interface D1DatabaseLike {
	prepare(query: string): D1PreparedStatementLike;
	batch(statements: D1PreparedStatementLike[]): Promise<readonly { readonly results: readonly unknown[] }[]>;
}

/**
 * fromD1 adapts a Cloudflare D1 database binding to the SqlDatabase the SQLite
 * ObjectStore runs on:
 *
 *	const driver = await newSqliteDriver({ database: fromD1(env.DB) });
 *
 * A D1 database is reached from every isolate of every Worker bound to it, so stores
 * default to "lease" locking, timed by the database's clock: every statement runs on the
 * database's single primary, whose clock all contenders therefore share. A query or
 * batch resolves once D1 has committed it, which D1 does durably before answering; a
 * batch is one transaction.
 *
 * D1's limits apply: rows and BLOBs of at most 2,000,000 bytes (the default
 * maxChunkBytes respects it), 100 bound parameters per statement, and a cap on queries
 * per Worker invocation (each statement of a batch counts). Several logs may share one
 * database under distinct namespaces.
 */
export function fromD1(db: D1DatabaseLike): SqlDatabase {
	const prepare = (s: SqlStatement): D1PreparedStatementLike => db.prepare(s.sql).bind(...s.params.map(bindValue));
	return {
		defaultLocking: "lease",
		leaseClock: "database",
		query: async (s) => (await prepare(s).all()).results.map(normalizeRow),
		batch: async (statements) => (await db.batch(statements.map(prepare))).map((r) => r.results.map(normalizeRow)),
	};
}

/**
 * bindValue converts v for D1, which binds an ArrayBuffer as a BLOB. A view is copied
 * into a buffer of its own, so that only its bytes are sent.
 */
function bindValue(v: SqlValue): unknown {
	return v instanceof Uint8Array ? v.slice().buffer : v;
}
