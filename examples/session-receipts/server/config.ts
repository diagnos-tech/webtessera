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
// Reads the server's configuration from the environment (see README.md).

import { env } from "node:process";
import type { SqliteLocking } from "webtessera/storage/sqlite";

/** ServerConfig is everything the server needs to start, besides the commit sink (sink.ts). */
export interface ServerConfig {
	/** witnessKey is the witness's private note key, from your secret store; its vkey is derived from it. */
	readonly witnessKey: string;
	/** database is the SQLite file the server keeps its state in. */
	readonly database: string;
	/** locking: "lease" for a file several processes may open, "local" to declare a single writer. */
	readonly locking: SqliteLocking;
	readonly port: number;
	readonly hostname: string;
}

export function readConfig(): ServerConfig {
	const witnessKey = env.WITNESS_SKEY ?? "";
	if (witnessKey === "") {
		throw new Error(
			"WITNESS_SKEY is not set. Generate the witness's key once with " +
				"`node scripts/keygen.ts <name> > .env` (e.g. witness.example.com), then start the server again.",
		);
	}
	const locking = env.SERVER_LOCKING ?? "lease";
	if (locking !== "lease" && locking !== "local") {
		throw new Error(`SERVER_LOCKING must be "lease" or "local", got ${JSON.stringify(locking)}`);
	}
	const port = Number(env.PORT ?? "8787");
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`PORT must be a port number, got ${JSON.stringify(env.PORT)}`);
	}
	return {
		witnessKey,
		database: env.SERVER_DB ?? "session-receipts.db",
		locking: locking satisfies SqliteLocking,
		port,
		hostname: env.HOST ?? "127.0.0.1",
	};
}
