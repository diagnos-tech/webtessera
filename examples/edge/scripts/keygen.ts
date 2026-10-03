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
// Generates the log's key pair once: `node scripts/keygen.ts log.example.com/v1`. The private
// key is the LOG_SKEY secret (`wrangler secret put LOG_SKEY`, and .dev.vars locally); the
// public key is what clients verify the log with.

import { argv, exit } from "node:process";
import { generateKey } from "webtessera/note";

const origin = argv[2] ?? "";
if (origin === "") {
	// biome-ignore lint/suspicious/noConsole: usage goes to the terminal.
	console.error("usage: node scripts/keygen.ts <origin>   e.g. node scripts/keygen.ts log.example.com/v1");
	exit(2);
}
const { skey, vkey } = generateKey(undefined, origin);
// biome-ignore lint/suspicious/noConsole: the key pair is this script's output.
console.log(
	[
		"Private key: run `wrangler secret put LOG_SKEY` and paste it; for `wrangler dev`, put it in .dev.vars:",
		`  echo 'LOG_SKEY=${skey}' > .dev.vars`,
		"Public key (publish it; clients verify the log with it):",
		`  ${vkey}`,
	].join("\n"),
);
