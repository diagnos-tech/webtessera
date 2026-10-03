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

// This file has no upstream counterpart. It implements the ObjectStore contract on any
// SQLite database reachable through a SqlDatabase, so that the shared storage driver can
// keep a log in node:sqlite, bun:sqlite, better-sqlite3, libSQL/Turso, rqlite, Cloudflare
// D1, a SQLite-backed Durable Object or SQLite compiled to WebAssembly alike. See
// docs/decisions/0150-sqlite-object-store.md to docs/decisions/0154-sqlite-public-api.md.

import type { FetchFn } from "../../client/fetcher.ts";
import { wrapError } from "../../internal/gostd/errors.ts";
import { newObjectStoreDriver, type ObjectStoreDriver } from "../objectstore/driver.ts";
import { NamedLocks } from "../objectstore/namedlocks.ts";
import type { ObjectInfo, ObjectStore } from "../objectstore/objectstore.ts";
import type { SqlDatabase, SqliteLocking, SqlRow, SqlStatement } from "./database.ts";
import { encodeKey, prefixRange } from "./keys.ts";
import { type Fence, isLeaseLost, LeaseLocks, type LeaseTimings, leaseLostError } from "./lease.ts";
import { blobParam, checkTextEncoding, textParam } from "./params.ts";
import { databaseInstance, ensureSchema, type Tables, tableNames } from "./schema.ts";
import { asBytes, asInteger } from "./values.ts";

/**
 * DefaultMaxChunkBytes is the default for SqliteObjectStoreOptions.maxChunkBytes: 1 MiB.
 *
 * Cloudflare D1 and SQLite-backed Durable Objects reject rows, BLOBs and strings over
 * 2,000,000 bytes, and the other engines accept far more, so the default fits every
 * engine with room to spare for a row's key and other columns. Tiles (at most 8 KiB) and
 * checkpoints always fit in one row; only entry bundles, which reach 16 MiB, span several.
 */
export const DefaultMaxChunkBytes = 1024 * 1024;

/** SqliteLeaseOptions tunes the leases behind "lease" locking. */
export interface SqliteLeaseOptions {
	/**
	 * ttlMs is how long a lease lasts after it was taken or last renewed: how long a
	 * holder that died keeps others waiting, and how long one that stalls may pause
	 * before its writes start failing with ErrLeaseLost. It defaults to 30 seconds.
	 */
	readonly ttlMs?: number;
	/** renewIntervalMs is how often a held lease is renewed. It defaults to a third of ttlMs, rounded down. */
	readonly renewIntervalMs?: number;
	/**
	 * maxPollIntervalMs bounds the backoff between attempts to take a lock that another
	 * holder has, each of which is a write to the database. It defaults to 250 ms.
	 */
	readonly maxPollIntervalMs?: number;
}

/** SqliteObjectStoreOptions configures openSqliteObjectStore. */
export interface SqliteObjectStoreOptions {
	/** database is the database to keep the log in, through one of the adapters in this package or your own. */
	readonly database: SqlDatabase;

	/**
	 * namespace, if given, keeps the log in tables of its own,
	 * `webtessera_<namespace>_<table>` rather than `webtessera_<table>`, so that several
	 * logs can share one database. It is 1 to 64 lowercase letters, digits and
	 * underscores. Every store opened with the same database and namespace reads and
	 * writes the same log.
	 */
	readonly namespace?: string;

	/**
	 * locking selects how ObjectStore.lock excludes other writers: see SqliteLocking. It
	 * defaults to the database's defaultLocking, which fails closed: "lease", unless the
	 * adapter can show that nothing outside this realm can reach the database, as for an
	 * in-memory or temporary database, a Durable Object's, or a WebAssembly SQLite in a
	 * private VFS. Every SQLite file, libSQL embedded replica, D1, rqlite and remote libSQL
	 * database therefore gets "lease".
	 *
	 * Choosing "local" is the caller's declaration that this realm is the database's only
	 * writer, like IndexedDB's `singleWriter`. If another process, or a connection that is
	 * not a store of this realm, writes the database too, the log forks.
	 */
	readonly locking?: SqliteLocking;

	/**
	 * maxChunkBytes is the most of an object's bytes kept in one row. Larger objects span
	 * several rows, which readers never notice. It defaults to DefaultMaxChunkBytes, which
	 * suits every engine; raising it means fewer rows per entry bundle, and it must stay
	 * well below the engine's row size limit.
	 */
	readonly maxChunkBytes?: number;

	/** lease tunes "lease" locking. It is ignored with "local" locking. */
	readonly lease?: SqliteLeaseOptions;

	/**
	 * clock returns the current time in milliseconds since the Unix epoch. It stamps each
	 * object's modTime, and defaults to Date.now. If given, it also times leases, in place
	 * of the database's clock that adapters such as fromD1 otherwise have leases use (see
	 * SqlDatabase.leaseClock). The driver compares modTime with Date.now to decide when to
	 * republish a checkpoint, so replace it only with a clock that agrees, or in tests.
	 */
	readonly clock?: () => number;
}

/**
 * SqliteObjectStore is an ObjectStore kept in SQLite tables.
 *
 * Each object is a row of the objects table holding its size, modification time and
 * first maxChunkBytes bytes; the rest of a larger object is in numbered rows of the chunks
 * table. Every put, create and deletePrefix is one batch, so it is atomic however many
 * rows it touches, and resolves once the engine has committed it: see the adapter in use
 * for what that means for durability. Every get is one query, so it reads one consistent
 * version of an object, chunks and all.
 *
 * Keys are stored as TEXT, so the tables are readable with any SQLite tool: an object's
 * bytes are its objects.data followed by its chunks' data in seq order. A key must be
 * well-formed Unicode, and deletePrefix removes exactly the keys that start with its
 * prefix, whatever characters they contain.
 *
 * With "lease" locking, every write the store makes while it holds a lease carries, in
 * the same batch, the condition that each lease it holds is still its own, so a holder
 * that stalled past its lease's expiry can never overwrite what the lock's next holder
 * wrote: its write fails instead, with an error caused by ErrLeaseLost.
 */
export interface SqliteObjectStore extends ObjectStore {
	/** locking is how this store's locks exclude other writers. */
	readonly locking: SqliteLocking;
	/** namespace is the namespace of this store's tables, or undefined for the default tables. */
	readonly namespace: string | undefined;
}

/**
 * openSqliteObjectStore returns an ObjectStore kept in opts.database, creating its tables
 * if they do not exist and upgrading them if an earlier webtessera created them. It fails
 * if a later webtessera created them, and if the database does not store text as UTF-8,
 * since distinct keys would then collide. If signal aborts before the tables are ready,
 * it rejects with the signal's reason.
 *
 * With "local" locking, the store shares its in-process locks with every other local-mode
 * store of this realm over the same database and namespace, however it reached the
 * database: the tables record a random identity, drawn once, that every connection reads
 * alike. Several connections to one file, or to one shared-cache in-memory database, in
 * one process therefore exclude each other even under local locking.
 *
 * Most callers want newSqliteDriver, which opens the store and starts a driver on it.
 */
export async function openSqliteObjectStore(
	opts: SqliteObjectStoreOptions,
	signal?: AbortSignal,
): Promise<SqliteObjectStore> {
	const db = opts.database;
	const t = tableNames(opts.namespace);
	const maxChunkBytes = opts.maxChunkBytes ?? DefaultMaxChunkBytes;
	if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) {
		throw new RangeError(`sqlite: maxChunkBytes must be a positive integer, got ${maxChunkBytes}`);
	}
	const locking = opts.locking ?? (await defaultLockingOf(db, signal));
	if (locking !== "local" && locking !== "lease") {
		throw new RangeError(
			'sqlite: locking must be "lease", or "local" to declare that this realm is the only writer of the ' +
				`database; got ${JSON.stringify(locking)}`,
		);
	}
	const clock = opts.clock ?? Date.now;
	const leaseClock = opts.clock ?? (db.leaseClock === "database" ? "database" : Date.now);
	const leases = locking === "lease" ? new LeaseLocks(db, t, leaseTimings(opts.lease), leaseClock) : undefined;
	signal?.throwIfAborted();
	await checkTextEncoding(db);
	await ensureSchema(db, t, signal);
	const local = leases === undefined ? localLocksFor(`${await databaseInstance(db, t)}/${t.objects}`) : queueFor(db, t);
	return new sqliteObjectStore(db, opts.namespace, t, maxChunkBytes, clock, local, leases);
}

/**
 * defaultLockingOf returns the locking db defaults to: its adapter's choice, asked of the
 * database if the adapter has to, or "lease" if the adapter does not say.
 */
async function defaultLockingOf(db: SqlDatabase, signal: AbortSignal | undefined): Promise<SqliteLocking> {
	const d = db.defaultLocking;
	if (typeof d !== "function") {
		return d ?? "lease";
	}
	signal?.throwIfAborted();
	return d();
}

/** SqliteDriverConfig configures newSqliteDriver. */
export interface SqliteDriverConfig extends SqliteObjectStoreOptions {
	/** fetch is used for outgoing HTTP requests, e.g. to witnesses. If unset, the global fetch is used. */
	readonly fetch?: FetchFn;
}

/**
 * newSqliteDriver opens a SQLite ObjectStore in cfg.database, as openSqliteObjectStore
 * does, and returns a storage driver that keeps the log in it, for newAppender,
 * newMigrationTarget and the like:
 *
 *	const driver = await newSqliteDriver({ database: fromSqliteSync(new DatabaseSync("log.db")) });
 *
 * signal bounds only the opening. The database belongs to the caller, who closes it, if
 * at all, after the appender has shut down.
 */
export async function newSqliteDriver(cfg: SqliteDriverConfig, signal?: AbortSignal): Promise<ObjectStoreDriver> {
	const store = await openSqliteObjectStore(cfg, signal);
	return newObjectStoreDriver(cfg.fetch === undefined ? { store } : { store, fetch: cfg.fetch });
}

/** leaseTimings resolves and validates the lease options, each a positive whole number of milliseconds. */
function leaseTimings(o: SqliteLeaseOptions = {}): LeaseTimings {
	const ttlMs = o.ttlMs ?? 30_000;
	const renewIntervalMs = o.renewIntervalMs ?? Math.floor(ttlMs / 3);
	const maxPollIntervalMs = o.maxPollIntervalMs ?? 250;
	if (!(Number.isSafeInteger(ttlMs) && ttlMs > 0)) {
		throw new RangeError(`sqlite: lease.ttlMs must be a positive integer, got ${ttlMs}`);
	}
	if (!(Number.isSafeInteger(renewIntervalMs) && renewIntervalMs > 0 && renewIntervalMs < ttlMs)) {
		throw new RangeError(
			`sqlite: lease.renewIntervalMs must be a positive integer below ttlMs, got ${renewIntervalMs}`,
		);
	}
	if (!(Number.isSafeInteger(maxPollIntervalMs) && maxPollIntervalMs > 0)) {
		throw new RangeError(`sqlite: lease.maxPollIntervalMs must be a positive integer, got ${maxPollIntervalMs}`);
	}
	return { ttlMs, renewIntervalMs, maxPollIntervalMs };
}

// localLocks holds the locks of local-mode stores by database identity and table, so
// that every such store of this realm over one database contends on the same locks,
// whichever connection it reaches the database through. They are held weakly: a lock
// someone holds or awaits is reachable from them, and a NamedLocks nobody references holds
// no lock. Entries whose locks have gone are swept as the map grows.
const localLocks = new Map<string, WeakRef<NamedLocks>>();
let localLocksSweepAt = 64;

function localLocksFor(key: string): NamedLocks {
	const known = localLocks.get(key)?.deref();
	if (known !== undefined) {
		return known;
	}
	if (localLocks.size >= localLocksSweepAt) {
		for (const [k, ref] of localLocks) {
			if (ref.deref() === undefined) {
				localLocks.delete(k);
			}
		}
		localLocksSweepAt = Math.max(64, 2 * localLocks.size);
	}
	const locks = new NamedLocks();
	localLocks.set(key, new WeakRef(locks));
	return locks;
}

// leaseQueues holds the in-process queues in front of lease-mode stores' leases, by
// SqlDatabase and table, so that at most one caller per lock and SqlDatabase polls the
// database. They are keyed by the SqlDatabase object rather than the database's identity
// on purpose: the leases alone must, and do, exclude stores that share no SqlDatabase,
// which is what lets the tests stand two of them in for two processes.
const leaseQueues = new WeakMap<SqlDatabase, Map<string, NamedLocks>>();

function queueFor(db: SqlDatabase, t: Tables): NamedLocks {
	let byTable = leaseQueues.get(db);
	if (byTable === undefined) {
		byTable = new Map();
		leaseQueues.set(db, byTable);
	}
	let locks = byTable.get(t.objects);
	if (locks === undefined) {
		locks = new NamedLocks();
		byTable.set(t.objects, locks);
	}
	return locks;
}

/** sqliteObjectStore implements SqliteObjectStore. */
class sqliteObjectStore implements SqliteObjectStore {
	readonly locking: SqliteLocking;
	readonly namespace: string | undefined;
	readonly #db: SqlDatabase;
	readonly #t: Tables;
	readonly #maxChunkBytes: number;
	readonly #clock: () => number;
	readonly #local: NamedLocks;
	readonly #leases: LeaseLocks | undefined;

	constructor(
		db: SqlDatabase,
		namespace: string | undefined,
		t: Tables,
		maxChunkBytes: number,
		clock: () => number,
		local: NamedLocks,
		leases: LeaseLocks | undefined,
	) {
		this.locking = leases === undefined ? "local" : "lease";
		this.namespace = namespace;
		this.#db = db;
		this.#t = t;
		this.#maxChunkBytes = maxChunkBytes;
		this.#clock = clock;
		this.#local = local;
		this.#leases = leases;
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		const k = encodeKey(key);
		const { objects, chunks } = this.#t;
		const rows = await this.#read("get", key, {
			sql:
				`SELECT 0 AS seq, size, mod_time, data FROM ${objects} WHERE key = ${textParam} ` +
				`UNION ALL SELECT seq, NULL, NULL, data FROM ${chunks} WHERE key = ${textParam} ORDER BY seq`,
			params: [k, k],
		});
		return assemble(key, rows);
	}

	async stat(key: string): Promise<ObjectInfo | undefined> {
		const k = encodeKey(key);
		const rows = await this.#read("stat", key, {
			sql: `SELECT size, mod_time FROM ${this.#t.objects} WHERE key = ${textParam}`,
			params: [k],
		});
		const row = rows[0];
		if (row === undefined) {
			return undefined;
		}
		return {
			modTime: asInteger(row.mod_time, `${this.#t.objects}.mod_time`),
			size: asInteger(row.size, `${this.#t.objects}.size`),
		};
	}

	async put(key: string, data: Uint8Array): Promise<void> {
		const k = encodeKey(key);
		const [first, ...rest] = this.#split(data);
		const { objects, chunks } = this.#t;
		await this.#write("put", key, [
			{ sql: `DELETE FROM ${chunks} WHERE key = ${textParam}`, params: [k] },
			{
				sql: `INSERT OR REPLACE INTO ${objects} (key, size, mod_time, data) VALUES (${textParam}, ?, ?, ${blobParam})`,
				params: [k, data.length, this.#now(), first ?? new Uint8Array(0)],
			},
			...rest.map((chunk, i) => ({
				sql: `INSERT INTO ${chunks} (key, seq, data) VALUES (${textParam}, ?, ${blobParam})`,
				params: [k, i + 1, chunk],
			})),
		]);
	}

	async create(key: string, data: Uint8Array): Promise<boolean> {
		const k = encodeKey(key);
		const [first, ...rest] = this.#split(data);
		const { objects, chunks } = this.#t;
		// The object row is created last, by an INSERT that the primary key decides and
		// that reports whether it inserted. The chunks before it are written only if the
		// object is absent; inside the batch's transaction nothing else writes, so that
		// is exactly when the final INSERT succeeds, and either the whole object is
		// written or nothing is.
		const absent = `NOT EXISTS (SELECT 1 FROM ${objects} WHERE key = ${textParam})`;
		const results = await this.#write("create", key, [
			...rest.map((chunk, i) => ({
				sql: `INSERT INTO ${chunks} (key, seq, data) SELECT ${textParam}, ?, ${blobParam} WHERE ${absent}`,
				params: [k, i + 1, chunk, k],
			})),
			{
				sql:
					`INSERT INTO ${objects} (key, size, mod_time, data) VALUES (${textParam}, ?, ?, ${blobParam}) ` +
					"ON CONFLICT (key) DO NOTHING RETURNING 1 AS created",
				params: [k, data.length, this.#now(), first ?? new Uint8Array(0)],
			},
		]);
		return (results[rest.length]?.length ?? 0) > 0;
	}

	async deletePrefix(prefix: string): Promise<void> {
		const r = prefixRange(prefix);
		if (r === undefined) {
			return;
		}
		const where = r.to === undefined ? `key >= ${textParam}` : `key >= ${textParam} AND key < ${textParam}`;
		const params = r.to === undefined ? [r.from] : [r.from, r.to];
		await this.#write("deletePrefix", prefix, [
			{ sql: `DELETE FROM ${this.#t.chunks} WHERE ${where}`, params },
			{ sql: `DELETE FROM ${this.#t.objects} WHERE ${where}`, params },
		]);
	}

	lock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const leases = this.#leases;
		if (leases === undefined) {
			return this.#local.run(name, fn, signal);
		}
		// Waiting in process first means at most one caller per lock and realm polls the
		// database for its lease.
		return this.#local.run(name, () => leases.run(name, fn, signal), signal);
	}

	/** now returns the clock's current time as a whole number of milliseconds. */
	#now(): number {
		const now = Math.floor(this.#clock());
		if (!Number.isSafeInteger(now)) {
			throw new Error(`sqlite: the clock returned ${now}, not a time in milliseconds`);
		}
		return now;
	}

	/**
	 * split divides data into the BLOBs to store: its first maxChunkBytes bytes for the
	 * object's row, and the rest in chunks of maxChunkBytes. Each is a copy, so the caller
	 * may reuse data as soon as the call returns, and no engine is handed a view of a
	 * larger buffer.
	 */
	#split(data: Uint8Array): Uint8Array[] {
		const max = this.#maxChunkBytes;
		const out = [data.slice(0, max)];
		for (let off = max; off < data.length; off += max) {
			out.push(data.slice(off, off + max));
		}
		return out;
	}

	async #read(op: string, key: string, statement: SqlStatement): Promise<SqlRow[]> {
		try {
			return await this.#db.query(statement);
		} catch (err) {
			throw wrapError(`sqlite: ${op} ${JSON.stringify(key)}`, err);
		}
	}

	/**
	 * write runs statements as one batch, preceded by the lease fence if this store holds
	 * leases, and resolves to the rows each of statements returned.
	 */
	async #write(op: string, key: string, statements: SqlStatement[]): Promise<SqlRow[][]> {
		let fence: Fence | undefined;
		try {
			fence = this.#leases?.fence();
			if (fence === undefined) {
				return await this.#db.batch(statements);
			}
			return (await this.#db.batch([fence.statement, ...statements])).slice(1);
		} catch (err) {
			throw wrapError(`sqlite: ${op} ${JSON.stringify(key)}`, isLeaseLost(err) ? leaseLostError() : err);
		} finally {
			fence?.done();
		}
	}
}

/**
 * assemble reassembles the object at key from the rows get read: its own row, numbered
 * 0, then its chunks in order. It returns undefined if there are none, and rejects rows
 * that do not add up to a whole object.
 */
function assemble(key: string, rows: readonly SqlRow[]): Uint8Array | undefined {
	const head = rows[0];
	if (head === undefined) {
		return undefined;
	}
	if (head.size === null) {
		throw corrupt(key, "it has chunks but no object row");
	}
	const size = asInteger(head.size, "size");
	const out = new Uint8Array(size);
	let off = 0;
	for (const [i, row] of rows.entries()) {
		if (asInteger(row.seq, "seq") !== i) {
			throw corrupt(key, `chunk ${i} is missing`);
		}
		const data = asBytes(row.data, "data");
		if (off + data.length > size) {
			throw corrupt(key, `its rows hold more than its ${size} bytes`);
		}
		out.set(data, off);
		off += data.length;
	}
	if (off !== size) {
		throw corrupt(key, `its rows hold ${off} bytes, want ${size}`);
	}
	return out;
}

function corrupt(key: string, why: string): Error {
	return new Error(`sqlite: object ${JSON.stringify(key)} is corrupt: ${why}`);
}
