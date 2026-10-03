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
// Runs this device's log in a real Chromium: IndexedDB, Web Locks and a non-extractable WebCrypto
// key are the browser's own. Each test uses a log of its own, named by a fresh origin.

import { describe, expect, it } from "vitest";
import { loadDeviceKey, ReceiptError, verifyReceipt } from "webtessera/browser";
import { TLogProof } from "webtessera/formats/proof";
import { forgetDevice, openDeviceLog } from "./device_log.ts";
import { encodeEvent } from "./events.ts";
import { readHistory, verifyByHand } from "./history.ts";
import type { SecondTabReceipt, SecondTabRequest } from "./testing/second_tab.ts";

const fast = { checkpointIntervalMs: 100 };

function freshOrigin(): string {
	return `device.test/device/${crypto.randomUUID().replaceAll("-", "")}`;
}

function event(text: string): Uint8Array {
	return encodeEvent({ at: new Date().toISOString(), text });
}

/** reason returns why verifyReceipt refuses a receipt. */
function reason(check: () => unknown): string {
	try {
		check();
	} catch (err) {
		if (err instanceof ReceiptError) {
			return err.reason;
		}
		throw err;
	}
	return "verified";
}

describe("this device's log, in Chromium", () => {
	it("is signed by a device key no script can export, and hands back receipts that verify", async () => {
		const { log, key } = await openDeviceLog({ origin: freshOrigin(), ...fast });
		expect([key.backend, key.extractable]).toEqual(["webcrypto", false]);
		expect(log.lockScope).toBe("origin");

		const data = event("signed the consent form");
		const receipt = await log.append(data);
		expect(verifyReceipt(receipt.text, { vkey: log.vkey, data }).index).toBe(0n);
		await log.close();
	});

	it("refuses a receipt that was tampered with, is for other data, or is checked with another key", async () => {
		const { log } = await openDeviceLog({ origin: freshOrigin(), ...fast });
		await log.append(event("first"));
		const data = event("second");
		const receipt = await log.append(data);
		const other = await openDeviceLog({ origin: freshOrigin(), ...fast });

		const flipped = receipt.proof.hashes.map((h) => h.slice());
		flipped[0]?.set([(flipped[0][0] ?? 0) ^ 1]);
		const tampered = new TLogProof({ index: receipt.index, hashes: flipped, checkpoint: receipt.proof.checkpoint });

		expect(reason(() => verifyReceipt(receipt, { vkey: log.vkey, data: event("third") }))).toBe("inclusion");
		expect(reason(() => verifyReceipt(tampered, { vkey: log.vkey, data }))).toBe("inclusion");
		expect(reason(() => verifyReceipt(receipt, { vkey: other.log.vkey, data }))).toBe("signature");
		await log.close();
		await other.log.close();
	});

	it("survives a reload: the key and the log are found again by the log's origin", async () => {
		const origin = freshOrigin();
		const first = await openDeviceLog({ origin, ...fast });
		await first.log.append(event("before the reload"));
		await first.log.append(event("also before"));
		await first.log.close();

		const again = await openDeviceLog({ origin, ...fast });
		expect(again.log.vkey).toBe(first.log.vkey);
		expect((await again.log.latestCheckpoint()).size).toBe(2n);
		expect((await readHistory(again.log)).map((e) => e.event.text)).toEqual(["also before", "before the reload"]);
		await again.log.close();
	});

	it("shares one log between two tabs, which take turns through Web Locks", async () => {
		const origin = freshOrigin();
		const { log } = await openDeviceLog({ origin, ...fast });
		const worker = new Worker(new URL("./testing/second_tab.ts", import.meta.url), { type: "module" });
		const fromWorker = new Promise<SecondTabReceipt[]>((resolve) =>
			worker.addEventListener("message", (e: MessageEvent<SecondTabReceipt[]>) => resolve(e.data), { once: true }),
		);
		worker.postMessage({ origin, count: 10 } satisfies SecondTabRequest);
		const mine = await Promise.all(Array.from({ length: 10 }, (_, i) => log.append(event(`from this tab, ${i}`))));
		const theirs = await fromWorker;
		worker.terminate();

		// Twenty events, twenty distinct indices, and every receipt from either tab verifies.
		const indices = [...mine.map((r) => r.index), ...theirs.map((r) => BigInt(r.index))];
		expect(new Set(indices).size).toBe(20);
		for (const r of theirs) {
			verifyReceipt(r.receipt, { vkey: log.vkey, data: r.data });
		}
		expect((await log.latestCheckpoint()).size).toBe(20n);
		await log.close();
	});

	it("refuses to open without Web Locks, unless the page promises this tab is the only writer", async () => {
		const origin = freshOrigin();
		Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
		try {
			await expect(openDeviceLog({ origin, ...fast })).rejects.toThrow(/Web Locks/);
			const { log } = await openDeviceLog({ origin, singleWriter: true, ...fast });
			expect(log.lockScope).toBe("realm");
			await log.close();
		} finally {
			// Removing the page's own property uncovers Navigator.prototype.locks again.
			Reflect.deleteProperty(navigator, "locks");
		}
		expect(typeof navigator.locks.request).toBe("function");
	});

	it("verifies by hand, with the ported API, exactly what the receipt proves", async () => {
		const { log } = await openDeviceLog({ origin: freshOrigin(), ...fast });
		for (const text of ["one", "two", "three"]) {
			await log.append(event(text));
		}
		const [newest] = await readHistory(log);
		expect(newest?.event.text).toBe("three");
		if (newest !== undefined) {
			expect(await verifyByHand(log, newest)).toEqual(newest.receipt.proof.hashes);
		}
		await log.close();
	});

	it("forgets the device: the key and the log are gone, and old receipts still verify", async () => {
		const origin = freshOrigin();
		const { log } = await openDeviceLog({ origin, ...fast });
		const data = event("worth keeping");
		const receipt = await log.append(data);
		await forgetDevice(log);
		expect(await loadDeviceKey(origin)).toBeUndefined();
		expect(verifyReceipt(receipt.text, { vkey: log.vkey, data }).index).toBe(0n);
	});
});
