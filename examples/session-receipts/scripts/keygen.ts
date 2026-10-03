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
// Generates the witness's key pair once, in the env-file format the start scripts read:
//
//     node scripts/keygen.ts witness.example.com > .env
//
// WITNESS_SKEY is the secret the server cosigns with: keep it in your secret store. WITNESS_VKEY
// is public: browsers pin it when they register, and auditors check cosignatures with it.

import { argv, exit } from "node:process";
import { generateKey } from "webtessera/note";

const name = argv[2] ?? "";
if (name === "") {
	// biome-ignore lint/suspicious/noConsole: usage goes to the terminal.
	console.error(
		"usage: node scripts/keygen.ts <witness name>   e.g. node scripts/keygen.ts witness.example.com > .env",
	);
	exit(2);
}
const { skey, vkey } = generateKey(undefined, name);
// biome-ignore lint/suspicious/noConsole: the key pair is this script's output.
console.log(`WITNESS_SKEY=${skey}\nWITNESS_VKEY=${vkey}`);
