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
// Starts the notary on whichever runtime loaded it: the database through the runtime's
// adapter, the log on it with the safe API, and the routes from notary.ts plus the log's own
// read API.

import { combineHandlers } from "webtessera/http";
import { importLogKey, openServerLog, type ServerLog } from "webtessera/server";
import type { SqlDatabase, SqliteLocking } from "webtessera/storage/sqlite";
import { type NotaryOptions, newNotaryHandler } from "./notary.ts";
import type { Runtime } from "./runtime/runtime.ts";

/** NotaryConfig is everything the notary needs to start. */
export interface NotaryConfig {
	/** notaryKey is the notary log's private key, from your secret store. */
	readonly notaryKey: string;
	/** database is the SQLite file the log lives in. */
	readonly database: string;
	/** locking: "lease" for a file several processes may open, "local" to declare a single writer. */
	readonly locking: SqliteLocking;
	readonly port: number;
	readonly hostname: string;
}

/** RunningNotary is a notary that is accepting requests. */
export interface RunningNotary {
	readonly url: URL;
	readonly log: ServerLog;
	close(): Promise<void>;
}

/** openNotaryLog opens the notary's log in database. The tests open theirs with it too. */
export async function openNotaryLog(
	database: SqlDatabase,
	config: Pick<NotaryConfig, "notaryKey" | "locking">,
): Promise<ServerLog> {
	return openServerLog({
		key: await importLogKey(config.notaryKey),
		storage: { sqlite: database, locking: config.locking },
		// Anyone may audit the notary: its log is readable from any origin.
		http: { cors: true },
	});
}

/** newNotary returns the notary's fetch handler: `POST /notarize`, and the log's read API. */
export function newNotary(log: ServerLog, options: NotaryOptions = {}): (request: Request) => Promise<Response> {
	return combineHandlers(newNotaryHandler(log, options), log.handler);
}

export async function startNotary(
	runtime: Runtime,
	config: NotaryConfig,
	onError?: (err: unknown) => void,
): Promise<RunningNotary> {
	const db = runtime.openSqlite(config.database);
	const log = await openNotaryLog(db.database, config);
	const server = await runtime.serve(newNotary(log, onError === undefined ? {} : { onError }), config);
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
