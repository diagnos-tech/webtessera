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

// Tests webtessera/server inside workerd, an edge runtime that defines neither `window` nor
// `document` and whose global scope is a ServiceWorkerGlobalScope: it must be recognised
// as the private environment it is, hold keys as non-extractable WebCrypto keys, and run
// a log on D1 and on a Durable Object's SQLite.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { describeWebCryptoGolden } from "../safe/testing/golden.ts";
import { fromD1 } from "../storage/sqlite/adapters/d1.ts";
import { fromDurableObjectStorage } from "../storage/sqlite/adapters/durableobject.ts";
import { uniqueNamespace } from "../storage/sqlite/testing/stores.ts";
import { inFreshObject } from "../storage/sqlite/testing/workers/objects.ts";
import { generateKey } from "../vendor/note/note.ts";
// Importing the entry point runs its runtime check, which must pass here.
import {
	detectRuntime,
	generateLogKey,
	importLogKey,
	openServerLog,
	verifyReceipt,
	webCryptoEd25519,
} from "./index.ts";

describeWebCryptoGolden("workerd");

const enc = new TextEncoder();

describe("webtessera/server in workerd", () => {
	it("recognises workerd as a server runtime", () => {
		expect(detectRuntime()).toBe("workerd");
	});

	it("holds keys as non-extractable WebCrypto keys", async () => {
		expect(await webCryptoEd25519()).toBe(true);
		const generated = await generateLogKey("example.com/log");
		expect([generated.backend, generated.extractable]).toEqual(["webcrypto", false]);
		const imported = await importLogKey(generateKey(undefined, "example.com/log").skey);
		expect([imported.backend, imported.extractable]).toEqual(["webcrypto", false]);
	});

	it("runs a log in memory", async () => {
		const log = await openServerLog({ key: await generateLogKey("example.com/log"), storage: { memory: true } });
		try {
			const data = enc.encode("hello from the edge");
			expect(verifyReceipt((await log.append(data)).text, { vkey: log.vkey, data }).index).toBe(0n);
			expect((await log.handler(new Request("https://log.example/checkpoint")))?.status).toBe(200);
		} finally {
			await log.close();
		}
	});

	it("runs a log on D1, with lease locking, that a second instance continues", async () => {
		const { skey } = generateKey(undefined, "example.com/d1");
		const namespace = uniqueNamespace();
		const first = await openServerLog({
			key: await importLogKey(skey),
			storage: { sqlite: fromD1(env.DB), namespace },
		});
		const data = enc.encode("first");
		const r = await first.append(data);
		await first.close();
		const second = await openServerLog({
			key: await importLogKey(skey),
			storage: { sqlite: fromD1(env.DB), namespace },
		});
		try {
			expect((await second.append(enc.encode("second"))).index).toBe(1n);
			expect(verifyReceipt(r.text, { vkey: second.vkey, data }).index).toBe(0n);
		} finally {
			await second.close();
		}
	});

	for (const locking of [undefined, "local"] as const) {
		it(`runs a log in a Durable Object's SQLite (${locking ?? "default lease"} locking)`, async () => {
			const key = await generateLogKey("example.com/do");
			await inFreshObject(env.SQLITE_OBJECT, async (storage) => {
				const sqlite = fromDurableObjectStorage(storage);
				const log = await openServerLog({
					key,
					storage: locking === undefined ? { sqlite } : { sqlite, locking },
				});
				try {
					const data = enc.encode("in a Durable Object");
					expect(log.verify(await log.append(data), data).index).toBe(0n);
				} finally {
					await log.close();
				}
			});
		});
	}
});
