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
// The server's entry point, the same file on every runtime:
//
//     node server/main.ts            (Node.js 22.18+, node:sqlite)
//     bun server/main.ts             (Bun, bun:sqlite)
//     deno run -A server/main.ts     (Deno, node:sqlite)

import process, { env } from "node:process";
import { readConfig } from "./config.ts";
import { loadRuntime } from "./runtime/runtime.ts";
import { startServer } from "./server.ts";

const runtime = await loadRuntime();
const server = await startServer(runtime, readConfig(), env, (err) => report("commit failed:", err));
report(`session server on ${runtime.name}, serving ${server.url}`);
report(`witness key (browsers pin it): ${env.WITNESS_VKEY}`);
report(`commits to: ${server.commitsTo}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void server.close().then(() => report("stopped"));
	});
}

function report(...parts: unknown[]): void {
	// biome-ignore lint/suspicious/noConsole: a server's log lines are its console output.
	console.log(...parts);
}
