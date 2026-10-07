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
import { combineHandlers, type Handler } from "../http/handler.ts";
import { type LogHandlerOptions, newLogHandler } from "../http/log_handler.ts";
import { isSignerKey, quoteInput, signerKeyMisuse, WebtesseraError } from "../safe/errors.ts";
import { assertLogKey } from "../safe/keys.ts";
import {
	type AsyncDisposableLog,
	disposable,
	type Explain,
	LogBase,
	type LogOptions,
	type LogParts,
	openLog,
	type TransparencyLog,
} from "../safe/log.ts";
import { assertServerRuntime } from "../safe/runtime.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { newObjectStoreDriver } from "../storage/objectstore/driver.ts";
import type { ObjectStore } from "../storage/objectstore/objectstore.ts";
import { isWriterConflict } from "../storage/sqlite/claim.ts";
import type { SqlDatabase, SqliteLockingOption } from "../storage/sqlite/database.ts";
import { namespacePattern } from "../storage/sqlite/schema.ts";
import { openSqliteObjectStore, type SqliteLeaseOptions } from "../storage/sqlite/sqlite.ts";

/**
 * ServerStorage says where a server log is kept. Pick one:
 *
 *   - `{ sqlite }`: any SQLite database, through an adapter from webtessera/storage/sqlite
 *     (`fromSqliteSync`, `fromLibsql`, `fromD1`, `fromDurableObjectStorage`, ...). Locking
 *     defaults to the adapter's, which fails closed: `"lease"`, correct however many
 *     processes share the database, for anything another process or connection could
 *     reach (a file, D1, rqlite, a remote libSQL), and local locks only where the adapter
 *     can show the database is private (in memory, a Durable Object). Pass
 *     `locking: "single-writer"` to declare that this process is certainly a shared
 *     database's only writer, saving the lease's writes: if another process starts writing
 *     it too, the one that started first stops writing (WRITER_CONFLICT) before the two can
 *     fork the log.
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
			/**
			 * locking overrides the adapter's default: `"lease"`, or `"single-writer"` (its
			 * older name, `"local"`, is kept as an alias) to declare this process the database's
			 * only writer; see SqliteObjectStoreOptions.locking.
			 */
			readonly locking?: SqliteLockingOption;
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
 * Deno.serve(log.fetch);
 * ```
 */
export interface ServerLog extends TransparencyLog {
	/**
	 * handler serves the log over the tlog-tiles read API (checkpoint, tiles, entry
	 * bundles), as newLogHandler from webtessera/http does, and resolves to undefined for
	 * every other request; combine it with your routes using combineHandlers.
	 */
	readonly handler: Handler;
	/**
	 * fetch serves the log over the tlog-tiles read API, as handler does, and answers every
	 * other request with 404 Not Found: the `(request) => Promise<Response>` that runtimes
	 * serve directly. It is bound, so pass it around as it is. It serves reads only; adding
	 * entries over HTTP is the application's decision (see readEntryBody in webtessera/http).
	 *
	 * ```ts
	 * Bun.serve({ fetch: log.fetch });
	 * Deno.serve(log.fetch);
	 * export default { fetch: log.fetch };            // Cloudflare Workers
	 * createServer(toNodeListener(log.fetch)).listen(8080); // Node
	 * ```
	 */
	readonly fetch: (request: Request) => Promise<Response>;
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
 * createServer(toNodeListener(log.fetch)).listen(8080);
 * ```
 */
export async function openServerLog(options: ServerLogOptions): Promise<ServerLog> {
	const where = "openServerLog";
	assertServerRuntime();
	if (typeof options !== "object" || options === null) {
		throw new WebtesseraError("INVALID_ARGUMENT", `${where} takes an options object: { key, storage }`);
	}
	assertLogKey(options.key, where);
	const { store, kind } = await openStorage(options.storage, where);
	const driver = newObjectStoreDriver(options.fetch === undefined ? { store } : { store, fetch: options.fetch });
	const parts = await openLog(where, options, { driver, store, explain: explainStorage });
	return disposable(new serverLog(parts, kind, newLogHandler({ ...options.http, reader: parts.reader })));
}

/** serverLog implements ServerLog. */
class serverLog extends LogBase implements Omit<ServerLog, keyof AsyncDisposableLog> {
	readonly handler: Handler;
	readonly fetch: (request: Request) => Promise<Response>;
	readonly storage: ServerLog["storage"];

	constructor(parts: LogParts, storage: ServerLog["storage"], handler: Handler) {
		super(parts);
		this.storage = storage;
		this.handler = handler;
		this.fetch = combineHandlers(handler);
	}
}

/**
 * explainStorage says what a SQLite store's refusal to write means for the log: another
 * process took the database over under a single-writer declaration.
 */
const explainStorage: Explain = (err, method) => {
	if (!isWriterConflict(err)) {
		return undefined;
	}
	return new WebtesseraError(
		"WRITER_CONFLICT",
		`${method}: another process has started writing this log's SQLite database, which this process opened with ` +
			'locking: "single-writer" (or "local"), so this process has stopped writing it before the two could fork ' +
			"the log; the entry was not added. The single-writer declaration was wrong: give every process that " +
			'writes the database the default lease locking (locking: "lease", or no locking option for a file).',
		{ cause: err },
	);
};

async function openStorage(
	storage: ServerStorage | undefined,
	where: string,
): Promise<{ store: ObjectStore; kind: ServerLog["storage"] }> {
	const choose =
		"choose where the log is kept: storage: { sqlite: fromSqliteSync(db) } (or another adapter from " +
		"webtessera/storage/sqlite), { objectStore: yourStore }, or { memory: true } for a log that is lost when the " +
		"process exits";
	if (typeof storage !== "object" || storage === null) {
		throw new WebtesseraError("INVALID_ARGUMENT", `${where}: ${choose}`);
	}
	if ("sqlite" in storage) {
		checkSqlDatabase(storage.sqlite, where);
		const locking = checkLocking(storage.locking, where);
		if (isSignerKey(storage.namespace)) {
			throw signerKeyMisuse(where, "storage.namespace");
		}
		if (
			storage.namespace !== undefined &&
			(typeof storage.namespace !== "string" || !namespacePattern.test(storage.namespace))
		) {
			throw new WebtesseraError(
				"INVALID_ARGUMENT",
				`${where}: storage.namespace must be 1 to 64 lowercase letters, digits and underscores, got ` +
					quoteInput(storage.namespace),
			);
		}
		// Lease locking excludes every process that reaches the database; local locking
		// excludes only this realm, and two processes appending under it fork the log. The
		// adapter's default is lease unless it can show that nothing outside this realm can
		// reach the database (docs/decisions/0210-sqlite-locking-fails-closed.md), so it is
		// left to choose unless the caller does.
		const store = await openSqliteObjectStore({
			database: storage.sqlite,
			...(locking === undefined ? {} : { locking }),
			...(storage.namespace === undefined ? {} : { namespace: storage.namespace }),
			...(storage.lease === undefined ? {} : { lease: storage.lease }),
		});
		return { store, kind: "sqlite" };
	}
	if ("objectStore" in storage) {
		if (storage.objectStore instanceof MemoryObjectStore) {
			throw new WebtesseraError(
				"INVALID_ARGUMENT",
				`${where}: a MemoryObjectStore keeps nothing once the process exits; pass storage: { memory: true } if ` +
					"that is what you want",
			);
		}
		return { store: storage.objectStore, kind: "objectStore" };
	}
	if ("memory" in storage && storage.memory === true) {
		return { store: new MemoryObjectStore(), kind: "memory" };
	}
	throw new WebtesseraError("INVALID_ARGUMENT", `${where}: ${choose}`);
}

/** checkLocking returns the locking option if it is one, and throws, saying which there are, otherwise. */
function checkLocking(locking: unknown, where: string): SqliteLockingOption | undefined {
	if (locking === undefined || locking === "lease" || locking === "single-writer" || locking === "local") {
		return locking;
	}
	if (isSignerKey(locking)) {
		throw signerKeyMisuse(where, "storage.locking");
	}
	throw new WebtesseraError(
		"INVALID_ARGUMENT",
		`${where}: storage.locking must be "lease" (the default for a database other processes can reach) or ` +
			`"single-writer" (its alias "local"), to declare this process the database's only writer; got ${quoteInput(locking)}`,
	);
}

/**
 * checkSqlDatabase throws unless db looks like a SqlDatabase, and names the adapter to wrap
 * it with when it looks like a database connection of an engine webtessera has one for.
 */
function checkSqlDatabase(db: unknown, where: string): void {
	const has = (o: unknown, name: string): boolean =>
		typeof o === "object" && o !== null && typeof (o as Record<string, unknown>)[name] === "function";
	if (has(db, "query") && has(db, "batch")) {
		return;
	}
	const sql = typeof db === "object" && db !== null ? (db as { sql?: unknown }).sql : undefined;
	// Most specific first: sqlite-wasm's oo1.DB has prepare too, and D1 has prepare and batch.
	const adapter =
		has(db, "exec") && has(db, "selectValue")
			? "fromSqliteWasm(db)"
			: has(db, "prepare")
				? has(db, "batch")
					? "fromD1(env.DB)"
					: "fromSqliteSync(db) (node:sqlite, bun:sqlite and better-sqlite3)"
				: has(db, "execute") && has(db, "batch")
					? "fromLibsql(client)"
					: has(sql, "exec")
						? "fromDurableObjectStorage(ctx.storage)"
						: undefined;
	throw new WebtesseraError(
		"INVALID_ARGUMENT",
		adapter === undefined
			? `${where}: storage.sqlite must be a SqlDatabase, made from your engine's connection by an adapter from ` +
					"webtessera/storage/sqlite, such as fromSqliteSync(db)"
			: `${where}: storage.sqlite is a database connection, not a SqlDatabase: wrap it with ${adapter} from ` +
					"webtessera/storage/sqlite",
	);
}
