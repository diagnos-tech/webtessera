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

// Tests of webtessera/browser in real Chromium: WebCrypto's own non-extractable Ed25519
// keys, signing exactly as Go does; device keys kept in the browser's IndexedDB as
// CryptoKeys, shared with a worker and surviving a reopen; and a client-only log kept in
// IndexedDB under real Web Locks.

import { describe, expect, it } from "vitest";
import { describeWebCryptoGolden } from "../safe/testing/golden.ts";
import type { RealmReply, RealmRequest } from "../safe/testing/realm_worker.ts";
import { generateKey } from "../vendor/note/note.ts";
import {
	deleteDeviceKey,
	generateLogKey,
	loadDeviceKey,
	openBrowserLog,
	openDeviceKey,
	verifyReceipt,
	webCryptoEd25519,
} from "./index.ts";

describeWebCryptoGolden("Chromium");

const enc = new TextEncoder();

function fresh(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function askWorker(req: RealmRequest): Promise<RealmReply> {
	const worker = new Worker(new URL("../safe/testing/realm_worker.ts", import.meta.url), { type: "module" });
	return new Promise<RealmReply>((resolve, reject) => {
		worker.onmessage = (e: MessageEvent<RealmReply>) => {
			worker.terminate();
			resolve(e.data);
		};
		worker.onerror = (e) => {
			worker.terminate();
			reject(new Error(e.message));
		};
		worker.postMessage(req);
	});
}

describe("keys in Chromium", () => {
	it("supports Ed25519 in WebCrypto, so keys are non-extractable", async () => {
		expect(await webCryptoEd25519()).toBe(true);
		const key = await generateLogKey("example.com/log");
		expect(key.backend).toBe("webcrypto");
		expect(key.extractable).toBe(false);
	});

	it("keeps a device key that no script can export, and finds it again after a reopen", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const key = await openDeviceKey(origin, { database });
		expect(key.extractable).toBe(false);

		// What IndexedDB holds is the CryptoKey itself, which the browser refuses to export.
		const record = await new Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }>((resolve, reject) => {
			const req = indexedDB.open(database);
			req.onsuccess = () => {
				const get = req.result.transaction("keys").objectStore("keys").get(origin);
				get.onsuccess = () => {
					req.result.close();
					resolve(get.result);
				};
				get.onerror = () => reject(get.error);
			};
		});
		expect(record.privateKey).toBeInstanceOf(CryptoKey);
		expect(record.privateKey.extractable).toBe(false);
		await expect(crypto.subtle.exportKey("pkcs8", record.privateKey)).rejects.toThrow();
		await expect(crypto.subtle.exportKey("jwk", record.privateKey)).rejects.toThrow();

		const reopened = await loadDeviceKey(origin, { database });
		expect(reopened?.vkey).toBe(key.vkey);
		const msg = enc.encode("after a reopen\n");
		expect(key.verifier().verify(msg, await (reopened ?? key).sign(msg))).toBe(true);
		expect(await deleteDeviceKey(origin, { database })).toBe(true);
	});

	it("gives a worker of the same origin the same device key", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const key = await openDeviceKey(origin, { database });
		const reply = await askWorker({ type: "deviceKey", origin, database });
		expect(reply).toEqual({ type: "deviceKey", vkey: key.vkey, extractable: false });
	});
});

describe("a client-only log in Chromium", () => {
	it("keeps a tamper-evident log in IndexedDB, signed by the device key, across a reopen", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const storage = { indexedDB: fresh("log") };
		const log = await openBrowserLog({ key: await openDeviceKey(origin, { database }), storage });
		expect(log.lockScope).toBe("origin");
		const entries = ["opened the form", "typed a name", "submitted"].map((s) => enc.encode(s));
		const receipts = [];
		for (const e of entries) {
			receipts.push(await log.append(e));
		}
		await log.close();

		const key = await loadDeviceKey(origin, { database });
		if (key === undefined) {
			throw new Error("the device key was not kept");
		}
		const reopened = await openBrowserLog({ key, storage });
		try {
			expect((await reopened.latestCheckpoint()).size).toBe(3n);
			for (const [i, r] of receipts.entries()) {
				expect(verifyReceipt(r.text, { vkey: key.vkey, data: entries[i] as Uint8Array }).index).toBe(BigInt(i));
			}
			const latest = await reopened.prove(0n);
			expect(verifyReceipt(latest, { vkey: key.vkey, data: entries[0] as Uint8Array }).checkpoint.size).toBe(3n);
		} finally {
			await reopened.close();
		}
	});

	it("refuses private key strings", async () => {
		const { skey } = generateKey(undefined, "device.example");
		await expect(openBrowserLog({ key: skey as never })).rejects.toThrow(/refuses private key strings/);
	});
});
