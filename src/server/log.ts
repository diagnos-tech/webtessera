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

// This file has no upstream counterpart. openServerLog is the server half of the safe API:
// it chooses durable storage and locking that excludes every writer, and serves the log
// over the tlog-tiles read API with webtessera/http. See
// docs/decisions/0226-the-high-level-log.md.

import type { FetchFn } from "../client/fetcher.ts";
import type { Handler } from "../http/handler.ts";
import { type LogHandlerOptions, newLogHandler } from "../http/log_handler.ts";
import { assertLogKey } from "../safe/keys.ts";
import { LogBase, type LogOptions, type LogParts, openLog, type TransparencyLog } from "../safe/log.ts";
import { assertServerRuntime } from "../safe/runtime.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { newObjectStoreDriver } from "../storage/objectstore/driver.ts";
import type { ObjectStore } from "../storage/objectstore/objectstore.ts";
import type { SqlDatabase, SqliteLocking } from "../storage/sqlite/database.ts";
import { openSqliteObjectStore, type SqliteLeaseOptions } from "../storage/sqlite/sqlite.ts";

/**
 * ServerStorage says where a server log is kept. Pick one:
 *
 *   - `{ sqlite }`: any SQLite database, through an adapter from webtessera/storage/sqlite
 *     (`fromSqliteSync`, `fromLibsql`, `fromD1`, `fromDurableObjectStorage`, ...). Locking
 *     defaults to `"lease"`, which is correct however many processes share the database;
 *     pass `locking: "local"` only when this process is certainly its only writer (a
 *     Durable Object, say), to save the lease's writes.
 *   - `{ objectStore }`: any durable ObjectStore of your own.
 *   - `{ memory: true }`: nothing survives the process, for tests and demos.
 *
 * ```ts
 * storage: { sqlite: fromD1(env.DB), namespace: "receipts" }
 * ```
 */
export type ServerStorage =
	| {
			readonly sqlite: SqlDatabase;
			/** namespace keeps the log in tables of its own; see SqliteObjectStoreOptions. */
			readonly namespace?: string;
			readonly locking?: SqliteLocking;
			readonly lease?: SqliteLeaseOptions;
	  }
	| { readonly objectStore: ObjectStore }
	| { readonly memory: true };

/**
 * ServerLogOptions configures openServerLog: the options every log takes (LogOptions), and
 * where a server log is kept and served.
 *
 * ```ts
 * { key, storage: { memory: true }, http: { prefix: "/log", cors: true } }
 * ```
 */
export interface ServerLogOptions extends LogOptions {
	/** storage is where the log is kept. There is no default: a log's storage is a decision. */
	readonly storage: ServerStorage;
	/** http configures the handler (mount prefix, CORS, caching); see webtessera/http. */
	readonly http?: Omit<LogHandlerOptions, "reader">;
	/** fetch makes the requests to witnesses. Defaults to the global fetch. */
	readonly fetch?: FetchFn;
}

/**
 * ServerLog is the log openServerLog returns: a TransparencyLog that can serve itself over HTTP.
 *
 * ```ts
 * Deno.serve(combineHandlers(log.handler, myRoutes));
 * ```
 */
export interface ServerLog extends TransparencyLog {
	/**
	 * handler serves the log over the tlog-tiles read API (checkpoint, tiles, entry
	 * bundles), as newLogHandler from webtessera/http does; combine it with your routes
	 * using combineHandlers.
	 */
	readonly handler: Handler;
	/** storage is the kind of storage the log is kept in. */
	readonly storage: "sqlite" | "objectStore" | "memory";
}

/**
 * openServerLog opens the log kept in `storage`, creating it if the storage is empty, and
 * starts appending to it with `key`. It refuses to run in a browser, to keep the log in
 * memory unless told to, and to open a log that another key created.
 *
 * ```ts
 * const log = await openServerLog({
 *   key: await importLogKey(env.LOG_SKEY),
 *   storage: { sqlite: fromSqliteSync(new DatabaseSync("log.db")) },
 * });
 * const receipt = await log.append(entry);
 * createServer(toNodeListener(combineHandlers(log.handler))).listen(8080);
 * ```
 */
export async function openServerLog(options: ServerLogOptions): Promise<ServerLog> {
	const where = "openServerLog";
	assertServerRuntime();
	if (typeof options !== "object" || options === null) {
		throw new TypeError(`${where} takes an options object: { key, storage }`);
	}
	assertLogKey(options.key, where);
	const { store, kind } = await openStorage(options.storage, where);
	const driver = newObjectStoreDriver(options.fetch === undefined ? { store } : { store, fetch: options.fetch });
	const parts = await openLog(where, options, { driver, store });
	return new serverLog(parts, kind, newLogHandler({ ...options.http, reader: parts.reader }));
}

/** serverLog implements ServerLog. */
class serverLog extends LogBase implements ServerLog {
	readonly handler: Handler;
	readonly storage: ServerLog["storage"];

	constructor(parts: LogParts, storage: ServerLog["storage"], handler: Handler) {
		super(parts);
		this.storage = storage;
		this.handler = handler;
	}
}

async function openStorage(
	storage: ServerStorage | undefined,
	where: string,
): Promise<{ store: ObjectStore; kind: ServerLog["storage"] }> {
	const choose =
		"choose where the log is kept: storage: { sqlite: fromSqliteSync(db) } (or another adapter from " +
		"webtessera/storage/sqlite), { objectStore: yourStore }, or { memory: true } for a log that is lost when the " +
		"process exits";
	if (typeof storage !== "object" || storage === null) {
		throw new TypeError(`${where}: ${choose}`);
	}
	if ("sqlite" in storage) {
		const store = await openSqliteObjectStore({
			database: storage.sqlite,
			// Lease locking excludes every process that reaches the database; local locking
			// excludes only this one, and two processes appending under it fork the log.
			locking: storage.locking ?? "lease",
			...(storage.namespace === undefined ? {} : { namespace: storage.namespace }),
			...(storage.lease === undefined ? {} : { lease: storage.lease }),
		});
		return { store, kind: "sqlite" };
	}
	if ("objectStore" in storage) {
		if (storage.objectStore instanceof MemoryObjectStore) {
			throw new TypeError(
				`${where}: a MemoryObjectStore keeps nothing once the process exits; pass storage: { memory: true } if ` +
					"that is what you want",
			);
		}
		return { store: storage.objectStore, kind: "objectStore" };
	}
	if ("memory" in storage && storage.memory === true) {
		return { store: new MemoryObjectStore(), kind: "memory" };
	}
	throw new TypeError(`${where}: ${choose}`);
}
