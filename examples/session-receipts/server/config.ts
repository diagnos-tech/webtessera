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
// Reads the server's configuration from the environment (see README.md).

import { env } from "node:process";
import type { SqliteLocking } from "webtessera/storage/sqlite";
import { newSignerForCosignatureV1, newVerifierForCosignatureV1 } from "webtessera/witness";

/** ServerConfig is everything the server needs to start, besides the commit sink (sink.ts). */
export interface ServerConfig {
	readonly witnessKey: string;
	readonly witnessVkey: string;
	/** database is the SQLite file the server keeps its state in. */
	readonly database: string;
	/** locking: "lease" for a file several processes may open, "local" to declare a single writer. */
	readonly locking: SqliteLocking;
	readonly port: number;
	readonly hostname: string;
}

export function readConfig(): ServerConfig {
	const witnessKey = env.WITNESS_SKEY ?? "";
	const witnessVkey = env.WITNESS_VKEY ?? "";
	if (witnessKey === "" || witnessVkey === "") {
		throw new Error(
			"WITNESS_SKEY and WITNESS_VKEY are not set. Generate the witness's key once with " +
				"`node scripts/keygen.ts <name> > .env` (e.g. witness.example.com), then start the server again.",
		);
	}
	checkKeyPair(witnessKey, witnessVkey);
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
		witnessVkey,
		database: env.SERVER_DB ?? "session-receipts.db",
		locking: locking satisfies SqliteLocking,
		port,
		hostname: env.HOST ?? "127.0.0.1",
	};
}

/** checkKeyPair refuses a WITNESS_VKEY that is not WITNESS_SKEY's: browsers would pin the wrong key. */
export function checkKeyPair(skey: string, vkey: string): void {
	const signer = newSignerForCosignatureV1(skey);
	const verifier = newVerifierForCosignatureV1(vkey);
	if (signer.name() !== verifier.name() || signer.keyHash() !== verifier.keyHash()) {
		throw new Error("WITNESS_VKEY is not the verifier key of WITNESS_SKEY");
	}
}
