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

// This file has no upstream counterpart. It implements the ObjectStore contract on
// IndexedDB so that the shared storage driver can keep a log in a browser, in any tab
// or worker of an origin. See docs/decisions/0110-indexeddb-object-store.md.

import type { FetchFn } from "../../client/fetcher.ts";
import { SentinelError, wrapError } from "../../internal/gostd/errors.ts";
import { newObjectStoreDriver, ObjectStoreDriver } from "../objectstore/driver.ts";
import type { ObjectInfo, ObjectStore } from "../objectstore/objectstore.ts";
import { type Locker, type LockScope, localLockerFor, newWebLocker } from "./locks.ts";

/**
 * schemaVersion is the version of the database layout this code creates and expects.
 * Bump it, and add a step to upgradeSchema, whenever the layout changes.
 */
const schemaVersion = 1;

// objectsStoreName names the IndexedDB object store holding one record per
// ObjectStore key, under that key.
const objectsStoreName = "objects";

// writeOptions requests strict durability for every write: a transaction completes
// only once the browser has flushed it to disk. A log must never lose an entry it
// has acknowledged; see docs/decisions/0111-indexeddb-strict-durability.md.
const writeOptions: IDBTransactionOptions = { durability: "strict" };

/**
 * storedObject is the record kept for each key.
 *
 * It has no size field: IndexedDB cannot read part of a record, so stat loads data
 * regardless and its length is the authoritative size.
 */
interface storedObject {
	readonly data: Uint8Array;
	/** modTime is when the record was written, in milliseconds since the Unix epoch. */
	readonly modTime: number;
}

/**
 * ErrClosed is the cause of every error reported by an IndexedDBObjectStore whose
 * database connection has been closed, whether by close, by another tab or worker
 * upgrading or deleting the database, or by the browser. Check for it with
 * `errorIs(err, ErrClosed)`; the wrapping error says which of those happened.
 */
export const ErrClosed = new SentinelError("indexeddb: database closed");

/** IndexedDBObjectStoreOptions configures openIndexedDBObjectStore. */
export interface IndexedDBObjectStoreOptions {
	/**
	 * name is the name of the IndexedDB database holding the log. Each log needs a
	 * database of its own: every store opened with the same name, in any tab or
	 * worker of the origin, reads and writes the same log.
	 */
	readonly name: string;

	/**
	 * indexedDB is the IndexedDB implementation to use. It defaults to
	 * `globalThis.indexedDB`, which windows and dedicated, shared and service workers
	 * all provide. Pass another implementation, such as fake-indexeddb's, together
	 * with its IDBKeyRange.
	 */
	readonly indexedDB?: IDBFactory;

	/**
	 * IDBKeyRange is the key range class of the indexedDB implementation. It defaults
	 * to `globalThis.IDBKeyRange`.
	 */
	readonly IDBKeyRange?: typeof IDBKeyRange;

	/**
	 * locks is the Web Locks LockManager through which the store takes its locks. It
	 * defaults to `globalThis.navigator.locks`, which browsers provide in secure
	 * contexts (HTTPS and localhost). If it is null, or the default is unavailable,
	 * locks can only exclude holders in the current realm, and opening the store fails
	 * unless singleWriter is true: see IndexedDBObjectStore.lockScope.
	 */
	readonly locks?: LockManager | null;

	/**
	 * singleWriter, when true, declares that this tab or worker is the only context that
	 * will write the log while the store is open, and so permits the store to open with
	 * locks that only exclude holders in the current realm when no Web Locks
	 * LockManager is available (a non-secure origin, an older browser, Node). Without
	 * it, opening the store fails in that situation rather than run with locks that do
	 * not exclude other tabs: two contexts appending to one log concurrently each
	 * believe they hold the tree-state lock and sign checkpoints for diverging trees.
	 * It has no effect when Web Locks are available, which are always used then.
	 * See docs/decisions/0201-indexeddb-locks-fail-closed.md.
	 */
	readonly singleWriter?: boolean;
}

/**
 * IndexedDBObjectStore is an ObjectStore kept in an IndexedDB database.
 *
 * Every write is a single IndexedDB transaction committed with strict durability, so
 * it is atomic and has reached disk by the time its promise resolves. Locks are Web
 * Locks scoped to the database, so drivers in different tabs and workers of the same
 * origin can safely share one log.
 *
 * The store closes its connection as soon as another context needs to upgrade or
 * delete the database, rather than blocking it; from then on every method rejects
 * with an error caused by ErrClosed, and the application should reopen the store
 * (typically by reloading the page, which picks up the newer code).
 *
 * Browsers may evict IndexedDB data under storage pressure unless the origin has been
 * granted persistent storage. A log whose checkpoints leave the device should request
 * it with `navigator.storage.persist()`.
 */
export interface IndexedDBObjectStore extends ObjectStore {
	/** name is the name of the underlying IndexedDB database. */
	readonly name: string;

	/**
	 * lockScope is "origin" when locks exclude every tab and worker of the origin, as
	 * the ObjectStore contract requires of a shared backend, and "realm" when the Web
	 * Locks API was unavailable and they only exclude holders in this tab or worker.
	 * A store has a "realm" scope only if it was opened with singleWriter: true, and
	 * the application must then itself ensure that only one context writes the log at
	 * a time.
	 */
	readonly lockScope: LockScope;

	/**
	 * close closes the database connection once its in-flight operations finish.
	 * Every later call rejects with an error caused by ErrClosed. Closing twice is a
	 * no-op.
	 */
	close(): void;
}

/**
 * openIndexedDBObjectStore opens the IndexedDB database called opts.name, creating it
 * if it does not exist, and returns an ObjectStore backed by it.
 *
 * If another tab or worker holds the database open with an older schema and does not
 * close it, opening waits for it to do so. If signal aborts before the database is
 * open, openIndexedDBObjectStore rejects with the signal's reason.
 *
 * If no Web Locks LockManager is available (opts.locks is null, or
 * `navigator.locks` is missing), it rejects, before touching the database, unless
 * opts.singleWriter is true. See docs/decisions/0201-indexeddb-locks-fail-closed.md.
 */
export async function openIndexedDBObjectStore(
	opts: IndexedDBObjectStoreOptions,
	signal?: AbortSignal,
): Promise<IndexedDBObjectStore> {
	const factory = opts.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
	if (factory === undefined) {
		throw new Error("indexeddb: IndexedDB is not available in this runtime; pass opts.indexedDB");
	}
	const keyRange = opts.IDBKeyRange ?? (globalThis as { IDBKeyRange?: typeof IDBKeyRange }).IDBKeyRange;
	if (keyRange === undefined) {
		throw new Error("indexeddb: IDBKeyRange is not available in this runtime; pass opts.IDBKeyRange");
	}
	const manager =
		opts.locks === undefined ? (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks : opts.locks;
	let locker: Locker;
	if (manager === undefined || manager === null) {
		if (opts.singleWriter !== true) {
			throw new Error(
				`indexeddb: open database ${JSON.stringify(opts.name)}: the Web Locks API (navigator.locks) is not available ` +
					"in this context (it requires a secure context: HTTPS or localhost), so locks could not exclude other tabs " +
					"and workers writing the same log; serve the page from a secure context, pass opts.locks, or pass " +
					"singleWriter: true if this is the only context that will ever write this log",
			);
		}
		locker = localLockerFor(factory);
	} else {
		locker = newWebLocker(manager);
	}

	const db = await openDatabase(factory, opts.name, signal);
	return new idbObjectStore(opts.name, db, keyRange, locker);
}

/** IndexedDBDriverConfig configures newIndexedDBDriver. */
export interface IndexedDBDriverConfig extends IndexedDBObjectStoreOptions {
	/** fetch is used for outgoing HTTP requests, e.g. to witnesses. If unset, the global fetch is used. */
	readonly fetch?: FetchFn;
}

/**
 * IndexedDBDriver is the storage driver newIndexedDBDriver returns: the shared
 * ObjectStoreDriver, plus the lock scope of the store it runs on.
 */
export interface IndexedDBDriver extends ObjectStoreDriver {
	/**
	 * lockScope is the effective scope of the store's locks: "origin" (Web Locks), or
	 * "realm" when the driver was opened with singleWriter: true in a context without
	 * Web Locks. See IndexedDBObjectStore.lockScope.
	 */
	readonly lockScope: LockScope;
}

/** indexedDBDriver implements IndexedDBDriver. */
class indexedDBDriver extends ObjectStoreDriver implements IndexedDBDriver {
	readonly lockScope: LockScope;

	constructor(base: ObjectStoreDriver, lockScope: LockScope) {
		super(base.cfg);
		this.lockScope = lockScope;
	}
}

/**
 * newIndexedDBDriver opens the IndexedDB database called cfg.name, creating it if it
 * does not exist, and returns a storage driver that keeps the log in it.
 *
 * signal bounds the database connection's lifetime as newAppender's signal bounds the
 * appender's background work: aborting it abandons opening or, once the database is
 * open, closes the connection. Passing the same signal to both and aborting it after
 * awaiting the appender's shutdown therefore stops the log cleanly. Without a signal,
 * the connection stays open for the life of the realm, or until another context
 * upgrades or deletes the database.
 *
 * As openIndexedDBObjectStore does, it rejects when no Web Locks LockManager is
 * available unless cfg.singleWriter is true; the returned driver's lockScope says which
 * kind of locks it runs with.
 *
 * To reach the store itself, open it with openIndexedDBObjectStore and pass it to
 * newObjectStoreDriver instead.
 */
export async function newIndexedDBDriver(cfg: IndexedDBDriverConfig, signal?: AbortSignal): Promise<IndexedDBDriver> {
	const store = await openIndexedDBObjectStore(cfg, signal);
	if (signal !== undefined) {
		if (signal.aborted) {
			store.close();
			throw signal.reason;
		}
		signal.addEventListener("abort", () => store.close(), { once: true });
	}
	return new indexedDBDriver(
		newObjectStoreDriver(cfg.fetch === undefined ? { store } : { store, fetch: cfg.fetch }),
		store.lockScope,
	);
}

/**
 * openDatabase opens the database called name at schemaVersion, creating or upgrading
 * it as needed.
 */
function openDatabase(factory: IDBFactory, name: string, signal: AbortSignal | undefined): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		signal?.throwIfAborted();
		const req = factory.open(name, schemaVersion);
		let abandoned = false;
		const onAbort = (): void => {
			abandoned = true;
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		req.onupgradeneeded = (event) => {
			upgradeSchema(req.result, event.oldVersion);
		};
		req.onsuccess = () => {
			signal?.removeEventListener("abort", onAbort);
			const db = req.result;
			if (abandoned) {
				// An open request cannot be cancelled, only outlived; close the connection
				// it eventually delivers so that it does not block future upgrades.
				db.close();
				return;
			}
			if (!db.objectStoreNames.contains(objectsStoreName)) {
				db.close();
				reject(new Error(`indexeddb: database ${JSON.stringify(name)} exists but was not created by webtessera`));
				return;
			}
			resolve(db);
		};
		req.onerror = () => {
			signal?.removeEventListener("abort", onAbort);
			const err = req.error;
			if (err?.name === "VersionError") {
				reject(
					wrapError(
						`indexeddb: open database ${JSON.stringify(name)}: it was written by a newer version of webtessera ` +
							`(this version supports schema version ${schemaVersion})`,
						err,
					),
				);
				return;
			}
			reject(wrapError(`indexeddb: open database ${JSON.stringify(name)}`, err));
		};
	});
}

/**
 * upgradeSchema migrates db, inside its versionchange transaction, from oldVersion to
 * schemaVersion. Each step migrates from the version before it, so a database created
 * from scratch (oldVersion 0) runs them all.
 */
function upgradeSchema(db: IDBDatabase, oldVersion: number): void {
	if (oldVersion < 1) {
		db.createObjectStore(objectsStoreName);
	}
}

/**
 * idbObjectStore implements IndexedDBObjectStore.
 *
 * Each method runs exactly one transaction and issues all of its requests
 * synchronously when the transaction is created. IndexedDB commits a transaction as
 * soon as it has no pending requests at the end of a task, so awaiting anything else
 * mid-transaction would silently commit it early; no method ever does.
 */
class idbObjectStore implements IndexedDBObjectStore {
	readonly name: string;
	readonly #db: IDBDatabase;
	readonly #keyRange: typeof IDBKeyRange;
	readonly #locker: Locker;
	// closed is the reason the connection was closed, or undefined while it is open.
	#closed: Error | undefined;

	constructor(name: string, db: IDBDatabase, keyRange: typeof IDBKeyRange, locker: Locker) {
		this.name = name;
		this.#db = db;
		this.#keyRange = keyRange;
		this.#locker = locker;

		db.onversionchange = (event) => {
			const what = event.newVersion === null ? "delete it" : `upgrade it to schema version ${String(event.newVersion)}`;
			this.#markClosed(`was closed so that another tab or worker could ${what}`);
			db.close();
		};
		db.onclose = () => {
			this.#markClosed("was closed by the browser, for example because site data was cleared");
		};
	}

	get lockScope(): LockScope {
		return this.#locker.scope;
	}

	get(key: string): Promise<Uint8Array | undefined> {
		return this.#transact("get", key, "readonly", (store) => {
			const req = store.get(key);
			// Every read deserialises a fresh array, so the caller's copy is already its own.
			return () => decodeRecord(req.result)?.data;
		});
	}

	stat(key: string): Promise<ObjectInfo | undefined> {
		return this.#transact("stat", key, "readonly", (store) => {
			const req = store.get(key);
			return () => {
				const o = decodeRecord(req.result);
				return o === undefined ? undefined : { modTime: o.modTime, size: o.data.length };
			};
		});
	}

	put(key: string, data: Uint8Array): Promise<void> {
		return this.#transact("put", key, "readwrite", (store) => {
			store.put(newRecord(data), key);
			return () => undefined;
		});
	}

	create(key: string, data: Uint8Array): Promise<boolean> {
		return this.#transact("create", key, "readwrite", (store) => {
			let created = true;
			const req = store.add(newRecord(data), key);
			req.onerror = (event) => {
				if (req.error?.name === "ConstraintError") {
					// add fails with ConstraintError exactly when the key is taken, which
					// is O_EXCL's EEXIST. Cancelling the event stops the error from
					// aborting the transaction, so the outcome is still reported when it
					// completes.
					created = false;
					event.preventDefault();
				}
			};
			return () => created;
		});
	}

	deletePrefix(prefix: string): Promise<void> {
		return this.#transact("deletePrefix", prefix, "readwrite", (store) => {
			const range = prefixRange(this.#keyRange, prefix);
			if (range === undefined) {
				store.clear();
			} else {
				store.delete(range);
			}
			return () => undefined;
		});
	}

	lock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.#closed !== undefined) {
			return Promise.reject(wrapError(`indexeddb: lock ${JSON.stringify(name)}`, this.#closed));
		}
		return this.#locker.request(lockName(this.name, name), fn, signal);
	}

	close(): void {
		this.#markClosed("is closed");
		this.#db.close();
	}

	#markClosed(how: string): void {
		this.#closed ??= new Error(`database ${JSON.stringify(this.name)} ${how}`, { cause: ErrClosed });
	}

	/**
	 * transact runs one transaction over the objects store. issue makes the
	 * transaction's requests and returns a function that computes the result once the
	 * transaction has committed; the returned promise settles only then, so a write
	 * never resolves before it is durable.
	 */
	#transact<T>(
		op: string,
		key: string,
		mode: IDBTransactionMode,
		issue: (store: IDBObjectStore) => () => T,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const fail = (cause: unknown): void => {
				reject(wrapError(`indexeddb: ${op} ${JSON.stringify(key)}`, cause));
			};
			if (this.#closed !== undefined) {
				fail(this.#closed);
				return;
			}
			let tx: IDBTransaction;
			try {
				tx = this.#db.transaction(objectsStoreName, mode, mode === "readwrite" ? writeOptions : undefined);
			} catch (err) {
				fail(this.#closed ?? err);
				return;
			}
			let result: () => T;
			try {
				result = issue(tx.objectStore(objectsStoreName));
			} catch (err) {
				tx.abort();
				fail(err);
				return;
			}
			tx.oncomplete = () => {
				try {
					resolve(result());
				} catch (err) {
					fail(err);
				}
			};
			tx.onabort = () => {
				fail(tx.error ?? new Error("transaction aborted"));
			};
		});
	}
}

/**
 * newRecord returns the record that stores data as written now.
 *
 * IndexedDB clones what it stores, but the structured clone of a typed array
 * serialises the whole buffer behind it, so a small view into a large buffer would
 * persist all of it. Copying first stores exactly data's bytes and also turns a view
 * of a SharedArrayBuffer, which IndexedDB cannot store, into one it can.
 */
function newRecord(data: Uint8Array): storedObject {
	return { data: data.slice(), modTime: Date.now() };
}

/**
 * decodeRecord validates a value read from the objects store, returning undefined
 * for a missing key.
 */
function decodeRecord(value: unknown): storedObject | undefined {
	if (value === undefined) {
		return undefined;
	}
	const o = value as Partial<storedObject> | null;
	if (o === null || !(o.data instanceof Uint8Array) || typeof o.modTime !== "number") {
		throw new Error("malformed record");
	}
	return { data: o.data, modTime: o.modTime };
}

/**
 * prefixRange returns the key range holding exactly the keys that start with prefix,
 * or undefined if that is every key.
 *
 * IndexedDB orders string keys by UTF-16 code unit, so those keys form the half-open
 * range from prefix up to its successor: prefix truncated after its last code unit
 * below U+FFFF, with that code unit incremented. A prefix made only of U+FFFF code
 * units has no successor; every key at or above it starts with it.
 */
function prefixRange(keyRange: typeof IDBKeyRange, prefix: string): IDBKeyRange | undefined {
	for (let i = prefix.length - 1; i >= 0; i--) {
		const c = prefix.charCodeAt(i);
		if (c < 0xffff) {
			return keyRange.bound(prefix, prefix.slice(0, i) + String.fromCharCode(c + 1), false, true);
		}
	}
	return prefix === "" ? undefined : keyRange.lowerBound(prefix);
}

/**
 * lockName returns the Web Locks name for the ObjectStore lock called name on the
 * database called db.
 *
 * Web Locks are shared by the whole origin, so the name is qualified by the database
 * to keep two logs from contending. The database name is percent-encoded so that it
 * cannot contain the separator, which keeps distinct (db, name) pairs distinct; the
 * fixed prefix also keeps the name clear of the "-" prefix that Web Locks reserves.
 */
function lockName(db: string, name: string): string {
	return `webtessera/indexeddb/${encodeURIComponent(db)}/${name}`;
}
