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
// Generates the log's key pair once, in the env-file format the start scripts read:
//
//     node scripts/keygen.ts log.example.com/v1 > .env
//
// The origin names the log; it is the first line of every checkpoint, and conventionally the
// URL the log is served at, without the scheme. LOG_SKEY is the secret: keep it in your secret
// store. LOG_VKEY is public: clients verify the log with it.

import { argv, exit } from "node:process";
import { generateLogKeyPair } from "webtessera/server";

const origin = argv[2] ?? "";
if (origin === "") {
	// biome-ignore lint/suspicious/noConsole: usage goes to the terminal.
	console.error("usage: node scripts/keygen.ts <origin>   e.g. node scripts/keygen.ts log.example.com/v1 > .env");
	exit(2);
}
const { skey, vkey } = generateLogKeyPair(origin);
// biome-ignore lint/suspicious/noConsole: the key pair is this script's output.
console.log(`LOG_SKEY=${skey}\nLOG_VKEY=${vkey}`);
