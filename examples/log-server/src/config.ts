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
// Reads the server's configuration from the environment, so the same command works on Node
// (`--env-file`), Bun (which loads .env itself) and Deno (`--env-file`).

import { env } from "node:process";
import type { SqliteLockingOption } from "webtessera/storage/sqlite";
import type { LogServerConfig } from "./server.ts";

export function readConfig(): LogServerConfig {
	const logKey = env.LOG_SKEY ?? "";
	if (logKey === "") {
		throw new Error(
			"LOG_SKEY is not set. Generate a key once with `node scripts/keygen.ts <origin> > .env` " +
				"(the origin names the log, e.g. log.example.com/v1), then start the server again.",
		);
	}
	return {
		logKey,
		database: env.LOG_DB ?? "log.db",
		// Unset, the adapter decides: lease locking for the database file.
		locking: env.LOG_LOCKING === undefined ? undefined : locking(env.LOG_LOCKING),
		port: port(env.PORT ?? "8080"),
		hostname: env.HOST ?? "127.0.0.1",
	};
}

function locking(value: string): SqliteLockingOption {
	if (value !== "lease" && value !== "single-writer" && value !== "local") {
		throw new Error(`LOG_LOCKING must be "lease" or "single-writer", got ${JSON.stringify(value)}`);
	}
	return value;
}

function port(value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0 || n > 65535) {
		throw new Error(`PORT must be a port number, got ${JSON.stringify(value)}`);
	}
	return n;
}
