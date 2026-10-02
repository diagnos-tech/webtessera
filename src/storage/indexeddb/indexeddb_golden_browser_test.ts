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
// store in real Chromium, against the browser's own IndexedDB and Web Locks, at every fixture
// size: what a browser tab persists must be, byte for byte, the log Tessera's POSIX driver
// writes, and a log Go wrote must carry on inside the browser.

import { afterAll, afterEach } from "vitest";
import { describeGoldenCompatibility } from "../objectstore/testing/golden.ts";
import { type IndexedDBObjectStore, openIndexedDBObjectStore } from "./index.ts";
import { listDatabaseKeys } from "./testing/keys.ts";

const databases = new Set<string>();

// opened holds every store a case opens, so that no case leaves a connection behind.
const opened: IndexedDBObjectStore[] = [];

afterEach(() => {
	for (const s of opened.splice(0)) {
		s.close();
	}
});

afterAll(async () => {
	for (const name of databases) {
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(name);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}
});

async function openStore(name: string): Promise<IndexedDBObjectStore> {
	databases.add(name);
	const s = await openIndexedDBObjectStore({ name });
	opened.push(s);
	return s;
}

describeGoldenCompatibility("indexeddb (chromium)", () => openStore(`webtessera-test-golden-${crypto.randomUUID()}`), {
	reopen: (s) => openStore(s.name),
	listKeys: (s) => listDatabaseKeys(indexedDB, s.name),
});
