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

// Runs the golden compatibility suite (../objectstore/testing/golden.ts) over the IndexedDB
// store on Node, against fake-indexeddb: every log_<N> fixture Tessera's POSIX driver wrote must
// come out of IndexedDB byte for byte, and Go-written logs loaded into it must carry on.
// indexeddb_golden_browser_test.ts runs the same suite against Chromium's own IndexedDB.

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach } from "vitest";
import { describeGoldenCompatibility } from "../objectstore/testing/golden.ts";
import { type IndexedDBObjectStore, openIndexedDBObjectStore } from "./index.ts";
import { listDatabaseKeys } from "./testing/keys.ts";

// opened holds every store a case opens, so that no case leaves a connection behind.
const opened: IndexedDBObjectStore[] = [];

afterEach(() => {
	for (const s of opened.splice(0)) {
		s.close();
	}
});

// factoryOf maps each store to its fake-indexeddb instance, which plays the part of an origin:
// reopening through it reaches the same database over a second connection.
const factoryOf = new WeakMap<IndexedDBObjectStore, IDBFactory>();

async function openStore(factory: IDBFactory): Promise<IndexedDBObjectStore> {
	const s = await openIndexedDBObjectStore({ name: "log", indexedDB: factory, IDBKeyRange, locks: null });
	opened.push(s);
	factoryOf.set(s, factory);
	return s;
}

function factory(s: IndexedDBObjectStore): IDBFactory {
	const f = factoryOf.get(s);
	if (f === undefined) {
		throw new Error("the store was not opened by this suite");
	}
	return f;
}

describeGoldenCompatibility("indexeddb (fake-indexeddb)", () => openStore(new IDBFactory()), {
	reopen: (s) => openStore(factory(s)),
	listKeys: (s) => listDatabaseKeys(factory(s), s.name),
});
