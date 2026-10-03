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
// The notary's entry point, the same file on every runtime:
//
//     node src/main.ts            (Node.js 22.18+, node:sqlite)
//     bun src/main.ts             (Bun, bun:sqlite)
//     deno run -A src/main.ts     (Deno, node:sqlite)

import process from "node:process";
import { readConfig } from "./config.ts";
import { loadRuntime } from "./runtime/runtime.ts";
import { startNotary } from "./server.ts";

const runtime = await loadRuntime();
const notary = await startNotary(runtime, readConfig(), (err) => report("notarize failed:", err));
report(`notary ${notary.log.origin} on ${runtime.name}, serving ${notary.url}`);
report(`verifier key (publish it; receipts verify with it): ${notary.log.vkey}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void notary.close().then(() => report("stopped"));
	});
}

function report(...parts: unknown[]): void {
	// biome-ignore lint/suspicious/noConsole: a server's log lines are its console output.
	console.log(...parts);
}
