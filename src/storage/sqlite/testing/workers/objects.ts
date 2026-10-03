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

// Lets the backend-independent suites, which drive an ObjectStore from the test's own
// context, run the SQLite ObjectStore on a Durable Object's database. Test-only.

import { runInDurableObject } from "cloudflare:test";
import { fromDurableObjectStorage } from "../../adapters/durableobject.ts";
import type { SqlDatabase } from "../../database.ts";
import type { SqliteTestObject } from "./worker.ts";

/** TestNamespace is the namespace of the test Durable Object class. */
export type TestNamespace = DurableObjectNamespace<SqliteTestObject>;

/**
 * inObject returns a SqlDatabase that runs each statement, and each batch, inside the
 * Durable Object stub points to, through fromDurableObjectStorage over the object's own
 * storage.
 *
 * A Durable Object's storage may only be used from within the object, so the suites'
 * stores, which run in the test's context, reach it a request at a time, through
 * runInDurableObject. Concurrent statements from a suite thus reach the object as
 * separate, interleaving requests, as a store's would inside it. Every store over the
 * returned SqlDatabase shares its in-process locks, as every store inside one object
 * does.
 */
export function inObject(stub: DurableObjectStub<SqliteTestObject>): SqlDatabase {
	const run = <R>(fn: (db: SqlDatabase) => Promise<R>): Promise<R> =>
		runInDurableObject(stub, (_, state) => fn(fromDurableObjectStorage(state.storage)));
	return {
		defaultLocking: "local",
		leaseClock: "database",
		query: (s) => run((db) => db.query(s)),
		batch: (s) => run((db) => db.batch(s)),
	};
}

/** inFreshObject runs fn inside a fresh Durable Object of ns, with its storage. */
export function inFreshObject<R>(ns: TestNamespace, fn: (storage: DurableObjectStorage) => Promise<R>): Promise<R> {
	return runInDurableObject(ns.get(ns.newUniqueId()), (_, state) => fn(state.storage));
}
