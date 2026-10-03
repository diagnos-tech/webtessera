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

// Runs the golden compatibility suite (../objectstore/testing/golden.ts) over the SQLite
// ObjectStore on the engines Node runs: every log_<N> fixture Tessera's POSIX driver wrote
// must come out of SQLite byte for byte, and Go-written logs loaded into it must carry on.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { type Client, createClient } from "@libsql/client";
import { afterAll } from "vitest";
import { describeGoldenCompatibility } from "../objectstore/testing/golden.ts";
import { fromLibsql } from "./adapters/libsql.ts";
import { fromRqlite } from "./adapters/rqlite.ts";
import { fromSqliteSync } from "./adapters/sync.ts";
import type { SqlDatabase } from "./database.ts";
import { newFakeRqlite } from "./testing/fake_rqlite.ts";
import { type StoreFactory, storeFactory } from "./testing/stores.ts";
import { D1Limits, StrictSqlDatabase } from "./testing/strict.ts";

const dir = mkdtempSync(`${tmpdir()}/webtessera-sqlite-golden-`);
const closers: (() => void)[] = [];

afterAll(() => {
	for (const close of closers.splice(0)) {
		close();
	}
	rmSync(dir, { recursive: true, force: true });
});

function connect(path: string): DatabaseSync {
	const c = new DatabaseSync(path);
	closers.push(() => c.close());
	return c;
}

function libsql(url: string): Client {
	const c = createClient({ url });
	closers.push(() => c.close());
	return c;
}

let files = 0;
const pathOf = new WeakMap<SqlDatabase, string>();

/** fileDatabase opens a new SQLite file through open, remembering its path for reopen. */
function fileDatabase(open: (path: string) => SqlDatabase): () => { database: SqlDatabase } {
	return () => {
		const path = `${dir}/golden-${++files}.db`;
		const database = open(path);
		pathOf.set(database, path);
		return { database };
	};
}

/** secondHandle reopens db's file through open, as a second process would. */
function secondHandle(open: (path: string) => SqlDatabase): (db: SqlDatabase) => SqlDatabase {
	return (db) => open(pathOf.get(db) ?? ":memory:");
}

const nodeFile = (path: string) => fromSqliteSync(connect(path));
const libsqlFile = (path: string) => fromLibsql(libsql(`file:${path}`));

const variants: readonly [string, StoreFactory][] = [
	["node:sqlite in memory", storeFactory(() => ({ database: fromSqliteSync(connect(":memory:")) }))],
	[
		"node:sqlite file, lease locking, reopened on a second connection",
		storeFactory(fileDatabase(nodeFile), { locking: "lease" }, secondHandle(nodeFile)),
	],
	[
		"node:sqlite in memory, 4 KiB chunks, D1 limits",
		storeFactory(() => ({ database: new StrictSqlDatabase(fromSqliteSync(connect(":memory:")), D1Limits) }), {
			maxChunkBytes: 4096,
		}),
	],
	["libSQL file, reopened on a second client", storeFactory(fileDatabase(libsqlFile), {}, secondHandle(libsqlFile))],
	[
		"rqlite, fake node",
		storeFactory(() => ({
			database: fromRqlite({ url: "http://rqlite.test", fetch: newFakeRqlite(connect(":memory:")).fetch }),
		})),
	],
];

for (const [name, f] of variants) {
	describeGoldenCompatibility(`SqliteObjectStore (${name})`, f.newStore, { reopen: f.reopen, listKeys: f.listKeys });
}
