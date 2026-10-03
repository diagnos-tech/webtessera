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

// Package sqlite keeps a Tessera log in any SQLite database: node:sqlite, bun:sqlite,
// better-sqlite3, libSQL/Turso, rqlite, Cloudflare D1, SQLite-backed Durable Objects or
// SQLite compiled to WebAssembly, each through a small adapter. Published as
// `webtessera/storage/sqlite`. See docs/decisions/0154-sqlite-public-api.md.

export {
	type D1DatabaseLike,
	type D1PreparedStatementLike,
	fromD1,
} from "./adapters/d1.ts";
export {
	type DurableObjectSqlCursorLike,
	type DurableObjectSqlStorageLike,
	type DurableObjectStorageLike,
	fromDurableObjectStorage,
} from "./adapters/durableobject.ts";
export {
	fromLibsql,
	type LibsqlClientLike,
	type LibsqlResultSetLike,
	type LibsqlStatementLike,
} from "./adapters/libsql.ts";
export { fromRqlite, type RqliteOptions, type RqliteReadLevel } from "./adapters/rqlite.ts";
export { fromSqliteSync, type SqliteSyncDatabase, type SqliteSyncStatement } from "./adapters/sync.ts";
export { fromSqliteWasm, type SqliteWasmDatabaseLike, type SqliteWasmExecOptions } from "./adapters/wasm.ts";
export type { SqlDatabase, SqliteLocking, SqlRow, SqlStatement, SqlValue } from "./database.ts";
export { ErrLeaseLost } from "./lease.ts";
export { SchemaVersion } from "./schema.ts";
export {
	DefaultMaxChunkBytes,
	newSqliteDriver,
	openSqliteObjectStore,
	type SqliteDriverConfig,
	type SqliteLeaseOptions,
	type SqliteObjectStore,
	type SqliteObjectStoreOptions,
} from "./sqlite.ts";
