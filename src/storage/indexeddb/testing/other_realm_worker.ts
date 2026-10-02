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

// A dedicated module worker for indexeddb_browser_test.ts. It opens the same
// IndexedDB database as the page from a second JavaScript realm, standing in for
// another tab, so that the tests can show that IndexedDBObjectStore's locks and data,
// and the driver built on them, really are shared across contexts. Test-only.

import { type IndexedDBObjectStore, newIndexedDBDriver, openIndexedDBObjectStore } from "../indexeddb.ts";
import { appendEntries } from "./log.ts";

/** WorkerRequest is a message from the page to this worker. */
export type WorkerRequest =
	| { readonly type: "hold"; readonly db: string; readonly lock: string }
	| { readonly type: "release" }
	| { readonly type: "get"; readonly db: string; readonly key: string }
	| { readonly type: "put"; readonly db: string; readonly key: string; readonly value: string }
	| { readonly type: "append"; readonly db: string; readonly skey: string; readonly entries: readonly string[] };

/** WorkerReply is a message from this worker to the page. */
export type WorkerReply =
	| { readonly type: "acquired" }
	| { readonly type: "released" }
	| { readonly type: "got"; readonly value: string | undefined }
	| { readonly type: "stored" }
	| { readonly type: "appending" }
	/** assigned pairs each appended entry with its index, as a decimal string. */
	| { readonly type: "appended"; readonly assigned: readonly (readonly [string, string])[] }
	| { readonly type: "error"; readonly message: string };

const enc = new TextEncoder();
const dec = new TextDecoder();
const stores = new Map<string, Promise<IndexedDBObjectStore>>();
let release: (() => void) | undefined;

function store(db: string): Promise<IndexedDBObjectStore> {
	let s = stores.get(db);
	if (s === undefined) {
		s = openIndexedDBObjectStore({ name: db });
		stores.set(db, s);
	}
	return s;
}

function reply(msg: WorkerReply): void {
	self.postMessage(msg);
}

async function handle(req: WorkerRequest): Promise<void> {
	switch (req.type) {
		case "hold": {
			const s = await store(req.db);
			await s.lock(req.lock, async () => {
				const released = new Promise<void>((resolve) => {
					release = resolve;
				});
				reply({ type: "acquired" });
				await released;
			});
			reply({ type: "released" });
			return;
		}
		case "release":
			release?.();
			release = undefined;
			return;
		case "get": {
			const got = await (await store(req.db)).get(req.key);
			reply({ type: "got", value: got === undefined ? undefined : dec.decode(got) });
			return;
		}
		case "put":
			await (await store(req.db)).put(req.key, enc.encode(req.value));
			reply({ type: "stored" });
			return;
		case "append": {
			const ac = new AbortController();
			try {
				const driver = await newIndexedDBDriver({ name: req.db }, ac.signal);
				reply({ type: "appending" });
				const assigned = await appendEntries(
					driver,
					req.skey,
					req.entries.map((e) => enc.encode(e)),
				);
				reply({
					type: "appended",
					assigned: [...assigned].map(([index, entry]) => [index.toString(), dec.decode(entry)] as const),
				});
			} finally {
				ac.abort();
			}
			return;
		}
	}
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
	handle(event.data).catch((err: unknown) => {
		reply({ type: "error", message: String(err) });
	});
});
