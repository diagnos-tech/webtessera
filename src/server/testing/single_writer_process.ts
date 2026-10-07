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

// A process that appends to a log in a SQLite file through openServerLog, declaring itself
// the file's only writer, for the test that runs two of them against one file: the mistake
// the single-writer tripwire exists to catch. It opens the log, says "ready" on stderr, waits
// until the file named <go> exists (the test creates it once both processes are ready, so
// that both have opened the log before either appends), appends `count` entries at once, and
// writes {"receipts": [{"index", "text", "data"}], "errors": [code]} to stdout. Opening is a
// write too (it publishes a checkpoint), so when both open at once the other's claim can stop
// this open: then it says "ready" all the same and reports every entry as refused with the
// open's code. Test-only, Node-only; Node strips its types:
//
//	node single_writer_process.ts <file> <tag> <count> <go> <locking> <signer key>

import { existsSync } from "node:fs";
import { argv, stderr, stdout } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fromSqliteSync } from "../../storage/sqlite/adapters/sync.ts";
import { importLogKey, openServerLog, type ServerLog, WebtesseraError } from "../index.ts";

const [file = "", tag = "", count = "0", go = "", locking = "single-writer", skey = ""] = argv.slice(2);
const db = new DatabaseSync(file);
const opened = await openServerLog({
	key: await importLogKey(skey),
	storage: { sqlite: fromSqliteSync(db), locking: locking as "single-writer" | "local" },
	appendOptions: (o) => o.withBatching(8, 5),
	checkpointIntervalMs: 100,
	publishTimeoutMs: 10_000,
}).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
stderr.write("ready\n");
// The test creates the go file once both processes are ready; give up rather than outlive it.
for (const deadline = Date.now() + 60_000; !existsSync(go); ) {
	if (Date.now() > deadline) {
		throw new Error("no go file within 60 s");
	}
	await new Promise((resolve) => setTimeout(resolve, 10));
}
const receipts: { index: string; text: string; data: string }[] = [];
const errors: string[] = [];
if (!(opened instanceof Error)) {
	await appendAll(opened);
} else if (opened instanceof WebtesseraError) {
	errors.push(...Array.from({ length: Number(count) }, () => opened.code));
} else {
	throw opened;
}
db.close();
stdout.write(JSON.stringify({ receipts, errors }));

async function appendAll(log: ServerLog): Promise<void> {
	await Promise.all(
		Array.from({ length: Number(count) }, async (_, i) => {
			const data = `${tag} ${i}`;
			try {
				const r = await log.append(new TextEncoder().encode(data));
				receipts.push({ index: r.index.toString(), text: r.text, data });
			} catch (err) {
				errors.push(err instanceof WebtesseraError ? err.code : String(err));
			}
		}),
	);
	await log.close(AbortSignal.timeout(2_000)).catch(() => {});
}
