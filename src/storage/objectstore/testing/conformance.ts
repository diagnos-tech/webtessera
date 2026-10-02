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

// Shared contract tests for ObjectStore implementations. Every backend's test file
// calls describeObjectStoreConformance with a factory for fresh, empty stores, so
// that memory, IndexedDB and Durable Object storage are held to exactly the same
// behaviour. Test-only: excluded from the published build.

import { describe, expect, it } from "vitest";
import type { ObjectStore } from "../objectstore.ts";

/** NewStore returns a fresh, empty store. Each test calls it once. */
export type NewStore = () => ObjectStore | Promise<ObjectStore>;

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
	return enc.encode(s);
}

function filled(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		b[i] = (i * 31 + seed) & 0xff;
	}
	return b;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/**
 * describeObjectStoreConformance registers the ObjectStore contract suite under a
 * describe block called name.
 */
export function describeObjectStoreConformance(name: string, newStore: NewStore): void {
	describe(`${name}: ObjectStore conformance`, () => {
		it("reports missing objects as undefined", async () => {
			const s = await newStore();
			expect(await s.get("checkpoint")).toBeUndefined();
			expect(await s.stat("checkpoint")).toBeUndefined();
		});

		it("round-trips put and get", async () => {
			const s = await newStore();
			const before = Date.now();
			await s.put("tile/0/x001/234", bytes("hello"));
			const after = Date.now();

			expect(await s.get("tile/0/x001/234")).toEqual(bytes("hello"));
			const info = await s.stat("tile/0/x001/234");
			expect(info?.size).toBe(5);
			expect(info?.modTime).toBeGreaterThanOrEqual(before);
			expect(info?.modTime).toBeLessThanOrEqual(after);
		});

		it("round-trips an empty object", async () => {
			const s = await newStore();
			await s.put("empty", new Uint8Array(0));
			expect(await s.get("empty")).toEqual(new Uint8Array(0));
			expect((await s.stat("empty"))?.size).toBe(0);
		});

		it("returns a real Uint8Array", async () => {
			const s = await newStore();
			await s.put("k", bytes("v"));
			const got = await s.get("k");
			expect(got).toBeInstanceOf(Uint8Array);
		});

		it("overwrites with put", async () => {
			const s = await newStore();
			await s.put("checkpoint", bytes("one"));
			const first = await s.stat("checkpoint");
			await s.put("checkpoint", bytes("three"));
			expect(await s.get("checkpoint")).toEqual(bytes("three"));
			const second = await s.stat("checkpoint");
			expect(second?.size).toBe(5);
			expect(second?.modTime).toBeGreaterThanOrEqual(first?.modTime ?? Number.POSITIVE_INFINITY);
		});

		it("keeps stored objects independent of caller-owned arrays", async () => {
			const s = await newStore();
			const data = bytes("abc");
			await s.put("k", data);
			data[0] = 0x7a;
			const got = await s.get("k");
			expect(got).toEqual(bytes("abc"));
			if (got !== undefined) {
				got[1] = 0x7a;
			}
			expect(await s.get("k")).toEqual(bytes("abc"));
		});

		it("creates only when absent", async () => {
			const s = await newStore();
			expect(await s.create(".state/version", bytes("1"))).toBe(true);
			expect(await s.create(".state/version", bytes("2"))).toBe(false);
			expect(await s.get(".state/version")).toEqual(bytes("1"));
		});

		it("lets exactly one of several concurrent creates win", async () => {
			const s = await newStore();
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, i) => s.create("tile/entries/000", bytes(`writer ${i}`))),
			);
			expect(results.filter((r) => r)).toHaveLength(1);
			const winner = results.indexOf(true);
			expect(await s.get("tile/entries/000")).toEqual(bytes(`writer ${winner}`));
		});

		it("deletes by prefix, and only by prefix", async () => {
			const s = await newStore();
			const keep = ["tile/0/x001/234", "tile/0/x001/2345.p/1", "tile/0/x001/233.p/1", "checkpoint"];
			const drop = ["tile/0/x001/234.p/1", "tile/0/x001/234.p/17", "tile/0/x001/234.p/255"];
			for (const k of [...keep, ...drop]) {
				await s.put(k, bytes(k));
			}

			await s.deletePrefix("tile/0/x001/234.p/");

			for (const k of drop) {
				expect(await s.get(k), k).toBeUndefined();
			}
			for (const k of keep) {
				expect(await s.get(k), k).toEqual(bytes(k));
			}
		});

		it("treats deleting a prefix that matches nothing as a no-op", async () => {
			const s = await newStore();
			await s.put("checkpoint", bytes("cp"));
			await s.deletePrefix("tile/");
			expect(await s.get("checkpoint")).toEqual(bytes("cp"));
		});

		it("round-trips large objects", async () => {
			const s = await newStore();
			// Entry bundles hold up to 256 entries of up to 64 KiB each, so objects far
			// larger than any per-value limit of the underlying backend must survive.
			for (const [key, size] of [
				["tile/entries/000", 200 * 1024],
				["tile/entries/001", 1024 * 1024 + 7],
				["tile/entries/002", 5 * 1024 * 1024],
			] as const) {
				const want = filled(size, size);
				await s.put(key, want);
				expect((await s.stat(key))?.size, key).toBe(size);
				const got = await s.get(key);
				expect(got?.length, key).toBe(size);
				expect(got, key).toEqual(want);
			}
		});

		it("shrinks a large object in place", async () => {
			const s = await newStore();
			await s.put("tile/entries/000", filled(3 * 1024 * 1024, 1));
			await s.put("tile/entries/000", bytes("small"));
			expect(await s.get("tile/entries/000")).toEqual(bytes("small"));
			expect((await s.stat("tile/entries/000"))?.size).toBe(5);
		});

		it("deletes large objects by prefix", async () => {
			const s = await newStore();
			await s.put("tile/entries/000.p/9", filled(3 * 1024 * 1024, 2));
			await s.put("tile/entries/000", bytes("full"));
			await s.deletePrefix("tile/entries/000.p/");
			expect(await s.get("tile/entries/000.p/9")).toBeUndefined();
			expect(await s.stat("tile/entries/000.p/9")).toBeUndefined();
			expect(await s.get("tile/entries/000")).toEqual(bytes("full"));
		});

		it("returns the result of the locked function", async () => {
			const s = await newStore();
			expect(await s.lock("treeState.lock", async () => 42)).toBe(42);
		});

		it("serialises holders of the same lock", async () => {
			const s = await newStore();
			const events: string[] = [];
			const gate = deferred();
			const first = s.lock("treeState.lock", async () => {
				events.push("first:start");
				await gate.promise;
				events.push("first:end");
			});
			const second = s.lock("treeState.lock", async () => {
				events.push("second:start");
				events.push("second:end");
			});
			// Give the second holder every chance to (wrongly) run.
			await new Promise((r) => setTimeout(r, 50));
			expect(events).toEqual(["first:start"]);
			gate.resolve();
			await Promise.all([first, second]);
			expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
		});

		it("does not serialise holders of different locks", async () => {
			const s = await newStore();
			const gate = deferred();
			const first = s.lock("treeState.lock", () => gate.promise);
			const second = s.lock("publish.lock", async () => "ran");
			expect(await second).toBe("ran");
			gate.resolve();
			await first;
		});

		it("releases a lock whose holder throws", async () => {
			const s = await newStore();
			await expect(
				s.lock("gc.lock", async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(await s.lock("gc.lock", async () => "next")).toBe("next");
		});

		it("rejects without running fn when the signal is already aborted", async () => {
			const s = await newStore();
			const ac = new AbortController();
			ac.abort(new Error("cancelled"));
			let ran = false;
			await expect(
				s.lock(
					"treeState.lock",
					async () => {
						ran = true;
					},
					ac.signal,
				),
			).rejects.toThrow("cancelled");
			expect(ran).toBe(false);
		});

		it("stops waiting for a lock when the signal is aborted", async () => {
			const s = await newStore();
			const gate = deferred();
			const holder = s.lock("treeState.lock", () => gate.promise);
			const ac = new AbortController();
			let ran = false;
			const waiter = s.lock(
				"treeState.lock",
				async () => {
					ran = true;
				},
				ac.signal,
			);
			ac.abort(new Error("gave up"));
			await expect(waiter).rejects.toThrow("gave up");
			gate.resolve();
			await holder;
			expect(ran).toBe(false);
			// The abandoned wait must not leave the lock wedged.
			expect(await s.lock("treeState.lock", async () => "free")).toBe("free");
		});
	});
}
