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

// MemoryObjectStore is held to the shared ObjectStore contract suite, plus the behaviour
// specific to it: the keys() listing, lock bookkeeping, and newMemoryDriver's wiring.

import { describe, expect, it } from "vitest";
import { ObjectStoreDriver } from "../objectstore/driver.ts";
import { describeObjectStoreConformance } from "../objectstore/testing/conformance.ts";
import { MemoryObjectStore, newMemoryDriver } from "./memory.ts";

describeObjectStoreConformance("memory", () => new MemoryObjectStore());

const enc = new TextEncoder();

describe("MemoryObjectStore", () => {
	it("lists keys in ascending order, optionally by prefix", async () => {
		const s = new MemoryObjectStore();
		for (const k of ["tile/0/001", "checkpoint", "tile/0/000", ".state/treeState", "tile/entries/000"]) {
			await s.put(k, enc.encode(k));
		}
		expect(s.keys()).toEqual([".state/treeState", "checkpoint", "tile/0/000", "tile/0/001", "tile/entries/000"]);
		expect(s.keys("tile/0/")).toEqual(["tile/0/000", "tile/0/001"]);
		expect(s.keys("nothing/")).toEqual([]);
	});

	it("copies a Uint8Array view rather than its whole backing buffer", async () => {
		const s = new MemoryObjectStore();
		const backing = enc.encode("0123456789");
		await s.put("k", backing.subarray(2, 5));
		const got = await s.get("k");
		expect(got).toEqual(enc.encode("234"));
		expect(got?.buffer.byteLength).toBe(3);
	});

	it("does not run fn for any waiter queued behind an abandoned one", async () => {
		const s = new MemoryObjectStore();
		let release!: () => void;
		const holder = s.lock(
			"treeState.lock",
			() =>
				new Promise<void>((r) => {
					release = r;
				}),
		);
		const ac = new AbortController();
		const order: string[] = [];
		const abandoned = s.lock(
			"treeState.lock",
			async () => {
				order.push("abandoned");
			},
			ac.signal,
		);
		const next = s.lock("treeState.lock", async () => {
			order.push("next");
		});
		ac.abort(new Error("gave up"));
		await expect(abandoned).rejects.toThrow("gave up");
		release();
		await holder;
		await next;
		expect(order).toEqual(["next"]);
	});

	it("keeps excluding a later holder while an abandoned waiter is still queued", async () => {
		const s = new MemoryObjectStore();
		let releaseFirst!: () => void;
		const first = s.lock(
			"publish.lock",
			() =>
				new Promise<void>((r) => {
					releaseFirst = r;
				}),
		);
		const ac = new AbortController();
		const abandoned = s.lock("publish.lock", async () => undefined, ac.signal);
		ac.abort(new Error("gave up"));
		await expect(abandoned).rejects.toThrow("gave up");

		let secondRan = false;
		const second = s.lock("publish.lock", async () => {
			secondRan = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(secondRan).toBe(false);
		releaseFirst();
		await Promise.all([first, second]);
		expect(secondRan).toBe(true);
	});
});

describe("newMemoryDriver", () => {
	it("returns an ObjectStoreDriver over a fresh store by default", () => {
		const d = newMemoryDriver();
		expect(d).toBeInstanceOf(ObjectStoreDriver);
		expect(d.cfg.store).toBeInstanceOf(MemoryObjectStore);
		expect(newMemoryDriver().cfg.store).not.toBe(d.cfg.store);
	});

	it("uses the store it is given", () => {
		const store = new MemoryObjectStore();
		expect(newMemoryDriver({ store }).cfg.store).toBe(store);
	});

	it("routes outgoing requests through the fetch it is given, without a receiver", async () => {
		const calls: string[] = [];
		let receiver: unknown = "unset";
		const fetch = function (this: unknown, input: string): Promise<Response> {
			receiver = this;
			calls.push(input);
			return Promise.resolve(new Response("ok"));
		};
		const d = newMemoryDriver({ fetch });
		const r = await d.cfg.fetch("https://witness.example/add-checkpoint");
		expect(await r.text()).toBe("ok");
		expect(calls).toEqual(["https://witness.example/add-checkpoint"]);
		expect(receiver).toBeUndefined();
	});
});
