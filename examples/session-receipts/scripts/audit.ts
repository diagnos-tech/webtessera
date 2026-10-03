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
// Audits a session from where the server committed it, as a third party would:
//
//     node --env-file=.env scripts/audit.ts <session log origin> <session log vkey>
//
// It reads the commit sink the server is configured with (the S3_* variables, or the server's
// database, SERVER_DB) and checks the committed log against both keys: the session's own, which
// the page shows, and the server's witness key, WITNESS_VKEY. Then it lists the interactions.

import { argv, env, exit } from "node:process";
import { newSinkTarget } from "webtessera/mirror";
import { openSqliteObjectStore } from "webtessera/storage/sqlite";
import { originHash } from "webtessera/witness";
import { auditSession } from "../audit/audit.ts";
import { committedPrefix } from "../server/committer.ts";
import { loadRuntime } from "../server/runtime/runtime.ts";
import { chooseSink } from "../server/sink.ts";

const [origin, vkey] = argv.slice(2);
const witness = env.WITNESS_VKEY ?? "";
if (origin === undefined || vkey === undefined || witness === "") {
	say("usage: node --env-file=.env scripts/audit.ts <session log origin> <session log vkey>  (needs WITNESS_VKEY)");
	exit(2);
}

const db = (await loadRuntime()).openSqlite(env.SERVER_DB ?? "session-receipts.db");
try {
	const fallback = await openSqliteObjectStore({ database: db.database, namespace: "commits" });
	const { sink, description } = chooseSink(env, fallback);
	const session = { origin, vkey, hash: originHash(origin) };
	const { size, interactions } = await auditSession({
		log: newSinkTarget(sink, { prefix: committedPrefix(session) }),
		origin,
		vkey,
		witness,
	});
	say(`OK: ${size} interactions in ${description}, signed by the session's device key and cosigned by the server:`);
	for (const [n, i] of interactions.entries()) {
		say(`  ${n}  ${i.at}  ${i.method} ${i.path} -> ${i.status}`);
	}
} catch (err) {
	say(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
	exit(1);
} finally {
	db.close();
}

function say(line: string): void {
	// biome-ignore lint/suspicious/noConsole: the audit is this script's output.
	console.log(line);
}
