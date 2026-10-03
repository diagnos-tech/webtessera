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

// Runs the SQLite ObjectStore on Cloudflare D1, as miniflare provides it inside workerd,
// with D1's default lease locking. Every store keeps its log in a namespace of its own in
// the one test database, which also exercises namespacing.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { describeObjectStoreConformance } from "../../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../../objectstore/testing/driver_conformance.ts";
import { openSqliteObjectStore } from "../sqlite.ts";
import { describeSqliteBehaviour } from "../testing/behaviour.ts";
import { appendConcurrently } from "../testing/concurrent.ts";
import { type StoreTarget, storeFactory, uniqueNamespace } from "../testing/stores.ts";
import { D1Limits, StrictSqlDatabase } from "../testing/strict.ts";
import { type D1DatabaseLike, fromD1 } from "./d1.ts";

// Each call returns a new SqlDatabase, sharing no in-process locks with any other, as the
// binding in another isolate would: lease locking alone keeps them apart.
const newTarget = (): StoreTarget => ({ database: fromD1(env.DB), namespace: uniqueNamespace() });
const strictTarget = (): StoreTarget => ({
	database: new StrictSqlDatabase(fromD1(env.DB), D1Limits),
	namespace: uniqueNamespace(),
});

for (const [name, f] of [
	["D1", storeFactory(newTarget, {}, () => fromD1(env.DB))],
	[
		"D1, 4 KiB chunks, D1 limits",
		storeFactory(strictTarget, { maxChunkBytes: 4096 }, () => new StrictSqlDatabase(fromD1(env.DB), D1Limits)),
	],
] as const) {
	describeObjectStoreConformance(`SqliteObjectStore (${name})`, f.newStore);
	describeDriverConformance(`SqliteObjectStore (${name})`, f.newStore, { reopen: f.reopen });
}

describeSqliteBehaviour("D1", newTarget);

describe("SqliteObjectStore (D1)", () => {
	it("accepts the runtime's D1Database as it is", () => {
		// The assertion that matters is the assignment, checked by `tsc -p tsconfig.workers.json`.
		const like: D1DatabaseLike = env.DB;
		expect(fromD1(like).defaultLocking).toBe("lease");
	});

	it("defaults to lease locking on D1's clock", async () => {
		const s = await openSqliteObjectStore(newTarget());
		expect(s.locking).toBe("lease");
		expect(fromD1(env.DB).leaseClock).toBe("database");
	});

	it("keeps one consistent, verifiable log when several drivers append to one database at once", async () => {
		const namespace = uniqueNamespace();
		await appendConcurrently(() => ({ database: fromD1(env.DB), namespace }), 3, 120);
	});

	it("round-trips an entry bundle of the largest size tlog-tiles allows within D1's limits", async () => {
		const s = await openSqliteObjectStore(strictTarget());
		const bundle = new Uint8Array(256 * (2 + 0xffff)).map((_, i) => i * 7);
		await s.put("tile/entries/000", bundle);
		const got = await s.get("tile/entries/000");
		expect(got?.length).toBe(bundle.length);
		expect(got?.every((b, i) => b === bundle[i])).toBe(true);
	});
});
