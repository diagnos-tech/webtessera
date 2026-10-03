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

// Runs the SQLite ObjectStore on libSQL through @libsql/client, in memory and in a local
// file, with local and with lease locking.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Client, createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { describeObjectStoreConformance } from "../../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../../objectstore/testing/driver_conformance.ts";
import type { SqlDatabase } from "../database.ts";
import { describeSqliteBehaviour } from "../testing/behaviour.ts";
import { otherProcess, type StoreTarget, storeFactory } from "../testing/stores.ts";
import { D1Limits, StrictSqlDatabase } from "../testing/strict.ts";
import { fromLibsql, type LibsqlClientLike } from "./libsql.ts";

const dir = mkdtempSync(`${tmpdir()}/webtessera-libsql-`);
const clients: Client[] = [];

afterAll(() => {
	for (const c of clients.splice(0)) {
		c.close();
	}
	rmSync(dir, { recursive: true, force: true });
});

function client(url: string): Client {
	const c = createClient({ url });
	clients.push(c);
	return c;
}

let files = 0;
const fileOf = new WeakMap<SqlDatabase, string>();

const memory = (): StoreTarget => ({ database: fromLibsql(client(":memory:")) });
const file = (): StoreTarget => {
	const url = `file:${dir}/log-${++files}.db`;
	const database = fromLibsql(client(url));
	fileOf.set(database, url);
	return { database };
};
// secondClient opens another client on the same file, as a second process would.
const secondClient = (db: SqlDatabase): SqlDatabase => fromLibsql(client(fileOf.get(db) ?? ":memory:"));

for (const [name, f] of [
	["libSQL in memory", storeFactory(memory)],
	["libSQL file", storeFactory(file)],
	[
		"libSQL file, lease locking, second store on a second client",
		storeFactory(file, { locking: "lease" }, secondClient),
	],
	[
		"libSQL in memory, D1 limits, lease locking",
		storeFactory(
			() => ({ database: new StrictSqlDatabase(fromLibsql(client(":memory:")), D1Limits) }),
			{
				locking: "lease",
			},
			otherProcess,
		),
	],
] as const) {
	describeObjectStoreConformance(`SqliteObjectStore (${name})`, f.newStore);
	describeDriverConformance(`SqliteObjectStore (${name})`, f.newStore, { reopen: f.reopen });
}

describeSqliteBehaviour("libSQL", memory);
describeSqliteBehaviour("libSQL file, lease locking", file, { locking: "lease" });

describe("fromLibsql", () => {
	it("accepts @libsql/client's Client as it is", () => {
		// The assertion that matters is the assignment, checked by tsc against @libsql/client's types.
		const like: LibsqlClientLike = client(":memory:");
		expect(like.protocol).toBe("file");
	});

	it("defaults to local locking for a local database, and lease locking for a remote one", () => {
		expect(fromLibsql(client(":memory:")).defaultLocking).toBe("local");
		const remote: LibsqlClientLike = {
			protocol: "https",
			execute: () => Promise.reject(new Error("not connected")),
			batch: () => Promise.reject(new Error("not connected")),
		};
		expect(fromLibsql(remote).defaultLocking).toBe("lease");
		expect(fromLibsql(remote).leaseClock).toBe("database");
	});

	it("returns one SqlDatabase per client", () => {
		const c = client(":memory:");
		expect(fromLibsql(c)).toBe(fromLibsql(c));
	});
});
