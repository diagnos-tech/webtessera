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

// Runs the IndexedDB ObjectStore on Node against fake-indexeddb, which implements the
// IndexedDB spec closely enough to exercise schema upgrades, versionchange handling,
// key ranges and transaction durability. Node has no Web Locks API, so the stores here
// are opened with singleWriter: true and use the in-process fallback (each test is the
// only writer of its fresh fake-indexeddb factory); indexeddb_browser_test.ts covers
// Web Locks in Chromium.

import { forceCloseDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { newInProcessLockManager } from "./testing/locks.ts";
import { appendEntries, mergeAssignments, newTestKey, verifyLog } from "./testing/log.ts";
import { prefixCases } from "./testing/prefix_cases.ts";

const enc = new TextEncoder();

// opened holds every store a test opens, so that no test leaves a connection behind.
const opened: IndexedDBObjectStore[] = [];

afterEach(() => {
	for (const s of opened.splice(0)) {
		s.close();
	}
});

/** openStore opens a store that is closed when the current test ends. */
async function openStore(opts: IndexedDBObjectStoreOptions, signal?: AbortSignal): Promise<IndexedDBObjectStore> {
	const s = await openIndexedDBObjectStore(opts, signal);
	opened.push(s);
	return s;
}

function bytes(s: string): Uint8Array {
	return enc.encode(s);
}

/**
 * spyingFactory wraps a fresh fake-indexeddb factory so that tests can reach the
 * IDBDatabase connections the store opens.
 */
function spyingFactory(): { factory: IDBFactory; connections: IDBDatabase[] } {
	const inner = new IDBFactory();
	const connections: IDBDatabase[] = [];
	const factory: IDBFactory = {
		open(name: string, version?: number): IDBOpenDBRequest {
			const req = inner.open(name, version);
			req.addEventListener("success", () => connections.push(req.result));
			return req;
		},
		deleteDatabase: (name) => inner.deleteDatabase(name),
		cmp: (a, b) => inner.cmp(a, b),
		databases: () => inner.databases(),
	};
	return { factory, connections };
}

function options(factory: IDBFactory, name = "log"): IndexedDBObjectStoreOptions {
	return { name, indexedDB: factory, IDBKeyRange, locks: null, singleWriter: true };
}

/** rawOpen opens a connection directly, bypassing the store, as other code sharing the origin would. */
function rawOpen(
	factory: IDBFactory,
	name: string,
	version?: number,
	upgrade?: (db: IDBDatabase, tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = factory.open(name, version);
		req.onupgradeneeded = () => {
			const tx = req.transaction;
			if (tx !== null) {
				upgrade?.(req.result, tx);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function rawRequest<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** deleteDatabase deletes name and reports whether any open connection blocked the deletion. */
function deleteDatabase(factory: IDBFactory, name: string): Promise<{ blocked: boolean }> {
	return new Promise((resolve, reject) => {
		let blocked = false;
		const req = factory.deleteDatabase(name);
		req.onblocked = () => {
			blocked = true;
		};
		req.onsuccess = () => resolve({ blocked });
		req.onerror = () => reject(req.error);
	});
}

function expectClosedError(err: unknown, message: string): void {
	expect(errorIs(err, ErrClosed), String(err)).toBe(true);
	expect(String(err)).toContain(message);
}

/**
 * fakeLockManager is a minimal, single-realm Web Locks LockManager. It records the
 * names requested and, like browsers that predate abort reasons in the Web Locks
 * spec, rejects an abandoned wait with a generic AbortError.
 */
class fakeLockManager {
	readonly names: string[] = [];
	readonly #held = new Map<string, (() => void)[]>();

	request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
	request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
	async request<T>(
		name: string,
		optionsOrCallback: LockOptions | LockGrantedCallback<T>,
		maybeCallback?: LockGrantedCallback<T>,
	): Promise<T> {
		const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
		const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
		if (callback === undefined) {
			throw new TypeError("missing callback");
		}
		this.names.push(name);
		const queue = this.#held.get(name);
		if (queue === undefined) {
			this.#held.set(name, []);
		} else {
			await new Promise<void>((resolve, reject) => {
				const grant = (): void => resolve();
				queue.push(grant);
				options.signal?.addEventListener("abort", () => {
					queue.splice(queue.indexOf(grant), 1);
					reject(new DOMException("The request was aborted.", "AbortError"));
				});
			});
		}
		try {
			return await callback(null);
		} finally {
			const next = this.#held.get(name)?.shift();
			if (next === undefined) {
				this.#held.delete(name);
			} else {
				next();
			}
		}
	}

	query(): Promise<LockManagerSnapshot> {
		return Promise.resolve({ held: [], pending: [] });
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describeObjectStoreConformance("indexeddb (fake-indexeddb, in-process locks)", () =>
	openStore(options(new IDBFactory())),
);

describeObjectStoreConformance("indexeddb (fake-indexeddb, LockManager)", () =>
	openStore({ ...options(new IDBFactory()), locks: new fakeLockManager() }),
);

// factories maps each store the driver suite opens to its fake-indexeddb instance, so
// that reopen can open a second, independent connection to the same database: the
// suite's restart and shared-store cases then behave as two tabs would.
const factories = new WeakMap<ObjectStore, IDBFactory>();

describeDriverConformance(
	"indexeddb (fake-indexeddb)",
	async () => {
		const factory = new IDBFactory();
		const s = await openStore(options(factory));
		factories.set(s, factory);
		return s;
	},
	{
		reopen: (s) => {
			const factory = factories.get(s);
			if (factory === undefined) {
				throw new Error("reopen: the store was not opened by this suite");
			}
			return openStore(options(factory));
		},
	},
);

describe("openIndexedDBObjectStore", () => {
	it("persists objects across close and reopen", async () => {
		const factory = new IDBFactory();
		const s1 = await openStore(options(factory));
		await s1.put("checkpoint", bytes("cp"));
		await s1.put("tile/0/000", bytes("tile"));
		const info = await s1.stat("checkpoint");
		s1.close();

		const s2 = await openStore(options(factory));
		expect(await s2.get("checkpoint")).toEqual(bytes("cp"));
		expect(await s2.get("tile/0/000")).toEqual(bytes("tile"));
		expect(await s2.stat("checkpoint")).toEqual(info);
		expect(await s2.create("checkpoint", bytes("other"))).toBe(false);
		s2.close();
	});

	it("shares data between stores open on the same database", async () => {
		const factory = new IDBFactory();
		const a = await openStore(options(factory));
		const b = await openStore(options(factory));
		await a.put("checkpoint", bytes("from a"));
		expect(await b.get("checkpoint")).toEqual(bytes("from a"));
		expect(await b.create("checkpoint", bytes("from b"))).toBe(false);
		await b.deletePrefix("check");
		expect(await a.get("checkpoint")).toBeUndefined();
	});

	it("keeps databases with different names apart", async () => {
		const factory = new IDBFactory();
		const a = await openStore(options(factory, "log-a"));
		const b = await openStore(options(factory, "log-b"));
		await a.put("checkpoint", bytes("a"));
		expect(await b.get("checkpoint")).toBeUndefined();
		expect(a.name).toBe("log-a");
		expect(b.name).toBe("log-b");
	});

	it("rejects with the signal's reason when already aborted", async () => {
		const ac = new AbortController();
		ac.abort(new Error("cancelled"));
		await expect(openStore(options(new IDBFactory()), ac.signal)).rejects.toThrow("cancelled");
	});

	it("stops waiting when the signal aborts, and closes the connection it later gets", async () => {
		const factory = new IDBFactory();
		// Another context is mid-upgrade, which holds every other open request back.
		let releaseUpgrade = false;
		const other = rawOpen(factory, "log", 1, (db) => {
			const store = db.createObjectStore("objects");
			const spin = (): void => {
				if (!releaseUpgrade) {
					store.get("spin").onsuccess = spin;
				}
			};
			spin();
		});
		const ac = new AbortController();
		const opening = openStore(options(factory), ac.signal);
		await new Promise((r) => setTimeout(r, 20));
		ac.abort(new Error("gave up"));
		await expect(opening).rejects.toThrow("gave up");

		releaseUpgrade = true;
		(await other).close();
		// Let the abandoned open request complete, so that its connection is closed.
		await new Promise((r) => setTimeout(r, 20));
		expect(await deleteDatabase(factory, "log")).toEqual({ blocked: false });
	});

	it("rejects a database written by a newer schema version", async () => {
		const factory = new IDBFactory();
		(await rawOpen(factory, "log", 7, (db) => db.createObjectStore("objects"))).close();
		await expect(openStore(options(factory))).rejects.toThrow(
			/written by a newer version of webtessera \(this version supports schema version 1\)/,
		);
	});

	it("rejects a database it did not create", async () => {
		const factory = new IDBFactory();
		(await rawOpen(factory, "log", 1, (db) => db.createObjectStore("something-else"))).close();
		await expect(openStore(options(factory))).rejects.toThrow(
			'indexeddb: database "log" exists but was not created by webtessera',
		);
		expect(await deleteDatabase(factory, "log")).toEqual({ blocked: false });
	});

	it("requires an IndexedDB implementation", async () => {
		await expect(openStore({ name: "log" })).rejects.toThrow(
			"indexeddb: IndexedDB is not available in this runtime; pass opts.indexedDB",
		);
		await expect(openStore({ name: "log", indexedDB: new IDBFactory() })).rejects.toThrow(
			"indexeddb: IDBKeyRange is not available in this runtime; pass opts.IDBKeyRange",
		);
	});
});

describe("IndexedDBObjectStore", () => {
	it("rejects every operation after close", async () => {
		const s = await openStore(options(new IDBFactory()));
		await s.put("checkpoint", bytes("cp"));
		s.close();
		s.close();

		const ops: [string, () => Promise<unknown>][] = [
			["get", () => s.get("checkpoint")],
			["stat", () => s.stat("checkpoint")],
			["put", () => s.put("checkpoint", bytes("x"))],
			["create", () => s.create("new", bytes("x"))],
			["deletePrefix", () => s.deletePrefix("")],
			["lock", () => s.lock("treeState.lock", async () => undefined)],
		];
		for (const [op, call] of ops) {
			const err = await call().then(
				() => undefined,
				(e: unknown) => e,
			);
			expectClosedError(err, `indexeddb: ${op} `);
			expectClosedError(err, 'database "log" is closed');
		}
	});

	it("lets in-flight writes finish when closed", async () => {
		const factory = new IDBFactory();
		const s = await openStore(options(factory));
		const write = s.put("checkpoint", bytes("cp"));
		s.close();
		await write;
		const reopened = await openStore(options(factory));
		expect(await reopened.get("checkpoint")).toEqual(bytes("cp"));
	});

	it("closes so that another context can upgrade the database", async () => {
		const factory = new IDBFactory();
		const s = await openStore(options(factory));
		await s.put("checkpoint", bytes("cp"));

		// A newer schema opening the database must not be blocked by this connection.
		let blocked = false;
		const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = factory.open("log", 2);
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
		expectClosedError(
			err,
			'indexeddb: get "checkpoint": database "log" was closed so that another tab or worker could upgrade it to schema version 2',
		);
	});

	it("closes so that another context can delete the database", async () => {
		const factory = new IDBFactory();
		const s = await openStore(options(factory));
		await s.put("checkpoint", bytes("cp"));

		expect(await deleteDatabase(factory, "log")).toEqual({ blocked: false });
		const err = await s.put("checkpoint", bytes("cp")).then(
			() => undefined,
			(e: unknown) => e,
		);
		expectClosedError(err, 'database "log" was closed so that another tab or worker could delete it');

		const fresh = await openStore(options(factory));
		expect(await fresh.get("checkpoint")).toBeUndefined();
	});

	it("reports a connection the browser closed", async () => {
		const { factory, connections } = spyingFactory();
		const s = await openStore(options(factory));
		const [db] = connections;
		forceCloseDatabase(db as unknown as typeof IDBDatabase);
		const err = await s.get("checkpoint").then(
			() => undefined,
			(e: unknown) => e,
		);
		expectClosedError(err, 'database "log" was closed by the browser');
	});

	it("commits every write with strict durability", async () => {
		const { factory, connections } = spyingFactory();
		const s = await openStore(options(factory));
		const [db] = connections;
		const spy = vi.spyOn(db as IDBDatabase, "transaction");

		await s.put("a", bytes("a"));
		await s.create("b", bytes("b"));
		await s.create("b", bytes("b"));
		await s.deletePrefix("a");
		await s.deletePrefix("");
		await s.get("a");
		await s.stat("a");

		const durability = spy.mock.results.map((r) => (r.value as IDBTransaction).durability);
		const modes = spy.mock.calls.map((c) => c[1]);
		expect(modes).toEqual(["readwrite", "readwrite", "readwrite", "readwrite", "readwrite", "readonly", "readonly"]);
		expect(durability).toEqual(["strict", "strict", "strict", "strict", "strict", "default", "default"]);
	});

	it("stores only the bytes of a view, not the buffer behind it", async () => {
		const factory = new IDBFactory();
		const s = await openStore(options(factory));
		const big = new Uint8Array(1 << 20).fill(7);
		await s.put("small", big.subarray(10, 20));
		expect(await s.get("small")).toEqual(new Uint8Array(10).fill(7));

		const db = await rawOpen(factory, "log");
		const record = (await rawRequest(db.transaction("objects").objectStore("objects").get("small"))) as {
			data: Uint8Array;
		};
		expect(record.data.buffer.byteLength).toBe(10);
		db.close();
	});

	it("rejects a malformed record", async () => {
		const factory = new IDBFactory();
		const s = await openStore(options(factory));
		const db = await rawOpen(factory, "log");
		await rawRequest(db.transaction("objects", "readwrite").objectStore("objects").put("not a record", "checkpoint"));
		db.close();
		await expect(s.get("checkpoint")).rejects.toThrow('indexeddb: get "checkpoint": malformed record');
		await expect(s.stat("checkpoint")).rejects.toThrow('indexeddb: stat "checkpoint": malformed record');
	});
});

describe("IndexedDBObjectStore.deletePrefix", () => {
	for (const tc of prefixCases) {
		it(tc.name, async () => {
			const s = await openStore(options(new IDBFactory()));
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

// docs/decisions/0201-indexeddb-locks-fail-closed.md
describe("IndexedDBObjectStore lock scope", () => {
	const unsafe = (factory: IDBFactory, name = "log"): IndexedDBObjectStoreOptions => ({
		name,
		indexedDB: factory,
		IDBKeyRange,
	});
	const wantErr =
		'indexeddb: open database "log": the Web Locks API (navigator.locks) is not available in this context (it ' +
		"requires a secure context: HTTPS or localhost), so locks could not exclude other tabs and workers writing the " +
		"same log; serve the page from a secure context, pass opts.locks, or pass singleWriter: true if this is the " +
		"only context that will ever write this log";

	it("refuses to open without Web Locks unless singleWriter is set, before creating the database", async () => {
		expect((globalThis as { navigator?: { locks?: unknown } }).navigator?.locks).toBeUndefined();
		const factory = new IDBFactory();
		await expect(openIndexedDBObjectStore(unsafe(factory))).rejects.toThrow(new Error(wantErr));
		await expect(openIndexedDBObjectStore({ ...unsafe(factory), locks: null })).rejects.toThrow(new Error(wantErr));
		await expect(openIndexedDBObjectStore({ ...unsafe(factory), singleWriter: false })).rejects.toThrow(
			new Error(wantErr),
		);
		expect(await factory.databases()).toEqual([]);
	});

	it("newIndexedDBDriver refuses too", async () => {
		await expect(newIndexedDBDriver(unsafe(new IDBFactory()))).rejects.toThrow(new Error(wantErr));
	});

	it("opens with realm-scoped locks when singleWriter is set", async () => {
		const s = await openStore({ ...unsafe(new IDBFactory()), singleWriter: true });
		expect(s.lockScope).toBe("realm");
	});

	it("uses Web Locks whenever a LockManager is available, singleWriter or not", async () => {
		const factory = new IDBFactory();
		expect((await openStore({ ...unsafe(factory), locks: new fakeLockManager() })).lockScope).toBe("origin");
		expect(
			(await openStore({ ...unsafe(factory, "other"), locks: new fakeLockManager(), singleWriter: true })).lockScope,
		).toBe("origin");
	});

	it("accepts the test-only in-process LockManager in place of navigator.locks", async () => {
		const locks = newInProcessLockManager();
		const a = await openStore({ ...unsafe(new IDBFactory()), locks });
		expect(a.lockScope).toBe("origin");
		const gate = deferred();
		const events: string[] = [];
		const held = a.lock("treeState.lock", async () => {
			events.push("a");
			await gate.promise;
		});
		const ac = new AbortController();
		const waiter = a.lock("treeState.lock", async () => events.push("never"), ac.signal);
		const reason = new Error("gave up");
		ac.abort(reason);
		await expect(waiter).rejects.toBe(reason);
		gate.resolve();
		await held;
		expect(events).toEqual(["a"]);
	});

	it("newIndexedDBDriver reports the effective lock scope", async () => {
		const ac = new AbortController();
		try {
			const realm = await newIndexedDBDriver({ ...unsafe(new IDBFactory()), singleWriter: true }, ac.signal);
			expect(realm.lockScope).toBe("realm");
			const origin = await newIndexedDBDriver({ ...unsafe(new IDBFactory()), locks: new fakeLockManager() }, ac.signal);
			expect(origin.lockScope).toBe("origin");
		} finally {
			ac.abort();
		}
	});
});

describe("IndexedDBObjectStore.lock", () => {
	it("falls back to in-process locks shared by every store on the same database", async () => {
		const factory = new IDBFactory();
		const a = await openStore(options(factory));
		const b = await openStore(options(factory));
		expect(a.lockScope).toBe("realm");

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
		await new Promise((r) => setTimeout(r, 20));
		expect(events).toEqual(["a:start"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["a:start", "a:end", "b:start"]);
	});

	it("does not contend across databases or IndexedDB implementations", async () => {
		const factory = new IDBFactory();
		const a = await openStore(options(factory, "log-a"));
		const b = await openStore(options(factory, "log-b"));
		const c = await openStore(options(new IDBFactory(), "log-a"));
		const gate = deferred();
		const held = a.lock("treeState.lock", () => gate.promise);
		expect(await b.lock("treeState.lock", async () => "b")).toBe("b");
		expect(await c.lock("treeState.lock", async () => "c")).toBe("c");
		gate.resolve();
		await held;
	});

	it("takes Web Locks named after the database", async () => {
		const locks = new fakeLockManager();
		const s = await openStore({ ...options(new IDBFactory(), "my log/2"), locks });
		expect(s.lockScope).toBe("origin");
		await s.lock("treeState.lock", async () => undefined);
		await s.lock("publish.lock", async () => undefined);
		expect(locks.names).toEqual([
			"webtessera/indexeddb/my%20log%2F2/treeState.lock",
			"webtessera/indexeddb/my%20log%2F2/publish.lock",
		]);
	});

	it("reports the signal's reason when a LockManager rejects an abandoned wait with AbortError", async () => {
		const s = await openStore({ ...options(new IDBFactory()), locks: new fakeLockManager() });
		const gate = deferred();
		const holder = s.lock("treeState.lock", () => gate.promise);
		const ac = new AbortController();
		const waiter = s.lock("treeState.lock", async () => "ran", ac.signal);
		const reason = new Error("gave up");
		ac.abort(reason);
		await expect(waiter).rejects.toBe(reason);
		gate.resolve();
		await holder;
	});

	it("reports fn's own error, not the signal's reason, once the lock is held", async () => {
		const s = await openStore({ ...options(new IDBFactory()), locks: new fakeLockManager() });
		const ac = new AbortController();
		await expect(
			s.lock(
				"treeState.lock",
				async () => {
					ac.abort(new Error("too late"));
					throw new Error("boom");
				},
				ac.signal,
			),
		).rejects.toThrow("boom");
	});
});

describe("newIndexedDBDriver", () => {
	it("keeps a log across restarts", async () => {
		const factory = new IDBFactory();
		const { skey, vkey } = newTestKey();

		const ac1 = new AbortController();
		const d1 = await newIndexedDBDriver(options(factory), ac1.signal);
		const first = await appendEntries(d1, skey, [bytes("one"), bytes("two")]);
		expect([...first.keys()].sort()).toEqual([0n, 1n]);
		ac1.abort();

		const ac2 = new AbortController();
		const d2 = await newIndexedDBDriver(options(factory), ac2.signal);
		const second = await appendEntries(d2, skey, [bytes("three")]);
		expect([...second.keys()]).toEqual([2n]);
		await verifyLog(d2, skey, vkey, mergeAssignments(first, second));
		ac2.abort();

		// Aborting each driver's signal closed its connection, so nothing blocks deletion.
		expect(await deleteDatabase(factory, "log")).toEqual({ blocked: false });
	});

	it("rejects with the signal's reason when already aborted", async () => {
		const ac = new AbortController();
		ac.abort(new Error("cancelled"));
		await expect(newIndexedDBDriver(options(new IDBFactory()), ac.signal)).rejects.toThrow("cancelled");
	});
});
