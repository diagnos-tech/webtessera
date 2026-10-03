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
// This device's log, with the safe API: a key generated on the device that no script can export
// (openDeviceKey), and a log kept in IndexedDB that every tab of the page shares (openBrowserLog).
// Both are found again after a reload by the log's origin, which the page remembers.

import { type BrowserLog, deleteDeviceKey, type LogKey, openBrowserLog, openDeviceKey } from "webtessera/browser";

// originKey is where the page remembers its log's origin. The origin is public: it is the first
// line of every checkpoint, and it names both the device key and the IndexedDB database.
const originKey = "client-only/origin";

/** deviceOrigin returns this device's log origin, choosing one on first use. */
export function deviceOrigin(): string {
	let origin = localStorage.getItem(originKey);
	if (origin === null) {
		const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
		origin = `${location.host}/device/${id}`;
		localStorage.setItem(originKey, origin);
	}
	return origin;
}

/** DeviceLogOptions says which log to open, and how its writers are kept apart. */
export interface DeviceLogOptions {
	readonly origin: string;
	/**
	 * singleWriter opens the log without Web Locks, on the page's promise that no other tab or
	 * worker writes it. Without Web Locks, and without this promise, opening fails: two tabs
	 * appending at once with nothing to keep them apart would fork the log.
	 */
	readonly singleWriter?: boolean;
	/** checkpointIntervalMs bounds how long append waits for its receipt. */
	readonly checkpointIntervalMs?: number;
}

/** DeviceLog is this device's log, and the key that signs it. */
export interface DeviceLog {
	readonly log: BrowserLog;
	/** key is the device key; its toString shows its custody, never its secret. */
	readonly key: LogKey;
}

/** openDeviceLog opens this device's log, creating the key and the log on first use. */
export async function openDeviceLog(options: DeviceLogOptions): Promise<DeviceLog> {
	const key = await openDeviceKey(options.origin);
	const log = await openBrowserLog({
		key,
		...(options.singleWriter === true
			? { storage: { indexedDB: databaseOf(options.origin), singleWriter: true } }
			: {}),
		...(options.checkpointIntervalMs === undefined ? {} : { checkpointIntervalMs: options.checkpointIntervalMs }),
	});
	return { log, key };
}

/** webLocksAvailable reports whether this context has Web Locks, which secure contexts do. */
export function webLocksAvailable(): boolean {
	return typeof navigator.locks?.request === "function";
}

/**
 * forgetDevice deletes the log and its key. Every receipt the log handed out still verifies
 * with its vkey, but nothing can ever append to the log again.
 */
export async function forgetDevice(log: BrowserLog): Promise<void> {
	await log.close();
	await deleteDeviceKey(log.origin);
	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(databaseOf(log.origin));
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
	localStorage.removeItem(originKey);
}

/** databaseOf names the IndexedDB database of a log, as openBrowserLog does by default. */
function databaseOf(origin: string): string {
	return `webtessera-log:${origin}`;
}
