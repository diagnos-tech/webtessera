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

// This file has no upstream counterpart. It keeps a browser log's key on the device: a
// non-extractable WebCrypto CryptoKey, which IndexedDB stores as the CryptoKey itself
// (structured clone keeps it non-extractable), never as bytes. See
// docs/decisions/0227-device-keys-in-indexeddb.md.

import {
	checkOrigin,
	cryptoKeyOf,
	generateLogKey,
	type LogKey,
	markDurable,
	restoreCryptoKey,
	webCryptoEd25519,
} from "../safe/keys.ts";

/**
 * DefaultDeviceKeyDatabase is the IndexedDB database device keys are kept in by default.
 *
 * ```ts
 * indexedDB.deleteDatabase(DefaultDeviceKeyDatabase); // forget every device key
 * ```
 */
export const DefaultDeviceKeyDatabase = "webtessera-keys";

/**
 * DeviceKeyOptions says where a device key is kept.
 *
 * ```ts
 * await openDeviceKey(origin, { id: `user:${userId}` }); // one key per user of this device
 * ```
 */
export interface DeviceKeyOptions {
	/**
	 * id names the key in the store. It defaults to the origin, so that each log on the
	 * device has a key of its own.
	 */
	readonly id?: string;
	/** database is the IndexedDB database the key is kept in. Defaults to {@link DefaultDeviceKeyDatabase}. */
	readonly database?: string;
}

/** deviceKeyRecord is what the store holds for each key: the CryptoKey itself, never its bytes. */
interface deviceKeyRecord {
	readonly version: 1;
	readonly origin: string;
	readonly privateKey: CryptoKey;
	readonly publicKey: Uint8Array;
}

const storeName = "keys";
const schemaVersion = 1;

/**
 * openDeviceKey returns this device's key for the log with the given origin, generating
 * it the first time: a non-extractable Ed25519 WebCrypto key, kept in IndexedDB, that no
 * script (this library included) can export, so that it cannot be exfiltrated. Every tab
 * and worker of the page's origin gets the same key, and it survives reloads.
 *
 * It throws where WebCrypto cannot hold an Ed25519 key, rather than fall back to a key
 * that could be read: see webCryptoEd25519.
 *
 * ```ts
 * const key = await openDeviceKey("device.example/7f3a");
 * const log = await openBrowserLog({ key });
 * ```
 */
export async function openDeviceKey(origin: string, options: DeviceKeyOptions = {}): Promise<LogKey> {
	checkOrigin(origin, "openDeviceKey");
	const loaded = await loadDeviceKey(origin, options);
	if (loaded !== undefined) {
		return loaded;
	}
	if (!(await webCryptoEd25519())) {
		throw new Error(
			"openDeviceKey: this browser's WebCrypto API cannot hold an Ed25519 key (it needs Chrome or Edge 137, " +
				"Firefox 129 or Safari 17, on an HTTPS or localhost page), so a key that cannot be exfiltrated is " +
				'impossible here. generateLogKey(origin, { fallback: "noble" }) makes a key that lasts as long as the page.',
		);
	}
	const key = await generateLogKey(origin, { fallback: "error" });
	if (await addRecord(options, recordOf(key))) {
		markDurable(key);
		return key;
	}
	// Another tab or worker created the key first; use the one it stored.
	const winner = await loadDeviceKey(origin, options);
	if (winner === undefined) {
		throw new Error(`openDeviceKey: the device key ${JSON.stringify(idOf(origin, options))} vanished while opening it`);
	}
	return winner;
}

/**
 * loadDeviceKey returns this device's stored key for the log with the given origin, or
 * undefined if there is none. It checks that the stored private and public halves belong
 * together before returning them.
 *
 * ```ts
 * const key = await loadDeviceKey("device.example/7f3a");
 * if (key === undefined) {
 *   // first visit
 * }
 * ```
 */
export async function loadDeviceKey(origin: string, options: DeviceKeyOptions = {}): Promise<LogKey | undefined> {
	checkOrigin(origin, "loadDeviceKey");
	const id = idOf(origin, options);
	const record = await request<unknown>(options, "readonly", (store, done) => {
		const got = store.get(id);
		got.onsuccess = () => done(got.result);
	});
	if (record === undefined) {
		return undefined;
	}
	if (!isRecord(record)) {
		throw new Error(`loadDeviceKey: the device key ${JSON.stringify(id)} is not a key this library stored`);
	}
	if (record.origin !== origin) {
		throw new Error(
			`loadDeviceKey: the device key ${JSON.stringify(id)} belongs to the log ${JSON.stringify(record.origin)}, ` +
				`not ${JSON.stringify(origin)}`,
		);
	}
	return restoreCryptoKey(origin, record.privateKey, record.publicKey);
}

/**
 * saveDeviceKey stores a WebCrypto-backed key, such as one from fromCryptoKey, as this
 * device's key for its log, so that openDeviceKey and loadDeviceKey return it from now
 * on. It never overwrites a stored key: delete that one first, knowing that a log cannot
 * change its key.
 *
 * ```ts
 * const key = await fromCryptoKey("device.example/7f3a", pair);
 * await saveDeviceKey(key);
 * ```
 */
export async function saveDeviceKey(key: LogKey, options: DeviceKeyOptions = {}): Promise<void> {
	if (cryptoKeyOf(key) === undefined) {
		throw new TypeError(
			"saveDeviceKey: only a key held by WebCrypto can be saved; a key held by @noble/curves would be stored as " +
				"bytes that any script on the page could read",
		);
	}
	if (!(await addRecord(options, recordOf(key)))) {
		throw new Error(
			`saveDeviceKey: a device key ${JSON.stringify(idOf(key.origin, options))} already exists; a log cannot change ` +
				"its key, so delete the old one with deleteDeviceKey only if its log is gone too",
		);
	}
	markDurable(key);
}

/**
 * deleteDeviceKey deletes this device's key for the log with the given origin, and
 * reports whether there was one. The log it signed can never be appended to again.
 *
 * ```ts
 * await deleteDeviceKey("device.example/7f3a");
 * ```
 */
export async function deleteDeviceKey(origin: string, options: DeviceKeyOptions = {}): Promise<boolean> {
	checkOrigin(origin, "deleteDeviceKey");
	const id = idOf(origin, options);
	return request<boolean>(options, "readwrite", (store, done) => {
		const counted = store.count(id);
		counted.onsuccess = () => {
			const existed = counted.result > 0;
			store.delete(id).onsuccess = () => done(existed);
		};
	});
}

function recordOf(key: LogKey): deviceKeyRecord {
	const ck = cryptoKeyOf(key);
	if (ck === undefined) {
		throw new TypeError("internal error: not a WebCrypto key");
	}
	return { version: 1, origin: key.origin, privateKey: ck.privateKey, publicKey: ck.publicKey };
}

/** addRecord stores record under its id unless one is there, and reports whether it did. */
async function addRecord(options: DeviceKeyOptions, record: deviceKeyRecord): Promise<boolean> {
	const id = idOf(record.origin, options);
	return request<boolean>(options, "readwrite", (store, done) => {
		// add, unlike put, fails on an existing key: two tabs creating the key at once
		// cannot both succeed, so neither signs with a key the other then replaces.
		const added = store.add(record, id);
		added.onsuccess = () => done(true);
		added.onerror = (event) => {
			if (added.error?.name === "ConstraintError") {
				event.preventDefault();
				done(false);
			}
		};
	});
}

function idOf(origin: string, options: DeviceKeyOptions): string {
	return options.id ?? origin;
}

function isRecord(v: unknown): v is deviceKeyRecord {
	if (typeof v !== "object" || v === null) {
		return false;
	}
	const r = v as Partial<deviceKeyRecord>;
	return (
		r.version === 1 &&
		typeof r.origin === "string" &&
		typeof r.privateKey === "object" &&
		r.privateKey !== null &&
		r.publicKey instanceof Uint8Array
	);
}

/**
 * request runs one transaction on the device key store, in which start issues its requests,
 * and resolves to the value start passes to done once the transaction has committed. The
 * connection is opened for the transaction and closed after it, so that it never blocks
 * an upgrade from another tab.
 */
async function request<T>(
	options: DeviceKeyOptions,
	mode: IDBTransactionMode,
	start: (store: IDBObjectStore, done: (v: T) => void) => void,
): Promise<T> {
	const db = await openDatabase(options.database ?? DefaultDeviceKeyDatabase);
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction(storeName, mode, { durability: "strict" });
			let result: { readonly v: T } | undefined;
			tx.oncomplete = () => {
				if (result === undefined) {
					reject(new Error("device key store: the transaction completed without a result"));
					return;
				}
				resolve(result.v);
			};
			tx.onabort = () => reject(tx.error ?? new Error("device key store: the transaction was aborted"));
			start(tx.objectStore(storeName), (v) => {
				result = { v };
			});
		});
	} finally {
		db.close();
	}
}

function openDatabase(name: string): Promise<IDBDatabase> {
	const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
	if (factory === undefined) {
		return Promise.reject(
			new Error("device keys are kept in IndexedDB, which this runtime does not have; use a browser window or worker"),
		);
	}
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = factory.open(name, schemaVersion);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(storeName)) {
				req.result.createObjectStore(storeName);
			}
		};
		req.onsuccess = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(storeName)) {
				db.close();
				reject(new Error(`IndexedDB database ${JSON.stringify(name)} exists but does not hold device keys`));
				return;
			}
			db.onversionchange = () => db.close();
			resolve(db);
		};
		req.onerror = () => reject(req.error ?? new Error(`cannot open IndexedDB database ${JSON.stringify(name)}`));
		req.onblocked = () => {
			// Another connection still has an older version open; open resolves once it closes.
		};
	});
}
