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

// The storage backends the interop harness runs, in both directions, against Tessera in Go:
// every ObjectStore backend that runs in Node on its own. Backends that only run in a browser or
// in workerd, and rqlite, which needs a server, are held to the same bytes by the golden
// compatibility suite instead (src/storage/objectstore/testing/golden.ts).
//
// Adding a backend is one entry: a name for the report, and an `open` that returns a fresh,
// empty store from the built package (dist/, imported by the package's own name so that the
// exports map is exercised too) together with a `close` that releases it. The harness never
// needs to list a store's keys: it records every key it writes, so `open` need not expose
// anything beyond the ObjectStore contract.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndexedDBObjectStore } from "webtessera/storage/indexeddb";
import { MemoryObjectStore } from "webtessera/storage/memory";
import { fromLibsql, fromSqliteSync, openSqliteObjectStore } from "webtessera/storage/sqlite";

let opened = 0;

/** @type {readonly { name: string, open: () => Promise<{ store: import("webtessera/storage/objectstore").ObjectStore, close: () => void | Promise<void> }> }[]} */
export const backends = [
	{ name: "memory", open: async () => ({ store: new MemoryObjectStore(), close: () => {} }) },
	{ name: "indexeddb (fake-indexeddb)", open: () => fakeIndexedDB() },
	{ name: "sqlite (node:sqlite)", open: () => nodeSqlite() },
	{ name: "sqlite (libSQL)", open: () => libsql() },
];

/**
 * fakeIndexedDB opens the IndexedDB store against a fresh fake-indexeddb factory, the Node
 * stand-in for one browser origin. Node has no Web Locks, so locks are the in-process fallback,
 * which is all a single harness process needs.
 */
async function fakeIndexedDB() {
	const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");
	const store = await openIndexedDBObjectStore({
		name: `interop-${++opened}`,
		indexedDB: new IDBFactory(),
		IDBKeyRange,
		locks: null,
	});
	return { store, close: () => store.close() };
}

/**
 * nodeSqlite opens the SQLite store in a fresh database file through Node's built-in
 * node:sqlite, the engine a Node server would use. A file rather than ":memory:" so that the
 * store runs exactly as it would on disk.
 */
async function nodeSqlite() {
	const { DatabaseSync } = await import("node:sqlite");
	const dir = mkdtempSync(join(tmpdir(), "webtessera-interop-sqlite-"));
	const db = new DatabaseSync(join(dir, "log.db"));
	const store = await openSqliteObjectStore({ database: fromSqliteSync(db) });
	return {
		store,
		close: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** libsql opens the SQLite store in a fresh local database file through the libSQL client. */
async function libsql() {
	const { createClient } = await import("@libsql/client");
	const dir = mkdtempSync(join(tmpdir(), "webtessera-interop-libsql-"));
	const client = createClient({ url: `file:${join(dir, "log.db")}` });
	const store = await openSqliteObjectStore({ database: fromLibsql(client) });
	return {
		store,
		close: () => {
			client.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
