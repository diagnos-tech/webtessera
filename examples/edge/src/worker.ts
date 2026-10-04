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
// The log server example (../log-server) deployed as a Cloudflare Worker: the same routes,
// `POST /add` and the tlog-tiles read API, from the same file, with the log kept in a
// SQLite-backed Durable Object. Node, Bun and Deno serve that file with ../log-server/src/main.ts;
// here a Durable Object does. See README.md.

import { DurableObject } from "cloudflare:workers";
import { importLogKey, openServerLog, type ServerLog } from "webtessera/server";
import { fromDurableObjectStorage } from "webtessera/storage/sqlite";
import { newLogServer } from "webtessera-example-log-server/app";

/** Env holds the bindings wrangler.jsonc and the Worker's secrets declare. */
export interface Env {
	/** LOG is the namespace of the LogObject Durable Object. */
	readonly LOG: DurableObjectNamespace<LogObject>;
	/** LOG_SKEY is the log's private key, `PRIVATE+KEY+<origin>+...`: a secret. */
	readonly LOG_SKEY: string;
}

/**
 * LogObject holds one log: its entries, tiles and checkpoints all live in the object's SQLite
 * storage, and its appender runs in the object for as long as the instance lives.
 */
export class LogObject extends DurableObject<Env> {
	readonly #log: Promise<ServerLog>;
	readonly #serve: Promise<(request: Request) => Promise<Response>>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Opened once per instance, before the object serves its first request; the next
		// instance resumes from storage.
		this.#log = ctx.blockConcurrencyWhile(async () =>
			openServerLog({
				key: await importLogKey(env.LOG_SKEY),
				// The runtime runs one instance of an object at a time, so the object is its
				// database's only writer, and the adapter's locks are local: no lease, no lease writes.
				storage: { sqlite: fromDurableObjectStorage(ctx.storage) },
				http: { cors: true },
			}),
		);
		this.#serve = this.#log.then((log) => newLogServer(log));
	}

	override async fetch(request: Request): Promise<Response> {
		return (await this.#serve)(request);
	}

	/** add appends data over RPC, for other Workers bound to the object, and returns its receipt. */
	async add(data: Uint8Array): Promise<string> {
		return (await (await this.#log).append(data)).text;
	}
}

export default {
	/** fetch hands every request to the log, which one Durable Object holds in its entirety. */
	fetch(request, env): Promise<Response> {
		return env.LOG.getByName("log").fetch(request);
	},
} satisfies ExportedHandler<Env>;
