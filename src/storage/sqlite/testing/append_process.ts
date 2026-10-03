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

// A process that appends to a log kept in a SQLite file, for the tests that run several of
// them against one file at once. It opens the file with node:sqlite and the store's default
// options, appends `count` entries named after `tag`, and writes the indices they were
// assigned to stdout as a JSON array of decimal strings. Test-only, Node-only; run it
// directly, as Node strips its types:
//
//	node append_process.ts <file> <tag> <count> <signer key>

import { argv, stdout } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { newAppender, newAppendOptions } from "../../../append_lifecycle.ts";
import { newEntry } from "../../../entry.ts";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { newSigner } from "../../../vendor/note/note.ts";
import { fromSqliteSync } from "../adapters/sync.ts";
import { newSqliteDriver } from "../sqlite.ts";

const [file = "", tag = "", count = "0", skey = ""] = argv.slice(2);
const db = new DatabaseSync(file);
const ac = new AbortController();
const opts = newAppendOptions()
	.withCheckpointSigner(newSigner(skey))
	.withBatching(16, 5)
	.withCheckpointInterval(100)
	.withCheckpointRepublishInterval(0);
const { appender, shutdown } = await newAppender(
	await newSqliteDriver({ database: fromSqliteSync(db) }),
	opts,
	ac.signal,
);
const indices = await Promise.all(
	Array.from({ length: Number(count) }, async (_, i) =>
		String((await appender.add(newEntry(toUTF8(`${tag} ${i}`)))()).index),
	),
);
await shutdown();
ac.abort();
db.close();
stdout.write(JSON.stringify(indices));
