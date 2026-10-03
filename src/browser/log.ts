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

// This file has no upstream counterpart. openBrowserLog is the browser half of the safe
// API: a log kept in IndexedDB, shared safely between tabs through Web Locks, and signed
// by a key the device keeps and cannot export. See
// docs/decisions/0226-the-high-level-log.md.

import type { FetchFn } from "../client/fetcher.ts";
import { assertLogKey, isDurable } from "../safe/keys.ts";
import { LogBase, type LogOptions, type LogParts, openLog, type TransparencyLog } from "../safe/log.ts";
import { openIndexedDBObjectStore } from "../storage/indexeddb/indexeddb.ts";
import type { LockScope } from "../storage/indexeddb/locks.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { newObjectStoreDriver } from "../storage/objectstore/driver.ts";
import type { ObjectStore } from "../storage/objectstore/objectstore.ts";

/**
 * BrowserStorage says where a browser log is kept:
 *
 *   - `{ indexedDB: name }`: the IndexedDB database called name, which every tab and
 *     worker of the page's origin shares, with writes serialised by Web Locks. This is the
 *     default, with a database named after the log's origin. `singleWriter: true` lets the
 *     log open without Web Locks (outside a secure context), on your promise that no other
 *     tab or worker writes it.
 *   - `{ memory: true }`: nothing survives the page.
 *
 * ```ts
 * storage: { indexedDB: "audit-log" }
 * ```
 */
export type BrowserStorage =
	| { readonly indexedDB: string; readonly singleWriter?: boolean }
	| { readonly memory: true };

/**
 * BrowserLogOptions configures openBrowserLog: the options every log takes (LogOptions),
 * and where a browser log is kept.
 *
 * ```ts
 * { key: await openDeviceKey(origin), witnesses: newWitnessGroup(1, serverWitness) }
 * ```
 */
export interface BrowserLogOptions extends LogOptions {
	/** storage is where the log is kept. Defaults to an IndexedDB database named after the origin. */
	readonly storage?: BrowserStorage;
	/** fetch makes the requests to witnesses. Defaults to the global fetch. */
	readonly fetch?: FetchFn;
}

/**
 * BrowserLog is the log openBrowserLog returns: a TransparencyLog kept in this browser.
 *
 * ```ts
 * if (log.lockScope !== "origin") {
 *   // only this tab may write the log
 * }
 * ```
 */
export interface BrowserLog extends TransparencyLog {
	/** storage is the kind of storage the log is kept in. */
	readonly storage: "indexedDB" | "memory";
	/**
	 * lockScope is "origin" when the log's locks exclude every tab and worker of the page's
	 * origin (Web Locks), and "realm" when they exclude only this one (singleWriter: true,
	 * without Web Locks, or memory storage).
	 */
	readonly lockScope: LockScope;
}

/**
 * defaultDatabasePrefix prefixes the default IndexedDB database name of a browser log, the
 * rest of which is its origin.
 */
const defaultDatabasePrefix = "webtessera-log:";

/**
 * openBrowserLog opens the log kept in this browser, creating it on first use, and starts
 * appending to it with `key`. It refuses private key strings, a persistent log whose key
 * would not persist with it, and a log that another key created.
 *
 * ```ts
 * import { openBrowserLog, openDeviceKey } from "webtessera/browser";
 *
 * const log = await openBrowserLog({ key: await openDeviceKey("device.example/7f3a") });
 * const receipt = await log.append(new TextEncoder().encode("clicked: buy"));
 * localStorage.setItem(`receipt:${receipt.index}`, receipt.text);
 * ```
 */
export async function openBrowserLog(options: BrowserLogOptions): Promise<BrowserLog> {
	const where = "openBrowserLog";
	if (typeof options !== "object" || options === null) {
		throw new TypeError(`${where} takes an options object: { key }`);
	}
	if (typeof options.key === "string") {
		throw new TypeError(
			`${where}: webtessera/browser refuses private key strings: anything a page holds is readable by whoever ` +
				"loads it. Use openDeviceKey(origin), whose key is generated on this device and cannot be exported.",
		);
	}
	assertLogKey(options.key, where);
	const storage = checkStorage(options.storage ?? { indexedDB: defaultDatabasePrefix + options.key.origin }, where);
	if ("indexedDB" in storage && !isDurable(options.key)) {
		throw new TypeError(
			`${where}: the log is kept in IndexedDB and outlives this page, but its key does not, so after a reload ` +
				"nothing could sign it again. Use openDeviceKey(origin), which keeps the key on the device; or " +
				"storage: { memory: true } for a log that lasts as long as the page.",
		);
	}
	const opened = await openStorage(storage);
	const driver = newObjectStoreDriver(
		options.fetch === undefined ? { store: opened.store } : { store: opened.store, fetch: options.fetch },
	);
	let parts: LogParts;
	try {
		parts = await openLog(where, options, { driver, store: opened.store, onClose: opened.close });
	} catch (err) {
		opened.close();
		throw err;
	}
	return new browserLog(parts, opened.kind, opened.lockScope);
}

/** browserLog implements BrowserLog. */
class browserLog extends LogBase implements BrowserLog {
	readonly storage: BrowserLog["storage"];
	readonly lockScope: LockScope;

	constructor(parts: LogParts, storage: BrowserLog["storage"], lockScope: LockScope) {
		super(parts);
		this.storage = storage;
		this.lockScope = lockScope;
	}
}

/** checkStorage returns storage if it is one of the shapes BrowserStorage allows, and throws otherwise. */
function checkStorage(storage: unknown, where: string): BrowserStorage {
	if (typeof storage === "object" && storage !== null && "indexedDB" in storage) {
		const { indexedDB } = storage as { indexedDB: unknown };
		if (typeof indexedDB !== "string" || indexedDB === "") {
			throw new TypeError(`${where}: storage.indexedDB is the name of the IndexedDB database to keep the log in`);
		}
		return storage as BrowserStorage;
	}
	if (typeof storage === "object" && storage !== null && "memory" in storage && storage.memory === true) {
		return storage as BrowserStorage;
	}
	throw new TypeError(`${where}: storage must be { indexedDB: name } or { memory: true }`);
}

async function openStorage(
	storage: BrowserStorage,
): Promise<{ store: ObjectStore; kind: BrowserLog["storage"]; lockScope: LockScope; close: () => void }> {
	if ("indexedDB" in storage) {
		const store = await openIndexedDBObjectStore(
			storage.singleWriter === true ? { name: storage.indexedDB, singleWriter: true } : { name: storage.indexedDB },
		);
		return { store, kind: "indexedDB", lockScope: store.lockScope, close: () => store.close() };
	}
	return { store: new MemoryObjectStore(), kind: "memory", lockScope: "realm", close: () => {} };
}
