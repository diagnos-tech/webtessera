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
// Starts the log server on whichever runtime loaded it. This is the composition root: it opens
// the database through the runtime's adapter, the log on it with the safe API, and serves the
// handler from log_server.ts.

import { importLogKey, openServerLog, type ServerLog } from "webtessera/server";
import type { SqlDatabase, SqliteLocking } from "webtessera/storage/sqlite";
import { newLogServer } from "./log_server.ts";
import type { Runtime } from "./runtime/runtime.ts";

/** LogServerConfig is everything the server needs to start. */
export interface LogServerConfig {
	/** logKey is the log's private key, `PRIVATE+KEY+<origin>+...`, from your secret store. */
	readonly logKey: string;
	/** database is the SQLite file the log lives in. */
	readonly database: string;
	/**
	 * locking says who may write the database. "lease" is correct however many processes
	 * share the file; "local" declares that this process is its only writer.
	 */
	readonly locking: SqliteLocking;
	readonly port: number;
	readonly hostname: string;
}

/** RunningLogServer is a log server that is accepting requests. */
export interface RunningLogServer {
	readonly url: URL;
	readonly log: ServerLog;
	/** close stops serving, waits until every accepted entry is published, then closes the database. */
	close(): Promise<void>;
}

/**
 * openPublicLog opens the log kept in database with the options this server runs it with. The
 * tests open their logs with it too, so that what they check is what the server serves.
 */
export async function openPublicLog(
	database: SqlDatabase,
	config: Pick<LogServerConfig, "logKey" | "locking">,
): Promise<ServerLog> {
	return openServerLog({
		key: await importLogKey(config.logKey),
		// Say which locking is wanted rather than rely on a default: with "lease", several
		// processes (on any of the three runtimes) can append to the same file without forking
		// the log, because each write is fenced on a lease held in the database itself.
		storage: { sqlite: database, locking: config.locking },
		// The log is public: browsers on any origin may read and verify it.
		http: { cors: true },
	});
}

/** startLogServer opens the database and the log in it, and serves the log on config's port. */
export async function startLogServer(
	runtime: Runtime,
	config: LogServerConfig,
	onError?: (err: unknown) => void,
): Promise<RunningLogServer> {
	const db = runtime.openSqlite(config.database);
	const log = await openPublicLog(db.database, config);
	const server = await runtime.serve(newLogServer(log, onError === undefined ? {} : { onError }), config);
	return {
		url: server.url,
		log,
		close: async () => {
			await server.close();
			await log.close();
			db.close();
		},
	};
}
