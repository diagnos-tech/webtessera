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

// Runs the IndexedDB ObjectStore in real Chromium, against the browser's own
// IndexedDB and Web Locks. A dedicated module worker (testing/other_realm_worker.ts)
// opens the same database from a second realm and stands in for another tab.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { errorIs } from "../../internal/gostd/errors.ts";
import type { ObjectStore } from "../objectstore/objectstore.ts";
import { describeObjectStoreConformance } from "../objectstore/testing/conformance.ts";
import { describeDriverConformance } from "../objectstore/testing/driver_conformance.ts";
import {
	ErrClosed,
	type IndexedDBObjectStore,
	type IndexedDBObjectStoreOptions,
	newIndexedDBDriver,
	openIndexedDBObjectStore,
} from "./index.ts";
import { appendEntries, mergeAssignments, newTestKey, verifyLog } from "./testing/log.ts";
import type { WorkerReply, WorkerRequest } from "./testing/other_realm_worker.ts";
import { prefixCases } from "./testing/prefix_cases.ts";

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
	return enc.encode(s);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const databases = new Set<string>();

/** uniqueName returns a fresh database name, deleted once the suite finishes. */
function uniqueName(label: string): string {
	const name = `webtessera-test-${label}-${crypto.randomUUID()}`;
	databases.add(name);
	return name;
}

function deleteDatabase(name: string): Promise<{ blocked: boolean }> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		const req = indexedDB.deleteDatabase(name);
		req.onblocked = () => {
			blocked = true;
		};
		req.onsuccess = () => resolve({ blocked });
		req.onerror = () => reject(req.error);
	});
}

// opened holds every store a test opens, so that no test leaves a connection behind.
const opened: IndexedDBObjectStore[] = [];

/** openStore opens a store that is closed when the current test ends. */
async function openStore(opts: IndexedDBObjectStoreOptions): Promise<IndexedDBObjectStore> {
	const s = await openIndexedDBObjectStore(opts);
	opened.push(s);
	return s;
}

afterEach(() => {
	for (const s of opened.splice(0)) {
		s.close();
	}
});

afterAll(async () => {
	for (const name of databases) {
		await deleteDatabase(name);
	}
});

/** otherRealm drives testing/other_realm_worker.ts, a second realm sharing the page's origin. */
class otherRealm {
	readonly #worker = new Worker(new URL("./testing/other_realm_worker.ts", import.meta.url), { type: "module" });
	readonly #replies: WorkerReply[] = [];
	readonly #waiting: ((r: WorkerReply) => void)[] = [];

	constructor() {
		this.#worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
			const waiter = this.#waiting.shift();
			if (waiter === undefined) {
				this.#replies.push(event.data);
			} else {
				waiter(event.data);
			}
		});
	}

	send(req: WorkerRequest): void {
		this.#worker.postMessage(req);
	}

	/** next resolves to the worker's next reply. */
	next(): Promise<WorkerReply> {
		const r = this.#replies.shift();
		if (r !== undefined) {
			return Promise.resolve(r);
		}
		return new Promise((resolve) => this.#waiting.push(resolve));
	}

	terminate(): void {
		this.#worker.terminate();
	}
}

describeObjectStoreConformance("indexeddb (chromium)", () => openStore({ name: uniqueName("conformance") }));

// databaseOf maps each store the driver suite opens to its database, so that reopen can
// open a second, independent connection to it: the suite's restart and shared-store
// cases then run as two tabs would, contending through Web Locks.
const databaseOf = new WeakMap<ObjectStore, string>();

describeDriverConformance(
	"indexeddb (chromium)",
	async () => {
		const name = uniqueName("driver");
		const s = await openStore({ name });
		databaseOf.set(s, name);
		return s;
	},
	{
		reopen: (s) => {
			const name = databaseOf.get(s);
			if (name === undefined) {
				throw new Error("reopen: the store was not opened by this suite");
			}
			return openStore({ name });
		},
	},
);

describe("IndexedDBObjectStore in Chromium", () => {
	it("persists objects across close and reopen", async () => {
		const name = uniqueName("persist");
		const s1 = await openStore({ name });
		await s1.put("checkpoint", bytes("cp"));
		await s1.put("tile/entries/000", new Uint8Array(1 << 20).fill(9));
		const info = await s1.stat("checkpoint");
		s1.close();

		const s2 = await openStore({ name });
		expect(await s2.get("checkpoint")).toEqual(bytes("cp"));
		expect(await s2.stat("checkpoint")).toEqual(info);
		expect((await s2.stat("tile/entries/000"))?.size).toBe(1 << 20);
		s2.close();
	});

	it("commits writes with strict durability, which Chromium honours", async () => {
		const s = await openStore({ name: uniqueName("durability") });
		const spy = vi.spyOn(IDBDatabase.prototype, "transaction");
		let durability: IDBTransactionDurability[];
		try {
			await s.put("a", bytes("a"));
			await s.create("b", bytes("b"));
			await s.deletePrefix("a");
			await s.get("b");
			durability = spy.mock.results.map((r) => (r.value as IDBTransaction).durability);
		} finally {
			spy.mockRestore();
		}
		expect(durability).toEqual(["strict", "strict", "strict", "default"]);
	});

	it("closes so that another context can upgrade or delete the database", async () => {
		const name = uniqueName("versionchange");
		const s = await openStore({ name });
		await s.put("checkpoint", bytes("cp"));

		let blocked = false;
		const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(name, 2);
			req.onblocked = () => {
				blocked = true;
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		expect(blocked).toBe(false);
		upgraded.close();

		const err = await s.get("checkpoint").then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(errorIs(err, ErrClosed)).toBe(true);
		expect(String(err)).toContain("could upgrade it to schema version 2");

		const other = uniqueName("delete");
		const t = await openStore({ name: other });
		expect(await deleteDatabase(other)).toEqual({ blocked: false });
		await expect(t.put("checkpoint", bytes("cp"))).rejects.toThrow("could delete it");
	});

	describe("deletePrefix", () => {
		for (const tc of prefixCases) {
			it(tc.name, async () => {
				const s = await openStore({ name: uniqueName("prefix") });
				for (const k of [...tc.drop, ...tc.keep]) {
					await s.put(k, bytes(k));
				}
				await s.deletePrefix(tc.prefix);
				for (const k of tc.drop) {
					expect(await s.get(k), JSON.stringify(k)).toBeUndefined();
				}
				for (const k of tc.keep) {
					expect(await s.get(k), JSON.stringify(k)).toEqual(bytes(k));
				}
			});
		}
	});
});

describe("IndexedDBObjectStore locks in Chromium", () => {
	it("holds a Web Lock named after the database", async () => {
		const name = uniqueName("weblock name");
		const s = await openStore({ name });
		expect(s.lockScope).toBe("origin");
		const held = await s.lock("treeState.lock", async () => {
			const snapshot = await navigator.locks.query();
			return snapshot.held?.map((l) => l.name) ?? [];
		});
		expect(held).toContain(`webtessera/indexeddb/${encodeURIComponent(name)}/treeState.lock`);
	});

	it("excludes another store open on the same database", async () => {
		const name = uniqueName("two-stores");
		const a = await openStore({ name });
		const b = await openStore({ name });
		const other = await openStore({ name: uniqueName("unrelated") });

		const events: string[] = [];
		const gate = deferred();
		const first = a.lock("treeState.lock", async () => {
			events.push("a:start");
			await gate.promise;
			events.push("a:end");
		});
		const second = b.lock("treeState.lock", async () => {
			events.push("b:start");
		});
		expect(await other.lock("treeState.lock", async () => "unrelated database")).toBe("unrelated database");
		await sleep(50);
		expect(events).toEqual(["a:start"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["a:start", "a:end", "b:start"]);
	});

	it("waits for a lock held in another realm", async () => {
		const name = uniqueName("worker-holds");
		const s = await openStore({ name });
		const worker = new otherRealm();
		try {
			worker.send({ type: "hold", db: name, lock: "treeState.lock" });
			expect(await worker.next()).toEqual({ type: "acquired" });

			let ran = false;
			const mine = s.lock("treeState.lock", async () => {
				ran = true;
			});
			expect(await s.lock("publish.lock", async () => "other lock is free")).toBe("other lock is free");
			await sleep(100);
			expect(ran).toBe(false);

			worker.send({ type: "release" });
			expect(await worker.next()).toEqual({ type: "released" });
			await mine;
			expect(ran).toBe(true);
		} finally {
			worker.terminate();
		}
	});

	it("makes another realm wait for a lock held here", async () => {
		const name = uniqueName("page-holds");
		const s = await openStore({ name });
		const worker = new otherRealm();
		try {
			const gate = deferred();
			const holding = deferred();
			const mine = s.lock("treeState.lock", async () => {
				holding.resolve();
				await gate.promise;
			});
			await holding.promise;

			worker.send({ type: "hold", db: name, lock: "treeState.lock" });
			const acquired = worker.next();
			expect(await Promise.race([acquired, sleep(100).then(() => "still waiting")])).toBe("still waiting");

			gate.resolve();
			await mine;
			expect(await acquired).toEqual({ type: "acquired" });
			worker.send({ type: "release" });
			expect(await worker.next()).toEqual({ type: "released" });
		} finally {
			worker.terminate();
		}
	});

	it("stops waiting for a lock held in another realm when the signal aborts", async () => {
		const name = uniqueName("worker-abort");
		const s = await openStore({ name });
		const worker = new otherRealm();
		try {
			worker.send({ type: "hold", db: name, lock: "treeState.lock" });
			expect(await worker.next()).toEqual({ type: "acquired" });

			const ac = new AbortController();
			let ran = false;
			const waiter = s.lock(
				"treeState.lock",
				async () => {
					ran = true;
				},
				ac.signal,
			);
			const reason = new Error("gave up");
			ac.abort(reason);
			await expect(waiter).rejects.toBe(reason);

			worker.send({ type: "release" });
			expect(await worker.next()).toEqual({ type: "released" });
			expect(ran).toBe(false);
			expect(await s.lock("treeState.lock", async () => "free")).toBe("free");
		} finally {
			worker.terminate();
		}
	});

	it("shares data with another realm", async () => {
		const name = uniqueName("worker-data");
		const s = await openStore({ name });
		const worker = new otherRealm();
		try {
			await s.put("checkpoint", bytes("from the page"));
			worker.send({ type: "get", db: name, key: "checkpoint" });
			expect(await worker.next()).toEqual({ type: "got", value: "from the page" });

			worker.send({ type: "put", db: name, key: "checkpoint", value: "from the worker" });
			expect(await worker.next()).toEqual({ type: "stored" });
			expect(await s.get("checkpoint")).toEqual(bytes("from the worker"));
		} finally {
			worker.terminate();
		}
	});
});

describe("newIndexedDBDriver in Chromium", () => {
	function entries(writer: string, n: number): Uint8Array[] {
		return Array.from({ length: n }, (_, i) => bytes(`${writer}, entry ${i}`));
	}

	it("keeps a log across restarts", async () => {
		const name = uniqueName("driver-restart");
		const { skey, vkey } = newTestKey();

		const ac1 = new AbortController();
		const first = await appendEntries(await newIndexedDBDriver({ name }, ac1.signal), skey, entries("first", 3));
		ac1.abort();

		const ac2 = new AbortController();
		const d2 = await newIndexedDBDriver({ name }, ac2.signal);
		const second = await appendEntries(d2, skey, entries("second", 2));
		expect([...second.keys()].sort()).toEqual([3n, 4n]);
		await verifyLog(d2, skey, vkey, mergeAssignments(first, second));
		ac2.abort();
		expect(await deleteDatabase(name)).toEqual({ blocked: false });
	});

	it("sequences writers in two realms into one log", async () => {
		const name = uniqueName("driver-two-realms");
		const { skey, vkey } = newTestKey();
		const worker = new otherRealm();
		const ac = new AbortController();
		try {
			const driver = await newIndexedDBDriver({ name }, ac.signal);
			worker.send({
				type: "append",
				db: name,
				skey,
				entries: Array.from({ length: 120 }, (_, i) => `worker, entry ${i}`),
			});
			// Start appending here only once the worker's driver is up, so that the two
			// realms really do contend for the log.
			expect(await worker.next()).toEqual({ type: "appending" });
			const [fromPage, reply] = await Promise.all([appendEntries(driver, skey, entries("page", 120)), worker.next()]);
			if (reply.type !== "appended") {
				throw new Error(`worker: ${JSON.stringify(reply)}`);
			}
			const fromWorker = new Map(reply.assigned.map(([index, entry]) => [BigInt(index), bytes(entry)]));
			expect(fromWorker.size).toBe(120);
			await verifyLog(driver, skey, vkey, mergeAssignments(fromPage, fromWorker));
		} finally {
			ac.abort();
			worker.terminate();
		}
	});
});
