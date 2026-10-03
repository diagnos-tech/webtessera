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
// Starts the session server on whichever runtime loaded it: one SQLite file holds the registry,
// the witness's state and the staged uploads, each in tables of its own (a namespace), and the
// commit sink is a bucket or, without S3 settings, a fourth namespace of the same file.

import type { Sink } from "webtessera/mirror";
import { openSqliteObjectStore } from "webtessera/storage/sqlite";
import { newSessionServer, type SessionServer } from "./app.ts";
import type { ServerConfig } from "./config.ts";
import type { Runtime } from "./runtime/runtime.ts";
import { chooseSink } from "./sink.ts";

/** RunningServer is a session server that is accepting requests. */
export interface RunningServer extends SessionServer {
	readonly url: URL;
	/** sink is where witnessed logs are committed, and commitsTo describes it. */
	readonly sink: Sink;
	readonly commitsTo: string;
	close(): Promise<void>;
}

export async function startServer(
	runtime: Runtime,
	config: ServerConfig,
	env: Readonly<Record<string, string | undefined>>,
	onError?: (err: unknown) => void,
): Promise<RunningServer> {
	const db = runtime.openSqlite(config.database);
	// Lease locking unless told otherwise: the witness's check-and-record must be atomic across
	// every process that serves the same database, or two racing requests could roll a log back.
	const store = (namespace: string) =>
		openSqliteObjectStore({ database: db.database, namespace, locking: config.locking });
	const stores = {
		registry: await store("registry"),
		witness: await store("witness"),
		staging: await store("staging"),
	};
	const { sink, description } = chooseSink(env, await store("commits"));
	const server = newSessionServer({
		witnessKey: config.witnessKey,
		witnessVkey: config.witnessVkey,
		stores,
		sink,
		...(onError === undefined ? {} : { onError }),
	});
	const listening = await runtime.serve(server.fetch, config);
	return {
		...server,
		url: listening.url,
		sink,
		commitsTo: description,
		close: async () => {
			await listening.close();
			db.close();
		},
	};
}
