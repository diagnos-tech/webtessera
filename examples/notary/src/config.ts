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
// Reads the notary's configuration from the environment (see README.md).

import { env } from "node:process";
import type { SqliteLocking } from "webtessera/storage/sqlite";
import type { NotaryConfig } from "./server.ts";

export function readConfig(): NotaryConfig {
	const notaryKey = env.NOTARY_SKEY ?? "";
	if (notaryKey === "") {
		throw new Error(
			"NOTARY_SKEY is not set. Generate a key once with `node scripts/keygen.ts <origin> > .env` " +
				"(e.g. notary.example.com/v1), then start the notary again.",
		);
	}
	const locking = env.NOTARY_LOCKING ?? "lease";
	if (locking !== "lease" && locking !== "local") {
		throw new Error(`NOTARY_LOCKING must be "lease" or "local", got ${JSON.stringify(locking)}`);
	}
	const port = Number(env.PORT ?? "8081");
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`PORT must be a port number, got ${JSON.stringify(env.PORT)}`);
	}
	return {
		notaryKey,
		database: env.NOTARY_DB ?? "notary.db",
		locking: locking satisfies SqliteLocking,
		port,
		hostname: env.HOST ?? "127.0.0.1",
	};
}
