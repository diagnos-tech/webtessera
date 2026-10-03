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

// Store factories for running the backend-independent suites against the SQLite
// ObjectStore on any engine. Runtime-neutral, so that the Node, Chromium, workerd and
// live-service suites all share it. Test-only.

import { fromHex, fromUTF8 } from "../../../internal/gostd/bytes.ts";
import type { ObjectStore } from "../../objectstore/objectstore.ts";
import type { SqlDatabase } from "../database.ts";
import { tableNames } from "../schema.ts";
import { openSqliteObjectStore, type SqliteObjectStoreOptions } from "../sqlite.ts";

/** StoreTarget is where a store keeps its log: a database, and optionally a namespace in it. */
export interface StoreTarget {
	readonly database: SqlDatabase;
	readonly namespace?: string;
}

/** StoreOptions are the options of openSqliteObjectStore other than where the log is kept. */
export type StoreOptions = Omit<SqliteObjectStoreOptions, "database" | "namespace">;

/** StoreFactory makes stores for the shared suites. */
export interface StoreFactory {
	/** newStore opens a store over a fresh, empty target. */
	newStore(): Promise<ObjectStore>;
	/**
	 * reopen opens a second store over the same target as store, through the database
	 * reopenDatabase returned: the same SqlDatabase for a second driver in the same
	 * process, or another one for a second process.
	 */
	reopen(store: ObjectStore): Promise<ObjectStore>;
	/** listKeys returns every key store holds, read straight from its objects table. */
	listKeys(store: ObjectStore): Promise<string[]>;
}

/**
 * storeFactory returns the factories the shared suites take. newTarget supplies each new
 * store's empty target; reopenDatabase supplies the database a reopened store uses, and
 * by default reuses the original's.
 */
export function storeFactory(
	newTarget: () => StoreTarget | Promise<StoreTarget>,
	options: StoreOptions = {},
	reopenDatabase: (db: SqlDatabase) => SqlDatabase | Promise<SqlDatabase> = (db) => db,
): StoreFactory {
	const targets = new WeakMap<ObjectStore, StoreTarget>();
	const open = async (target: StoreTarget): Promise<ObjectStore> => {
		const store = await openSqliteObjectStore({ ...options, ...target });
		targets.set(store, target);
		return store;
	};
	const targetOf = (store: ObjectStore): StoreTarget => {
		const target = targets.get(store);
		if (target === undefined) {
			throw new Error("store was not made by this factory");
		}
		return target;
	};
	return {
		newStore: async () => open(await newTarget()),
		reopen: async (store) => {
			const target = targetOf(store);
			return open({ ...target, database: await reopenDatabase(target.database) });
		},
		listKeys: async (store) => {
			const { database, namespace } = targetOf(store);
			// hex() reads each key back byte for byte, whatever the engine does with TEXT.
			const rows = await database.query({
				sql: `SELECT hex(key) AS key FROM ${tableNames(namespace).objects} ORDER BY key`,
				params: [],
			});
			return rows.map((r) => fromUTF8(fromHex(String(r.key))));
		},
	};
}

/**
 * otherProcess returns a SqlDatabase over the same database as db that shares none of its
 * in-process locks, as another process reaching the same database would see it. Lease
 * locking alone must then keep the two apart.
 */
export function otherProcess(db: SqlDatabase): SqlDatabase {
	return { query: (s) => db.query(s), batch: (s) => db.batch(s), defaultLocking: db.defaultLocking };
}

let namespaces = 0;

/** uniqueNamespace returns a namespace no other call in this realm returns, nor, very likely, any other realm. */
export function uniqueNamespace(): string {
	const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
	return `t${++namespaces}_${random}`;
}
