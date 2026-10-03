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

// This file has no upstream counterpart. It adapts the SQL API of a SQLite-backed
// Cloudflare Durable Object to SqlDatabase. See docs/decisions/0150-sqlite-object-store.md
// and docs/decisions/0153-sqlite-durability.md.

import type { SqlDatabase, SqlStatement, SqlValue } from "../database.ts";
import { memoize, normalizeRow } from "./normalize.ts";

/** DurableObjectSqlCursorLike is the part of the runtime's SqlStorageCursor fromDurableObjectStorage uses. */
export interface DurableObjectSqlCursorLike {
	toArray(): unknown[];
}

/** DurableObjectSqlStorageLike is the part of the runtime's SqlStorage (`ctx.storage.sql`) fromDurableObjectStorage uses. */
export interface DurableObjectSqlStorageLike {
	exec(query: string, ...bindings: unknown[]): DurableObjectSqlCursorLike;
}

/**
 * DurableObjectStorageLike is the part of a Durable Object's storage, `ctx.storage`,
 * fromDurableObjectStorage uses. It is declared structurally, so that this package does
 * not depend on @cloudflare/workers-types.
 */
export interface DurableObjectStorageLike {
	readonly sql: DurableObjectSqlStorageLike;
	transactionSync<T>(closure: () => T): T;
}

const databases = new WeakMap<DurableObjectStorageLike, SqlDatabase>();

/**
 * fromDurableObjectStorage adapts the storage of a SQLite-backed Durable Object,
 * `ctx.storage`, to the SqlDatabase the SQLite ObjectStore runs on:
 *
 *	const driver = await newSqliteDriver({ database: fromDurableObjectStorage(ctx.storage) });
 *
 * The runtime runs at most one instance of a Durable Object at a time, and only that
 * instance reaches its storage, so stores default to "local" locking. A batch runs in
 * `transactionSync`, since the SQL API forbids BEGIN and SAVEPOINT. Writes resolve once
 * committed to the object's database; the object's output gate then holds back every
 * response, fetch and RPC result until the write is durable, and resets the object if it
 * is not, so nothing outside the object ever observes a write that is later lost.
 *
 * The class must be declared under `new_sqlite_classes`: KV-backed objects have no SQL
 * API. Rows and BLOBs are limited to 2,000,000 bytes, which the default maxChunkBytes
 * respects. Calling it again with the same storage returns the same SqlDatabase.
 */
export function fromDurableObjectStorage(storage: DurableObjectStorageLike): SqlDatabase {
	return memoize(databases, storage, () => {
		const rows = (s: SqlStatement) =>
			storage.sql
				.exec(s.sql, ...s.params.map(bindValue))
				.toArray()
				.map(normalizeRow);
		return {
			defaultLocking: "local",
			leaseClock: "database",
			query: async (s) => rows(s),
			batch: async (statements) => storage.transactionSync(() => statements.map(rows)),
		};
	});
}

/**
 * bindValue converts v for the SQL API, which binds an ArrayBuffer as a BLOB. A view is
 * copied into a buffer of its own, so that only its bytes are stored.
 */
function bindValue(v: SqlValue): unknown {
	return v instanceof Uint8Array ? v.slice().buffer : v;
}
