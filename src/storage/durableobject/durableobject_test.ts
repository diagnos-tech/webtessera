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

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bytesEqual } from "../../internal/gostd/bytes.ts";
import { describeObjectStoreConformance } from "../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../objectstore/testing/driver_conformance.ts";
import {
	DefaultMaxValueBytes,
	DurableObjectObjectStore,
	type DurableObjectStorageLike,
	type DurableObjectTransactionLike,
} from "./durableobject.ts";
import { inFreshObject, storeFactory, type TestNamespace } from "./testing/stores.ts";
import {
	KVBackedLimits,
	LooseStorage,
	SQLiteBackedLimits,
	type StorageLimits,
	StrictStorage,
} from "./testing/strict.ts";

const backends: readonly { name: string; ns: TestNamespace; limits: StorageLimits }[] = [
	{ name: "KV-backed", ns: env.KV_OBJECT, limits: KVBackedLimits },
	{ name: "SQLite-backed", ns: env.SQLITE_OBJECT, limits: SQLiteBackedLimits },
];

function filled(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		b[i] = (i * 31 + seed) & 0xff;
	}
	return b;
}

/** storedKeys lists the raw storage keys under prefix, chunk keys included. */
async function storedKeys(storage: DurableObjectStorage, prefix: string): Promise<string[]> {
	return [...(await storage.list({ prefix })).keys()];
}

/** chunksOf lists the raw storage keys of the chunks of the object at key. */
function chunksOf(storage: DurableObjectStorage, key: string): Promise<string[]> {
	return storedKeys(storage, `${key}\u0000`);
}

for (const { name, ns, limits } of backends) {
	const plain = storeFactory(ns, (storage) => new DurableObjectObjectStore({ storage }));
	describeObjectStoreConformance(`DurableObjectObjectStore (${name})`, plain.newStore);
	describeDriverConformance(`DurableObjectObjectStore (${name})`, plain.newStore, { reopen: plain.reopen });

	// Both suites again, with values small enough that every large object in them spans
	// many chunks, under the production limits local workerd does not enforce.
	// One StrictStorage per object, so that a reopened store shares the original's
	// storage object, and with it the original's locks.
	const strictStorages = new WeakMap<DurableObjectStorage, StrictStorage>();
	const strict = storeFactory(ns, (storage) => {
		let wrapped = strictStorages.get(storage);
		if (wrapped === undefined) {
			wrapped = new StrictStorage(storage, limits);
			strictStorages.set(storage, wrapped);
		}
		return new DurableObjectObjectStore({ storage: wrapped, maxValueBytes: 4096 });
	});
	const strictName = `DurableObjectObjectStore (${name}, 4 KiB values, production limits)`;
	describeObjectStoreConformance(strictName, strict.newStore);
	describeDriverConformance(strictName, strict.newStore, { reopen: strict.reopen });

	describe(`DurableObjectObjectStore (${name})`, () => {
		const max = 1000;

		/** withStore runs fn in a fresh object, on a store with maxValueBytes = max. */
		function withStore<R>(
			fn: (s: DurableObjectObjectStore, storage: DurableObjectStorage, strict: StrictStorage) => Promise<R>,
		): Promise<R> {
			return inFreshObject(ns, (storage) => {
				const strict = new StrictStorage(storage, limits);
				return fn(new DurableObjectObjectStore({ storage: strict, maxValueBytes: max }), storage, strict);
			});
		}

		it("accepts the runtime's storage and transaction types", async () => {
			// The assertions that matter here are the two assignments, checked by
			// `tsc -p tsconfig.workers.json` against @cloudflare/workers-types.
			await inFreshObject(ns, async (storage) => {
				const like: DurableObjectStorageLike = storage;
				await storage.transaction(async (txn) => {
					const t: DurableObjectTransactionLike = txn;
					await t.put({ k: 1 });
				});
				expect(await like.get("k")).toBe(1);
			});
		});

		it("stores objects of at most maxValueBytes inline", async () => {
			await withStore(async (s, storage) => {
				for (const size of [0, max - 1, max]) {
					const key = `inline/${size}`;
					await s.put(key, filled(size, size));
					expect(await storedKeys(storage, key)).toEqual([key]);
					expect(bytesEqual((await s.get(key)) ?? new Uint8Array(1), filled(size, size))).toBe(true);
					expect((await s.stat(key))?.size).toBe(size);
				}
			});
		});

		it("splits larger objects into chunks of maxValueBytes", async () => {
			await withStore(async (s, storage) => {
				await s.put("big", filled(max + 1, 7));
				const chunks = await chunksOf(storage, "big");
				expect(chunks).toHaveLength(2);
				const sizes = await Promise.all(chunks.map(async (k) => (await storage.get<Uint8Array>(k))?.length));
				expect(sizes.sort()).toEqual([1, max]);
				expect(bytesEqual((await s.get("big")) ?? new Uint8Array(0), filled(max + 1, 7))).toBe(true);
				expect((await s.stat("big"))?.size).toBe(max + 1);
			});
		});

		it("reads, writes and deletes objects of more than 128 chunks", async () => {
			// StrictStorage fails any call naming more than 128 keys.
			await withStore(async (s, storage) => {
				const want = filled(300 * max + 7, 3);
				await s.put("tile/entries/000", want);
				expect(await chunksOf(storage, "tile/entries/000")).toHaveLength(301);
				expect(bytesEqual((await s.get("tile/entries/000")) ?? new Uint8Array(0), want)).toBe(true);
				await s.deletePrefix("tile/");
				expect(await storedKeys(storage, "")).toEqual([]);
			});
		});

		it("leaves no stale chunks when an object is overwritten", async () => {
			await withStore(async (s, storage) => {
				for (const size of [5 * max, 3 * max, 7 * max + 1, 2 * max, 10, 4 * max]) {
					await s.put("k", filled(size, size));
					expect(await chunksOf(storage, "k"), `after writing ${size} bytes`).toHaveLength(
						size > max ? Math.ceil(size / max) : 0,
					);
					expect(bytesEqual((await s.get("k")) ?? new Uint8Array(0), filled(size, size))).toBe(true);
				}
			});
		});

		it("deletes chunks with their objects by prefix, and only by prefix", async () => {
			await withStore(async (s, storage) => {
				const drop = ["tile/entries/000.p/9", "tile/entries/000.p/10"];
				const keep = ["tile/entries/000", "tile/entries/0001", "tile/entries/000.p", "tile/entries/001.p/9"];
				for (const [i, k] of [...drop, ...keep].entries()) {
					await s.put(k, filled(3 * max, i));
				}

				await s.deletePrefix("tile/entries/000.p/");

				expect(await storedKeys(storage, "tile/entries/000.p/")).toEqual([]);
				for (const [i, k] of keep.entries()) {
					expect(await chunksOf(storage, k), k).toHaveLength(3);
					expect(bytesEqual((await s.get(k)) ?? new Uint8Array(0), filled(3 * max, drop.length + i)), k).toBe(true);
				}
			});
		});

		it("creates a chunked object only when absent", async () => {
			await withStore(async (s, storage) => {
				expect(await s.create("bundle", filled(4 * max, 1))).toBe(true);
				const before = await storedKeys(storage, "bundle");
				expect(await s.create("bundle", filled(6 * max, 2))).toBe(false);
				expect(await storedKeys(storage, "bundle")).toEqual(before);
				expect(bytesEqual((await s.get("bundle")) ?? new Uint8Array(0), filled(4 * max, 1))).toBe(true);
			});
		});

		it("stores only the bytes a subarray covers", async () => {
			await inFreshObject(ns, async (storage) => {
				const s = new DurableObjectObjectStore({ storage, maxValueBytes: max });
				const backing = filled(64 * max, 5);
				await s.put("inline", backing.subarray(10, 20));
				await s.put("chunked", backing.subarray(max, 4 * max));
				const values = [...(await storage.list({ prefix: "" })).values()];
				const buffers = values.map((v) => (v instanceof Uint8Array ? v : (v as { data?: Uint8Array }).data));
				for (const b of buffers) {
					if (b !== undefined) {
						expect(b.buffer.byteLength).toBeLessThanOrEqual(max);
					}
				}
				expect(await s.get("inline")).toEqual(backing.slice(10, 20));
				expect(bytesEqual((await s.get("chunked")) ?? new Uint8Array(0), backing.slice(max, 4 * max))).toBe(true);
			});
		});

		it("keeps every value within the backend's production limits by default", async () => {
			await inFreshObject(ns, async (storage) => {
				const s = new DurableObjectObjectStore({ storage: new StrictStorage(storage, limits) });
				for (const size of [DefaultMaxValueBytes, DefaultMaxValueBytes + 1, 5 * 1024 * 1024]) {
					await s.put("tile/entries/000", filled(size, size));
					expect((await s.get("tile/entries/000"))?.length).toBe(size);
				}
				await s.deletePrefix("tile/");
			});
		});

		it("returns the newer version when a read races an overwrite", async () => {
			await withStore(async (s, _storage, strict) => {
				await s.put("k", filled(5 * max, 1));
				let raced = false;
				strict.beforeGetMany = async () => {
					if (!raced) {
						raced = true;
						await s.put("k", filled(3 * max, 2));
					}
				};
				const got = await s.get("k");
				expect(raced).toBe(true);
				expect(bytesEqual(got ?? new Uint8Array(0), filled(3 * max, 2))).toBe(true);
			});
		});

		it("returns undefined when a read races a delete", async () => {
			await withStore(async (s, _storage, strict) => {
				await s.put("tile/entries/000.p/1", filled(5 * max, 1));
				strict.beforeGetMany = async () => {
					strict.beforeGetMany = undefined;
					await s.deletePrefix("tile/entries/000.p/");
				};
				expect(await s.get("tile/entries/000.p/1")).toBeUndefined();
			});
		});

		it("keeps only the last writer's chunks under concurrent overwrites", async () => {
			await withStore(async (s, storage) => {
				const sizes = [2, 9, 4, 7, 3, 12, 5].map((n) => n * max + 1);
				await Promise.all(sizes.map((size) => s.put("k", filled(size, size))));
				const got = (await s.get("k")) ?? new Uint8Array(0);
				expect(sizes).toContain(got.length);
				expect(bytesEqual(got, filled(got.length, got.length))).toBe(true);
				expect(await chunksOf(storage, "k")).toHaveLength(Math.ceil(got.length / max));
			});
		});

		it("serialises writes without relying on isolated transactions", async () => {
			await inFreshObject(ns, async (storage) => {
				const s = new DurableObjectObjectStore({ storage: new LooseStorage(storage), maxValueBytes: max });
				const created = await Promise.all(
					Array.from({ length: 8 }, (_, i) => s.create("tile/entries/000", filled(3 * max, i))),
				);
				expect(created.filter((c) => c)).toHaveLength(1);
				expect(
					bytesEqual((await s.get("tile/entries/000")) ?? new Uint8Array(0), filled(3 * max, created.indexOf(true))),
				).toBe(true);

				const sizes = [2, 9, 4, 7].map((n) => n * max + 1);
				await Promise.all(sizes.map((size) => s.put("k", filled(size, size))));
				const got = (await s.get("k")) ?? new Uint8Array(0);
				expect(await chunksOf(storage, "k")).toHaveLength(Math.ceil(got.length / max));
			});
		});

		it("shares locks between stores over the same storage", async () => {
			await inFreshObject(ns, async (storage) => {
				const a = new DurableObjectObjectStore({ storage });
				const b = new DurableObjectObjectStore({ storage });
				const events: string[] = [];
				let release = (): void => {};
				const held = new Promise<void>((r) => {
					release = r;
				});
				const first = a.lock("treeState.lock", async () => {
					events.push("a");
					await held;
				});
				const second = b.lock("treeState.lock", async () => {
					events.push("b");
				});
				await new Promise((r) => setTimeout(r, 20));
				expect(events).toEqual(["a"]);
				release();
				await Promise.all([first, second]);
				expect(events).toEqual(["a", "b"]);
			});
		});

		it("hands a lock past a waiter that gave up", async () => {
			await inFreshObject(ns, async (storage) => {
				const s = new DurableObjectObjectStore({ storage });
				const order: string[] = [];
				let release = (): void => {};
				const holder = s.lock(
					"treeState.lock",
					() =>
						new Promise<void>((r) => {
							release = r;
						}),
				);
				const ac = new AbortController();
				const abandoned = s.lock("treeState.lock", async () => void order.push("abandoned"), ac.signal);
				const next = s.lock("treeState.lock", async () => void order.push("next"));
				ac.abort(new Error("gave up"));
				await expect(abandoned).rejects.toThrow("gave up");
				release();
				await Promise.all([holder, next]);
				expect(order).toEqual(["next"]);
				expect(await s.lock("treeState.lock", async () => "free")).toBe("free");
			});
		});

		it("rejects keys and prefixes containing NUL", async () => {
			await withStore(async (s) => {
				const bad = "tile/entries/000\u0000x.0";
				await expect(s.get(bad)).rejects.toThrow("reserved");
				await expect(s.stat(bad)).rejects.toThrow("reserved");
				await expect(s.put(bad, new Uint8Array(1))).rejects.toThrow("reserved");
				await expect(s.create(bad, new Uint8Array(1))).rejects.toThrow("reserved");
				await expect(s.deletePrefix("tile/\u0000")).rejects.toThrow("reserved");
			});
		});

		it("rejects an invalid maxValueBytes", async () => {
			await inFreshObject(ns, async (storage) => {
				for (const maxValueBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
					expect(() => new DurableObjectObjectStore({ storage, maxValueBytes }), String(maxValueBytes)).toThrow(
						RangeError,
					);
				}
			});
		});

		it("reports values it did not write as corrupt", async () => {
			await inFreshObject(ns, async (storage) => {
				const s = new DurableObjectObjectStore({ storage });
				await storage.put("checkpoint", "not a record");
				await expect(s.get("checkpoint")).rejects.toThrow("not written by DurableObjectObjectStore");
				await expect(s.put("checkpoint", new Uint8Array(1))).rejects.toThrow("not written by DurableObjectObjectStore");
			});
		});

		it("keeps objects across eviction", async () => {
			const stub = ns.get(ns.newUniqueId());
			const before = await runInDurableObject(stub, async (instance, state) => {
				const s = new DurableObjectObjectStore({ storage: state.storage, maxValueBytes: max });
				await s.put("checkpoint", filled(10, 1));
				await s.put("tile/entries/000", filled(5 * max + 3, 2));
				return instance;
			});

			await evictDurableObject(stub);

			await runInDurableObject(stub, async (instance, state) => {
				expect(instance).not.toBe(before);
				const s = new DurableObjectObjectStore({ storage: state.storage, maxValueBytes: max });
				expect(await s.get("checkpoint")).toEqual(filled(10, 1));
				expect(bytesEqual((await s.get("tile/entries/000")) ?? new Uint8Array(0), filled(5 * max + 3, 2))).toBe(true);
			});
		});
	});
}
