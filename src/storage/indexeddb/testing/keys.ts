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

// Lists the keys an IndexedDB-backed store holds by asking IndexedDB itself, so that the golden
// compatibility suite can assert the database's exact contents rather than only the keys the
// driver asked it to write. Test-only.

/**
 * objectsStoreName is indexeddb.ts's private objectsStoreName, repeated here because a test must
 * not widen the backend's API to reach it. Should it ever change, opening the transaction below
 * throws NotFoundError, so the two cannot silently drift apart.
 */
const objectsStoreName = "objects";

/**
 * listDatabaseKeys returns every key in the webtessera database called name, in IndexedDB's
 * key order, over a short-lived connection of its own.
 */
export function listDatabaseKeys(factory: IDBFactory, name: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		// No version: open whatever version exists, so this never triggers a schema upgrade.
		const open = factory.open(name);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result;
			try {
				const req = db.transaction(objectsStoreName, "readonly").objectStore(objectsStoreName).getAllKeys();
				req.onerror = () => {
					db.close();
					reject(req.error);
				};
				req.onsuccess = () => {
					db.close();
					const keys: string[] = [];
					for (const k of req.result) {
						if (typeof k !== "string") {
							reject(new Error(`database ${JSON.stringify(name)} holds a non-string key ${String(k)}`));
							return;
						}
						keys.push(k);
					}
					resolve(keys);
				};
			} catch (err) {
				db.close();
				reject(err);
			}
		};
	});
}
