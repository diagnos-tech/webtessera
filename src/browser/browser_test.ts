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

// Tests for webtessera/browser on Node, over fake-indexeddb and Node's WebCrypto, which
// clones CryptoKeys into IndexedDB as browsers do. log_browser_test.ts runs the parts that
// depend on a real browser (IndexedDB, Web Locks, non-extractable keys across a reopen) in
// Chromium.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteDeviceKey,
	fromCryptoKey,
	generateLogKey,
	loadDeviceKey,
	openBrowserLog,
	openDeviceKey,
	saveDeviceKey,
	verifyReceipt,
	WebtesseraError,
} from "webtessera/browser";
import { openIndexedDBObjectStore } from "../storage/indexeddb/indexeddb.ts";
import { newInProcessLockManager } from "../storage/indexeddb/testing/locks.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { newSignerForCosignatureV1 } from "../vendor/formats/note/note_cosigv1.ts";
import { generateKey } from "../vendor/note/note.ts";
import { cosignerVkey } from "../witness/keys.ts";
import { newWitnessServer } from "../witness/server.ts";
import { newWitness, newWitnessGroup } from "../witness.ts";

const enc = new TextEncoder();
let n = 0;
/** fresh returns a name no other test uses, for an origin or a database. */
function fresh(prefix: string): string {
	return `${prefix}-${++n}-${Math.random().toString(36).slice(2)}`;
}

beforeEach(() => {
	// Node has no Web Locks; a browser provides navigator.locks in every secure context.
	vi.stubGlobal("navigator", { locks: newInProcessLockManager() });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** rawRecord reads a device key record straight from IndexedDB. */
function rawRecord(database: string, id: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(database);
		req.onsuccess = () => {
			const db = req.result;
			const get = db.transaction("keys", "readonly").objectStore("keys").get(id);
			get.onsuccess = () => {
				db.close();
				resolve(get.result);
			};
			get.onerror = () => reject(get.error);
		};
		req.onerror = () => reject(req.error);
	});
}

describe("device keys", () => {
	it("generates a non-extractable key once, keeps it as a CryptoKey, and returns it again", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const key = await openDeviceKey(origin, { database });
		expect(key.backend).toBe("webcrypto");
		expect(key.extractable).toBe(false);

		const again = await openDeviceKey(origin, { database });
		const loaded = await loadDeviceKey(origin, { database });
		expect(again.vkey).toBe(key.vkey);
		expect(loaded?.vkey).toBe(key.vkey);
		const msg = enc.encode("hello\n");
		expect(key.verifier().verify(msg, await (loaded ?? key).sign(msg))).toBe(true);

		const record = (await rawRecord(database, origin)) as Record<string, unknown>;
		expect(Object.keys(record).sort()).toEqual(["origin", "privateKey", "publicKey", "version"]);
		expect(record.privateKey).toBeInstanceOf(CryptoKey);
		expect((record.privateKey as CryptoKey).extractable).toBe(false);
		await expect(crypto.subtle.exportKey("pkcs8", record.privateKey as CryptoKey)).rejects.toThrow();
	});

	it("gives tabs that open the key at the same time the same key", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const keys = await Promise.all(Array.from({ length: 5 }, () => openDeviceKey(origin, { database })));
		expect(new Set(keys.map((k) => k.vkey)).size).toBe(1);
	});

	it("keeps one key per origin, or per id", async () => {
		const database = fresh("keys");
		const a = await openDeviceKey("device.example/a", { database });
		const b = await openDeviceKey("device.example/b", { database });
		const b2 = await openDeviceKey("device.example/b", { database, id: "second" });
		expect(new Set([a.vkey, b.vkey, b2.vkey]).size).toBe(3);
		await expect(loadDeviceKey("device.example/a", { database, id: "second" })).rejects.toThrow(
			'belongs to the log "device.example/b", not "device.example/a"',
		);
	});

	it("saves an application's key pair, never over a stored key, and never a noble key", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
		const key = await fromCryptoKey(origin, pair);
		await saveDeviceKey(key, { database });
		expect((await loadDeviceKey(origin, { database }))?.vkey).toBe(key.vkey);
		await expect(saveDeviceKey(await fromCryptoKey(origin, pair), { database })).rejects.toThrow(/already exists/);

		vi.stubGlobal("crypto", { subtle: undefined, getRandomValues: crypto.getRandomValues.bind(crypto) });
		const noble = await generateLogKey(`device.example/${fresh("n")}`);
		vi.unstubAllGlobals();
		expect(noble.backend).toBe("noble");
		await expect(saveDeviceKey(noble, { database })).rejects.toThrow(/only a key held by WebCrypto can be saved/);
	});

	it("deletes a key, after which a new one is generated", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const key = await openDeviceKey(origin, { database });
		expect(await deleteDeviceKey(origin, { database })).toBe(true);
		expect(await deleteDeviceKey(origin, { database })).toBe(false);
		expect(await loadDeviceKey(origin, { database })).toBeUndefined();
		expect((await openDeviceKey(origin, { database })).vkey).not.toBe(key.vkey);
	});

	it("refuses a stored key whose halves were swapped", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const a = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
		const b = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
		await saveDeviceKey(await fromCryptoKey(origin, a), { database });
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.open(database);
			req.onsuccess = async () => {
				const db = req.result;
				const raw = new Uint8Array(await crypto.subtle.exportKey("raw", b.publicKey));
				const tx = db.transaction("keys", "readwrite");
				tx.objectStore("keys").put({ version: 1, origin, privateKey: a.privateKey, publicKey: raw }, origin);
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
		});
		await expect(loadDeviceKey(origin, { database })).rejects.toThrow("do not belong together");
	});

	it("refuses to make a key that could be exfiltrated where WebCrypto has no Ed25519", async () => {
		vi.stubGlobal("crypto", { subtle: undefined, getRandomValues: crypto.getRandomValues.bind(crypto) });
		await expect(openDeviceKey(`device.example/${fresh("d")}`, { database: fresh("keys") })).rejects.toThrow(
			/cannot hold an Ed25519 key .*generateLogKey\(origin, \{ fallback: "noble" \}\)/,
		);
	});

	it("refuses a private key string where an origin belongs", async () => {
		const { skey } = generateKey(undefined, "device.example");
		await expect(openDeviceKey(skey)).rejects.toThrow(/looks like a private signer key/);
	});
});

describe("openBrowserLog", () => {
	it("keeps a log in IndexedDB that survives a reopen with the device key", async () => {
		const database = fresh("keys");
		const origin = `device.example/${fresh("d")}`;
		const log = await openBrowserLog({ key: await openDeviceKey(origin, { database }) });
		expect(log.storage).toBe("indexedDB");
		expect(log.lockScope).toBe("origin");
		const data = enc.encode("clicked: buy");
		const r = await log.append(data);
		expect(verifyReceipt(r.text, { vkey: log.vkey, data }).index).toBe(0n);
		await log.close();

		const loaded = await loadDeviceKey(origin, { database });
		if (loaded === undefined) {
			throw new Error("the device key was not kept");
		}
		const reopened = await openBrowserLog({ key: loaded });
		try {
			expect((await reopened.latestCheckpoint()).size).toBe(1n);
			expect((await reopened.append(enc.encode("clicked: pay"))).index).toBe(1n);
			expect(verifyReceipt(r, { vkey: reopened.vkey, data }).index).toBe(0n);
		} finally {
			await reopened.close();
		}
	});

	it("refuses private key strings outright, saying what to use", async () => {
		const { skey } = generateKey(undefined, "device.example");
		const err = (await openBrowserLog({ key: skey as never }).catch((e: unknown) => e)) as WebtesseraError;
		expect(err).toBeInstanceOf(WebtesseraError);
		expect(err.code).toBe("SIGNER_KEY_MISUSE");
		expect(err.message).toMatch(/refuses private key strings.*openDeviceKey\(origin\)/);
		expect(err.message).not.toContain(skey.slice(-20));
	});

	it("refuses a persistent log whose key would not persist with it", async () => {
		const key = await generateLogKey(`device.example/${fresh("d")}`);
		await expect(openBrowserLog({ key })).rejects.toThrow(
			/outlives this page, but its key does not.*openDeviceKey\(origin\).*storage: \{ memory: true \}/,
		);
		const ephemeral = await openBrowserLog({ key, storage: { memory: true } });
		expect(ephemeral.storage).toBe("memory");
		expect((await ephemeral.append(enc.encode("x"))).index).toBe(0n);
		await ephemeral.close();
	});

	it("accepts a key the application manages as a CryptoKey", async () => {
		const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
		const key = await fromCryptoKey(`device.example/${fresh("d")}`, pair);
		const log = await openBrowserLog({ key, storage: { indexedDB: fresh("log") } });
		await log.close();
	});

	it("refuses to open a log another key created", async () => {
		const database = fresh("keys");
		const name = fresh("log");
		const origin = `device.example/${fresh("d")}`;
		const first = await openBrowserLog({
			key: await openDeviceKey(origin, { database }),
			storage: { indexedDB: name },
		});
		await first.close();
		await expect(
			openBrowserLog({ key: await openDeviceKey(origin, { database, id: "other" }), storage: { indexedDB: name } }),
		).rejects.toThrow(/was not created with this key/);
	});

	it("needs Web Locks for a shared log, unless it is promised a single writer, and says so in its own terms", async () => {
		vi.stubGlobal("navigator", {});
		const key = await openDeviceKey(`device.example/${fresh("d")}`, { database: fresh("keys") });
		const name = fresh("log");
		const named = (await openBrowserLog({ key, storage: { indexedDB: name } }).catch(
			(e: unknown) => e,
		)) as WebtesseraError;
		expect(named.code).toBe("NO_WEB_LOCKS");
		expect(named.message).toMatch(/^openBrowserLog: the Web Locks API \(navigator\.locks\) is not available/);
		expect(named.message).toContain(`pass storage: { indexedDB: "${name}", singleWriter: true }`);
		// Not the IndexedDB store's own options, which openBrowserLog does not take.
		expect(named.message).not.toContain("opts.locks");
		// The default database is named after the log's origin, and the message names it too.
		await expect(openBrowserLog({ key })).rejects.toThrow(
			`storage: { indexedDB: "webtessera-log:${key.origin}", singleWriter: true }`,
		);
		vi.stubGlobal("navigator", { locks: null });
		await expect(openBrowserLog({ key, storage: { indexedDB: name } })).rejects.toThrow(/singleWriter: true \}/);

		const single = await openBrowserLog({ key, storage: { indexedDB: fresh("log"), singleWriter: true } });
		expect(single.lockScope).toBe("realm");
		await single.close();
		// Memory storage needs no locks across tabs.
		const memory = await openBrowserLog({ key, storage: { memory: true } });
		expect(memory.lockScope).toBe("realm");
		await memory.close();
	});

	it("says, before anything else, that a page that is not a secure context cannot hold a device key", async () => {
		vi.stubGlobal("isSecureContext", false);
		for (const call of [() => openDeviceKey(`device.example/${fresh("d")}`), () => loadDeviceKey("device.example/x")]) {
			const err = (await call().catch((e: unknown) => e)) as WebtesseraError;
			expect(err).toBeInstanceOf(WebtesseraError);
			expect(err.code).toBe("INSECURE_CONTEXT");
			expect(err.message).toMatch(
				/: this page is not a secure context \(it was loaded over plain HTTP from a host other than localhost\), and browsers give WebCrypto, which holds device keys, only to secure contexts/,
			);
		}
		vi.stubGlobal("isSecureContext", true);
		expect(await loadDeviceKey(`device.example/${fresh("d")}`)).toBeUndefined();
	});

	it("closes through Symbol.asyncDispose, for `await using`", async () => {
		const key = await openDeviceKey(`device.example/${fresh("d")}`, { database: fresh("keys") });
		const log = await openBrowserLog({ key, storage: { memory: true } });
		await log.append(enc.encode("x"));
		await log[Symbol.asyncDispose]();
		await expect(log.append(enc.encode("late"))).rejects.toThrow(expect.objectContaining({ code: "LOG_CLOSED" }));
	});

	it("keeps the IndexedDB store's own message, in its own terms, for its direct callers", async () => {
		await expect(openIndexedDBObjectStore({ name: fresh("log"), locks: null })).rejects.toThrow(
			/pass opts\.locks, or pass singleWriter: true/,
		);
	});

	it("reads its entries back", async () => {
		const key = await openDeviceKey(`device.example/${fresh("d")}`, { database: fresh("keys") });
		const log = await openBrowserLog({ key, storage: { indexedDB: fresh("log") } });
		try {
			for (const t of ["one", "two", "three"]) {
				await log.append(enc.encode(t));
			}
			const read: string[] = [];
			for await (const { data } of log.entries(1)) {
				read.push(new TextDecoder().decode(data));
			}
			expect(read).toEqual(["two", "three"]);
			expect((await log.entry(0)).data).toEqual(enc.encode("one"));
		} finally {
			await log.close();
		}
	});

	it("says that storage holds an older log than its witness cosigned, not that the witness is unreachable", async () => {
		const key = await openDeviceKey(`device.example/${fresh("d")}`, { database: fresh("keys") });
		const w = generateKey(undefined, "witness.example");
		const witness = newWitnessServer({
			signer: newSignerForCosignatureV1(w.skey),
			store: new MemoryObjectStore(),
			lookupLog: (o) => (o === key.origin ? { verifierKeys: [key.vkey] } : undefined),
		});
		const options = {
			key,
			witnesses: newWitnessGroup(1, newWitness(cosignerVkey(w.skey), new URL("https://witness.example/"))),
			fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
				(await witness.handle(new Request(input, init))) ?? new Response("not found", { status: 404 }),
		};
		const name = fresh("log");
		const first = await openBrowserLog({ ...options, storage: { indexedDB: name } });
		await first.append(enc.encode("cosigned"));
		await first.close();

		// The device key survived, the log's database did not: what clearing one store does.
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(name);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
		const err = (await openBrowserLog({ ...options, storage: { indexedDB: name } }).catch((e: unknown) => e)) as Error;
		expect(err.message).toMatch(
			/^openBrowserLog: this storage holds an older or different log than its witnesses cosigned: the witness at "https:\/\/witness\.example\/add-checkpoint" has cosigned this log at size 1, and the storage holds no entries/,
		);
		expect(err.message).not.toContain("witnesses must be reachable");
	});

	it("refuses malformed storage", async () => {
		const key = await generateLogKey(`device.example/${fresh("d")}`);
		await expect(openBrowserLog({ key, storage: { indexedDB: "" } })).rejects.toThrow(/name of the IndexedDB database/);
		await expect(openBrowserLog({ key, storage: { memory: false } as never })).rejects.toThrow(
			"storage must be { indexedDB: name } or { memory: true }",
		);
		await expect(openBrowserLog(undefined as never)).rejects.toThrow("takes an options object");
	});
});
