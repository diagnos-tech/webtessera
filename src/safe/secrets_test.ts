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

// The safe API's promise that no error repeats a signer key, held to every input it takes:
// a log's signer key is fed, in the forms a mistake produces, to every function of
// webtessera/server, webtessera/browser and webtessera/witness that takes a verifier key, an
// origin, a name or any other string, and no error, cause or stack may contain it. Where a
// verifier key or another public string was expected, the error must also say, with the code
// SIGNER_KEY_MISUSE, that a signer key is what it got.

import "fake-indexeddb/auto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newWitness } from "webtessera";
import {
	deleteDeviceKey,
	fromCryptoKey,
	loadDeviceKey,
	openBrowserLog,
	openDeviceKey,
	saveDeviceKey,
} from "webtessera/browser";
import {
	generateLogKey,
	generateLogKeyPair,
	importLogKey,
	openServerLog,
	parseReceipt,
	type ServerLog,
	verifyReceipt,
	WebtesseraError,
} from "webtessera/server";
import { cosignerVkey, newSignerForCosignatureV1, newWitnessServer } from "webtessera/witness";
import { newInProcessLockManager } from "../storage/indexeddb/testing/locks.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { fromSqliteSync } from "../storage/sqlite/adapters/sync.ts";
import { generateKey } from "../vendor/note/note.ts";

const enc = new TextEncoder();
const origin = "example.com/secrets";
const { skey, vkey } = generateKey(undefined, origin);
// The secret part of the signer key, PRIVATE+KEY+<name>+<hash>+<key>: its base64 Ed25519
// seed, which may itself contain "+".
const secret = skey.split("+").slice(4).join("+");

// The forms a signer key reaches the wrong place in: as it is, with the whitespace an env
// file or a paste adds, with its variable name, quoted, and in another case.
const forms = [skey, ` ${skey}\n`, `LOG_SKEY=${skey}`, JSON.stringify(skey), skey.toLowerCase()];

/** errorOf runs fn and returns what it threw or rejected with. */
async function errorOf(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	throw new Error("expected an error");
}

/** expectNoSecret checks that neither err nor any error in its cause chain repeats the key. */
function expectNoSecret(err: unknown, name: string): void {
	expect(err, name).toBeInstanceOf(Error);
	for (let e: unknown = err; e instanceof Error; e = e.cause) {
		const text = `${e.message}\n${e.stack ?? ""}`;
		expect(text, name).not.toContain(secret);
		expect(text.toLowerCase(), name).not.toContain(secret.toLowerCase());
	}
}

beforeEach(() => {
	vi.stubGlobal("navigator", { locks: newInProcessLockManager() });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a signer key where a public string belongs", () => {
	let log: ServerLog;
	let receipt: string;
	const data = enc.encode("entry");

	beforeEach(async () => {
		log = await openServerLog({ key: await generateLogKey(origin), storage: { memory: true } });
		receipt = (await log.append(data)).text;
	});

	afterEach(async () => {
		await log.close();
	});

	// Each case is a call that takes a verifier key, an origin, a receipt or a name, given s.
	const misused: [string, (s: string) => unknown][] = [
		["verifyReceipt vkey", (s) => verifyReceipt(receipt, { vkey: s, data })],
		["verifyReceipt origin", (s) => verifyReceipt(receipt, { vkey: log.vkey, data, origin: s })],
		[
			"verifyReceipt witness policy",
			(s) => verifyReceipt(receipt, { vkey: log.vkey, data, witnesses: { threshold: 1, witnesses: [s] } }),
		],
		["verifyReceipt receipt", (s) => verifyReceipt(s, { vkey: log.vkey, data })],
		["verifyReceipt receipt bytes", (s) => verifyReceipt(enc.encode(s), { vkey: log.vkey, data })],
		["parseReceipt", (s) => parseReceipt(s)],
		["log.verify receipt", (s) => log.verify(s, data)],
		["generateLogKey origin", (s) => generateLogKey(s)],
		["generateLogKeyPair origin", (s) => generateLogKeyPair(s)],
		["openServerLog key", (s) => openServerLog({ key: s as never, storage: { memory: true } })],
		[
			"openServerLog storage.namespace",
			async (s) =>
				openServerLog({
					key: await generateLogKey(origin),
					storage: { sqlite: fromSqliteSync(new DatabaseSync(":memory:")), namespace: s },
				}),
		],
		[
			"openServerLog storage.locking",
			async (s) =>
				openServerLog({
					key: await generateLogKey(origin),
					storage: { sqlite: fromSqliteSync(new DatabaseSync(":memory:")), locking: s as never },
				}),
		],
		["openBrowserLog key", (s) => openBrowserLog({ key: s as never })],
		[
			"openBrowserLog storage.indexedDB",
			async (s) => openBrowserLog({ key: await openDeviceKey(`${origin}/browser`), storage: { indexedDB: s } }),
		],
		["openDeviceKey origin", (s) => openDeviceKey(s)],
		["openDeviceKey id", (s) => openDeviceKey(origin, { id: s })],
		["openDeviceKey database", (s) => openDeviceKey(origin, { database: s })],
		["loadDeviceKey origin", (s) => loadDeviceKey(s)],
		["loadDeviceKey id", (s) => loadDeviceKey(origin, { id: s })],
		["deleteDeviceKey origin", (s) => deleteDeviceKey(s)],
		["deleteDeviceKey id", (s) => deleteDeviceKey(origin, { id: s })],
		["saveDeviceKey id", async (s) => saveDeviceKey(await generateLogKey(origin), { id: s })],
		[
			"fromCryptoKey origin",
			async (s) => {
				const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
				return fromCryptoKey(s, pair);
			},
		],
	];

	for (const [name, fn] of misused) {
		it(`is refused, unrepeated, by ${name}`, async () => {
			for (const s of forms) {
				const err = await errorOf(() => fn(s));
				expectNoSecret(err, `${name}: ${JSON.stringify(s.slice(0, 12))}`);
				expect(err, name).toBeInstanceOf(WebtesseraError);
				expect((err as WebtesseraError).code, name).toBe("SIGNER_KEY_MISUSE");
			}
		});
	}

	// Inputs that are no place for a key either, whose errors quote what they were given.
	const quoted: [string, (s: unknown) => unknown][] = [
		["prove index", (s) => log.prove(s as never)],
		["entries from", (s) => log.entries(s as never)],
		["entry index", (s) => log.entry(s as never)],
		["append timeoutMs", (s) => log.append(data, { timeoutMs: s as never })],
		["fsck workers", (s) => log.fsck({ workers: s as never })],
		["generateLogKey fallback", (s) => generateLogKey(origin, { fallback: s as never })],
		["importLogKey fallback", (s) => importLogKey(skey, { fallback: s as never })],
		[
			"checkpointIntervalMs",
			async (s) =>
				openServerLog({
					key: await generateLogKey(origin),
					storage: { memory: true },
					checkpointIntervalMs: s as never,
				}),
		],
		[
			"storage.locking",
			async (s) =>
				openServerLog({
					key: await generateLogKey(origin),
					storage: { sqlite: fromSqliteSync(new DatabaseSync(":memory:")), locking: s as never },
				}),
		],
	];

	// A key can also arrive inside a value that is not a string, which converting to a string
	// would print: in an array, an object with a toString, a symbol's description.
	const wrapped = [...forms, ...forms.map((f) => [f]), { toString: () => skey }, Symbol(skey)];

	for (const [name, fn] of quoted) {
		it(`is not repeated by ${name}`, async () => {
			for (const s of wrapped) {
				const err = await errorOf(() => fn(s));
				expectNoSecret(err, name);
				expect(err, name).toBeInstanceOf(WebtesseraError);
			}
		});
	}

	it("is not repeated by parseReceipt for text that is no receipt but holds a key inside a line", () => {
		for (const text of [`c2sp.org/tlog-proof@v1\nindex ${skey}\n`, `c2sp.org/tlog-proof@v1\nindex 0 ${skey}\n`]) {
			const err = (() => {
				try {
					parseReceipt(text);
				} catch (e) {
					return e;
				}
				throw new Error("expected an error");
			})();
			expectNoSecret(err, JSON.stringify(text.slice(0, 32)));
			expect((err as WebtesseraError).code).toBe("SIGNER_KEY_MISUSE");
		}
	});

	it("refuses a namespace the SQLite store would refuse, with a code", async () => {
		for (const namespace of ["Bad-Name", "", "x".repeat(65), 7]) {
			const err = await errorOf(async () =>
				openServerLog({
					key: await generateLogKey(origin),
					storage: { sqlite: fromSqliteSync(new DatabaseSync(":memory:")), namespace: namespace as never },
				}),
			);
			expect(err, String(namespace)).toBeInstanceOf(WebtesseraError);
			expect((err as WebtesseraError).code, String(namespace)).toBe("INVALID_ARGUMENT");
		}
	});

	it("is not repeated, and no TypeError escapes, for an option that cannot become a string", async () => {
		const err = await errorOf(async () =>
			openServerLog({
				key: await generateLogKey(origin),
				storage: { sqlite: fromSqliteSync(new DatabaseSync(":memory:")), locking: Object.create(null) as never },
			}),
		);
		expect(err).toBeInstanceOf(WebtesseraError);
		expect((err as WebtesseraError).code).toBe("INVALID_ARGUMENT");
	});

	it("is not repeated by importLogKey, whichever way the key is malformed", async () => {
		for (const s of [
			skey.slice(0, -2),
			`${skey.slice(0, -2)}!!`,
			skey.replace("PRIVATE+KEY+", "PRIVATE+KEY+ "),
			...forms.slice(1),
		]) {
			expectNoSecret(await errorOf(() => importLogKey(s)), JSON.stringify(s.slice(0, 16)));
		}
	});
});

describe("a signer key in a witness's configuration or requests", () => {
	const witnessKey = generateKey(undefined, "witness.example");
	const signer = newSignerForCosignatureV1(witnessKey.skey);

	it("is refused, unrepeated, as a log's verifier key or origin", async () => {
		for (const s of forms) {
			expectNoSecret(
				await errorOf(() =>
					newWitnessServer({ signer, store: new MemoryObjectStore(), logs: [{ origin, verifierKeys: [s] }] }),
				),
				"verifierKeys",
			);
			expectNoSecret(
				await errorOf(() =>
					newWitnessServer({
						signer,
						store: new MemoryObjectStore(),
						logs: [
							{ origin: s, verifierKeys: [vkey] },
							{ origin: s, verifierKeys: [vkey] },
						],
					}),
				),
				"origin",
			);
		}
		const err = (await errorOf(() =>
			newWitnessServer({ signer, store: new MemoryObjectStore(), logs: [{ origin, verifierKeys: [skey] }] }),
		)) as Error;
		expect(err.message).toMatch(
			/one of its verifier keys is a signer \(private\) key; configure the log's verifier key/,
		);
	});

	it("is not repeated when lookupLog returns one, or a request's origin line is one", async () => {
		const witness = newWitnessServer({
			signer,
			store: new MemoryObjectStore(),
			lookupLog: () => ({ verifierKeys: [skey] }),
		});
		const checkpoint = enc.encode(`${skey}\n1\n${btoa(String.fromCharCode(...new Uint8Array(32)))}\n\n— x AAAA\n`);
		expectNoSecret(await errorOf(() => witness.addCheckpoint({ oldSize: 0n, proof: [], checkpoint })), "lookupLog");
		const strict = newWitnessServer({
			signer,
			store: new MemoryObjectStore(),
			logs: [{ origin, verifierKeys: [vkey] }],
		});
		expectNoSecret(await errorOf(() => strict.addCheckpoint({ oldSize: 0n, proof: [], checkpoint })), "origin line");
		const res = await strict.handle(
			new Request("https://witness.example/add-checkpoint", {
				method: "POST",
				body: `old 0\n\n${new TextDecoder().decode(checkpoint)}`,
			}),
		);
		expect(await res?.text()).not.toContain(secret);
	});

	it("is not repeated by the ported witness constructors, nor by cosignerVkey", async () => {
		for (const s of forms) {
			expectNoSecret(await errorOf(() => newWitness(s, new URL("https://w.example/"))), "newWitness");
			expectNoSecret(await errorOf(() => newSignerForCosignatureV1(vkey)), "newSignerForCosignatureV1(vkey)");
		}
		expectNoSecret(await errorOf(() => cosignerVkey(skey.replace("PRIVATE+KEY+", "PRIVATE+KEY+ "))), "cosignerVkey");
	});
});
