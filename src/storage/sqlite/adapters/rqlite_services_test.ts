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

// Runs the SQLite ObjectStore against a real rqlite node, named by RQLITE_URL (for example
// http://127.0.0.1:4001). Every store keeps its log in a namespace of its own, so the
// suite needs nothing of the node but that it is up, and leaves its tables behind.
// `pnpm test:services` runs it; without RQLITE_URL it fails rather than skips.

import { describe, expect, it } from "vitest";
import { describeObjectStoreConformance } from "../../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../../objectstore/testing/driver_conformance.ts";
import { describeGoldenCompatibility } from "../../objectstore/testing/golden.ts";
import type { SqlDatabase } from "../database.ts";
import { describeSqliteBehaviour } from "../testing/behaviour.ts";
import { appendConcurrently } from "../testing/concurrent.ts";
import { type StoreTarget, storeFactory, uniqueNamespace } from "../testing/stores.ts";
import { fromRqlite } from "./rqlite.ts";

const url = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.RQLITE_URL;

/** connect returns a new client of the rqlite node, as each process using it would have. */
function connect(): SqlDatabase {
	if (url === undefined || url === "") {
		throw new Error("RQLITE_URL is not set: start rqlited and set it to the node's HTTP address");
	}
	return fromRqlite({ url });
}

const newTarget = (): StoreTarget => ({ database: connect(), namespace: uniqueNamespace() });

describe("rqlite service", () => {
	it("is configured", () => {
		expect(url, "RQLITE_URL must name an rqlite node, e.g. http://127.0.0.1:4001").toMatch(/^https?:\/\//);
	});
});

const f = storeFactory(newTarget, {}, () => connect());
describeObjectStoreConformance("SqliteObjectStore (rqlite)", f.newStore);
describeDriverConformance("SqliteObjectStore (rqlite)", f.newStore, { reopen: f.reopen });
describeSqliteBehaviour("rqlite", newTarget);

describe("SqliteObjectStore (rqlite)", () => {
	it("keeps one consistent, verifiable log when drivers on separate clients append at once", async () => {
		const namespace = uniqueNamespace();
		await appendConcurrently(() => ({ database: connect(), namespace }), 3, 120);
	});
});

describeGoldenCompatibility("SqliteObjectStore (rqlite)", f.newStore, { reopen: f.reopen, listKeys: f.listKeys });
