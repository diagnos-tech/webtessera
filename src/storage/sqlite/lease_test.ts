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

// Lease locking and fencing, between stores that share a database but no memory, as
// stores in two processes would. Lease expiry is driven by an injected clock; renewal and
// polling run on real timers, kept short.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { errorIs } from "../../internal/gostd/errors.ts";
import { fromSqliteSync } from "./adapters/sync.ts";
import type { SqlDatabase } from "./database.ts";
import { ErrLeaseLost, openSqliteObjectStore, type SqliteLeaseOptions, type SqliteObjectStore } from "./index.ts";
import { otherProcess } from "./testing/stores.ts";
import { D1Limits, StrictSqlDatabase } from "./testing/strict.ts";

const enc = new TextEncoder();
const lockName = ".state/treeState.lock";

/** world is one database, a clock every store in it shares, and a way to open stores in "other processes". */
interface world {
	readonly db: SqlDatabase;
	now: number;
	open(lease?: SqliteLeaseOptions): Promise<{ store: SqliteObjectStore; db: StrictSqlDatabase }>;
	holder(): Promise<string | undefined>;
}

function newWorld(): world {
	const db = fromSqliteSync(new DatabaseSync(":memory:"));
	const w: world = {
		db,
		now: 1_800_000_000_000,
		open: async (lease = { ttlMs: 1000, renewIntervalMs: 900, maxPollIntervalMs: 10 }) => {
			const strict = new StrictSqlDatabase(otherProcess(db), D1Limits);
			const store = await openSqliteObjectStore({ database: strict, locking: "lease", lease, clock: () => w.now });
			return { store, db: strict };
		},
		holder: async () => {
			const rows = await db.query({
				sql: "SELECT holder FROM webtessera_locks WHERE name = ?",
				params: [lockName],
			});
			return rows[0]?.holder as string | undefined;
		},
	};
	return w;
}

function gate(): { promise: Promise<void>; open: () => void } {
	let open = (): void => {};
	const promise = new Promise<void>((r) => {
		open = r;
	});
	return { promise, open };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SQLite lease locking", () => {
	it("excludes a store in another process until the holder releases", async () => {
		const w = newWorld();
		const a = await w.open();
		const b = await w.open();
		const events: string[] = [];
		const g = gate();
		const first = a.store.lock(lockName, async () => {
			events.push("a:start");
			await g.promise;
			events.push("a:end");
		});
		await tick(5);
		const second = b.store.lock(lockName, async () => void events.push("b"));
		await tick(60);
		expect(events).toEqual(["a:start"]);
		g.open();
		await Promise.all([first, second]);
		expect(events).toEqual(["a:start", "a:end", "b"]);
		expect(await w.holder()).toBeUndefined();
	});

	it("fences out a stalled holder whose lease another process took over", async () => {
		const w = newWorld();
		const a = await w.open();
		const b = await w.open();
		await a.store.put("checkpoint", enc.encode("a1"));

		const stalled = gate();
		const resumed = gate();
		const results: unknown[] = [];
		const holder = a.store.lock(lockName, async () => {
			await stalled.promise;
			// a's process wakes up long after its lease expired, unaware of it.
			for (const write of [
				() => a.store.put("checkpoint", enc.encode("a2")),
				() => a.store.create("tile/0/000", enc.encode("a2")),
				() => a.store.deletePrefix(""),
			]) {
				results.push(
					await write().then(
						() => "written",
						(e: unknown) => e,
					),
				);
			}
			resumed.open();
		});
		await tick(5);

		// The lease expires (renewals are 900 ms apart in real time, so none has run), and
		// b takes the lock over and writes.
		w.now += 1001;
		await b.store.lock(lockName, async () => {
			await b.store.put("checkpoint", enc.encode("b1"));
			stalled.open();
			await resumed.promise;
		});
		await holder;

		expect(results).toHaveLength(3);
		for (const r of results) {
			expect(errorIs(r, ErrLeaseLost), String(r)).toBe(true);
			expect(String(r)).toContain("lapsed");
		}
		expect(await b.store.get("checkpoint")).toEqual(enc.encode("b1"));
		expect(await b.store.stat("tile/0/000")).toBeUndefined();

		// Once a has left the critical section it holds no lease, and writes again.
		await a.store.put("checkpoint", enc.encode("a3"));
		expect(await b.store.get("checkpoint")).toEqual(enc.encode("a3"));
	});

	it("fences every write of a store that holds a lapsed lease, not only the holder's", async () => {
		const w = newWorld();
		const a = await w.open();
		const b = await w.open();
		const release = gate();
		const holding = a.store.lock(lockName, () => release.promise);
		await tick(5);
		w.now += 1001;
		await b.store.lock(lockName, async () => {
			// Not under any lock of its own, but a still believes it holds treeState.lock.
			const err = await a.store.put("tile/0/000", enc.encode("x")).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(errorIs(err, ErrLeaseLost), String(err)).toBe(true);
		});
		release.open();
		await holding;
	});

	it("keeps a lease alive by renewing it while its holder runs", async () => {
		const w = newWorld();
		const a = await w.open({ ttlMs: 1000, renewIntervalMs: 20, maxPollIntervalMs: 10 });
		const b = await w.open();
		const release = gate();
		const holding = a.store.lock(lockName, () => release.promise);
		await tick(5);
		const token = await w.holder();
		for (let i = 0; i < 5; i++) {
			// Each step stays within the lease as last renewed; together they outlast it.
			w.now += 600;
			await tick(60);
		}
		const ac = new AbortController();
		setTimeout(() => ac.abort(new Error("gave up")), 80);
		await expect(b.store.lock(lockName, async () => "b", ac.signal)).rejects.toThrow("gave up");
		expect(await w.holder()).toBe(token);
		await a.store.put("checkpoint", enc.encode("still the holder"));
		release.open();
		await holding;
		expect(await b.store.lock(lockName, async () => "b")).toBe("b");
	});

	it("takes over the lease of a holder that died, once it expires", async () => {
		const w = newWorld();
		const b = await w.open();
		await w.db.query({
			sql: "INSERT INTO webtessera_locks (name, holder, expires) VALUES (?, 'crashed', ?)",
			params: [lockName, w.now + 1000],
		});
		let ran = false;
		const waiting = b.store.lock(lockName, async () => {
			ran = true;
		});
		await tick(50);
		expect(ran).toBe(false);
		w.now += 1000;
		await waiting;
		expect(ran).toBe(true);
		expect(await w.holder()).toBeUndefined();
	});

	it("stops polling when the signal aborts, and leaves no lease behind", async () => {
		const w = newWorld();
		const a = await w.open();
		const b = await w.open();
		const release = gate();
		const holding = a.store.lock(lockName, () => release.promise);
		await tick(5);
		const token = await w.holder();
		const ac = new AbortController();
		let ran = false;
		const waiting = b.store.lock(
			lockName,
			async () => {
				ran = true;
			},
			ac.signal,
		);
		await tick(40);
		expect(b.db.batches).toBeGreaterThan(1);
		ac.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
		const batches = b.db.batches;
		await tick(60);
		expect(b.db.batches, "b kept polling after its signal aborted").toBe(batches);
		expect(ran).toBe(false);
		expect(await w.holder()).toBe(token);
		release.open();
		await holding;
		expect(await b.store.lock(lockName, async () => "free")).toBe("free");
	});

	it("refuses writes without a round trip once a renewal finds the lease lost", async () => {
		const w = newWorld();
		const a = await w.open({ ttlMs: 1000, renewIntervalMs: 10, maxPollIntervalMs: 10 });
		const release = gate();
		let err: unknown;
		const holding = a.store.lock(lockName, async () => {
			await w.db.query({ sql: "UPDATE webtessera_locks SET holder = 'thief'", params: [] });
			await tick(50);
			const batches = a.db.batches;
			err = await a.store.put("checkpoint", enc.encode("x")).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(a.db.batches).toBe(batches);
			await release.promise;
		});
		await tick(80);
		release.open();
		await holding;
		expect(errorIs(err, ErrLeaseLost), String(err)).toBe(true);
		// Releasing a lost lease leaves the new holder's row alone.
		expect(await w.holder()).toBe("thief");
	});

	it("defers releasing a lease until the writes fenced on it have settled", async () => {
		const w = newWorld();
		const a = await w.open();
		const publish = ".state/publish.lock";
		const integrating = gate();
		const holdingTree = a.store.lock(lockName, () => integrating.promise);
		await tick(5);

		// The write below is fenced on both of a's leases; hold it on its way to the database.
		const inFlight = gate();
		const reachedDatabase = gate();
		a.db.beforeBatch = async (statements) => {
			if (statements.some((s) => s.sql.includes("webtessera_objects"))) {
				a.db.beforeBatch = undefined;
				reachedDatabase.open();
				await inFlight.promise;
			}
		};
		let write: Promise<void> = Promise.resolve();
		const publishing = a.store.lock(publish, async () => {
			write = a.store.put("tile/0/000", enc.encode("x"));
			await reachedDatabase.promise;
		});
		await tick(30);
		// publish.lock's holder has returned, but its lease must outlive the write in flight.
		const rows = await w.db.query({ sql: "SELECT count(*) AS n FROM webtessera_locks", params: [] });
		expect(Number(rows[0]?.n)).toBe(2);
		inFlight.open();
		await write;
		await publishing;
		integrating.open();
		await holdingTree;
		expect(await a.store.get("tile/0/000")).toEqual(enc.encode("x"));
		expect(await w.holder()).toBeUndefined();
	});

	it("releases the lease when the holder throws", async () => {
		const w = newWorld();
		const a = await w.open();
		await expect(
			a.store.lock(lockName, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await w.holder()).toBeUndefined();
	});
});

describe("SQLite lease fencing", () => {
	it("refuses a lapsed holder's writes on a connection that ignores CHECK constraints", async () => {
		const raw = new DatabaseSync(":memory:");
		raw.exec("PRAGMA ignore_check_constraints = ON");
		const db = fromSqliteSync(raw);
		const store = await openSqliteObjectStore({ database: db, locking: "lease" });
		await store.lock(lockName, async () => {
			// Another holder takes the lock over.
			await db.query({ sql: "UPDATE webtessera_locks SET holder = 'another holder'", params: [] });
			const err = await store.put("checkpoint", enc.encode("stale")).catch((e: unknown) => e);
			expect(errorIs(err, ErrLeaseLost)).toBe(true);
		});
		expect(await store.get("checkpoint")).toBeUndefined();
	});
});

describe("SQLite lease locking on the database's clock", () => {
	/** open opens a lease-mode store over db with no clock of its own, as production code does. */
	const open = (db: SqlDatabase, lease: SqliteLeaseOptions) =>
		openSqliteObjectStore({ database: otherProcess(db), locking: "lease", lease });
	const expiresOf = async (db: SqlDatabase): Promise<number> => {
		const rows = await db.query({ sql: "SELECT expires FROM webtessera_locks WHERE name = ?", params: [lockName] });
		return Number(rows[0]?.expires);
	};

	it("sets expiries from the database's clock unless the store has a clock of its own", async () => {
		const db = fromSqliteSync(new DatabaseSync(":memory:"));
		expect(db.leaseClock).toBe("database");
		const s = await open(db, { ttlMs: 60_000 });
		await s.lock(lockName, async () => {
			const expires = await expiresOf(db);
			expect(Math.abs(expires - (Date.now() + 60_000))).toBeLessThan(1000);
		});
		const skewed = await openSqliteObjectStore({
			database: otherProcess(db),
			locking: "lease",
			lease: { ttlMs: 60_000 },
			clock: () => 1_000,
		});
		await skewed.lock(lockName, async () => {
			expect(await expiresOf(db)).toBe(61_000);
		});
	});

	it("takes over a dead holder's lease once the database's clock passes its expiry", async () => {
		const db = fromSqliteSync(new DatabaseSync(":memory:"));
		const s = await open(db, { ttlMs: 1000, maxPollIntervalMs: 10 });
		await db.query({
			sql: "INSERT INTO webtessera_locks (name, holder, expires) VALUES (?, 'crashed', ?)",
			params: [lockName, Date.now() + 200],
		});
		const started = Date.now();
		await s.lock(lockName, async () => {
			expect(Date.now() - started).toBeGreaterThanOrEqual(150);
		});
	});

	it("keeps a lease alive past its time to live by renewing it on the database's clock", async () => {
		const db = fromSqliteSync(new DatabaseSync(":memory:"));
		const a = await open(db, { ttlMs: 150, renewIntervalMs: 40, maxPollIntervalMs: 10 });
		const b = await open(db, { ttlMs: 150, renewIntervalMs: 40, maxPollIntervalMs: 10 });
		const release = gate();
		const holding = a.lock(lockName, () => release.promise);
		await tick(5);
		const ac = new AbortController();
		setTimeout(() => ac.abort(new Error("gave up")), 450);
		await expect(b.lock(lockName, async () => "b", ac.signal)).rejects.toThrow("gave up");
		await a.put("checkpoint", enc.encode("still the holder"));
		release.open();
		await holding;
		expect(await b.lock(lockName, async () => "b")).toBe("b");
	});
});
