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
// Verifies a running log as any client would, trusting nothing but the log's verifier key:
//
//     node scripts/verify.ts http://127.0.0.1:8080/ "$LOG_VKEY" [index]
//
// It checks the checkpoint's signature, proves that the log only grew since the last run (the
// checkpoint is kept in .last-checkpoint), and, given an index, proves that the entry stored
// there is in the tree. Bun and Deno run it too (`bun scripts/verify.ts ...`).

import { readFile, writeFile } from "node:fs/promises";
import { argv, exit } from "node:process";
import { verifyLog } from "../src/client.ts";

const [url, vkey, index] = argv.slice(2);
if (url === undefined || vkey === undefined) {
	say("usage: node scripts/verify.ts <log URL> <vkey> [index]");
	exit(2);
}

const stateFile = ".last-checkpoint";
const previous = await readFile(stateFile).catch(() => undefined);
const verified = await verifyLog({
	url: new URL(url),
	vkey,
	...(previous === undefined ? {} : { previous }),
	...(index === undefined ? {} : { index: BigInt(index) }),
});
await writeFile(stateFile, verified.checkpoint);

say(`checkpoint: signed by the log, ${verified.size} entries, root ${toHex(verified.root)}`);
say(
	previous === undefined ? "consistency: first run, nothing to compare with" : "consistency: only grew since last run",
);
if (verified.entryAtIndex !== undefined) {
	say(`entry ${index}: proven in the tree: ${JSON.stringify(new TextDecoder().decode(verified.entryAtIndex))}`);
}

function toHex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function say(line: string): void {
	// biome-ignore lint/suspicious/noConsole: the verdict is this script's output.
	console.log(line);
}
