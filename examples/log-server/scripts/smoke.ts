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
// Starts the real server on whichever runtime runs this file, against a temporary SQLite file,
// adds two entries over HTTP and verifies the log with webtessera/client. It is how the README's
// claim that the same code serves on Node, Bun and Deno is checked:
//
//     node scripts/smoke.ts
//     bun scripts/smoke.ts
//     deno run --allow-net --allow-read --allow-write --allow-env scripts/smoke.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKey } from "webtessera/note";
import { verifyLog } from "../src/client.ts";
import { loadRuntime } from "../src/runtime/runtime.ts";
import { startLogServer } from "../src/server.ts";

const runtime = await loadRuntime();
const dir = await mkdtemp(join(tmpdir(), "webtessera-log-server-"));
const { skey, vkey } = generateKey(undefined, "localhost/smoke");
const server = await startLogServer(runtime, {
	logKey: skey,
	database: join(dir, "log.db"),
	port: 0,
	hostname: "127.0.0.1",
});
try {
	const indices: string[] = [];
	for (const entry of ["hello", "world"]) {
		const res = await fetch(new URL("add", server.url), { method: "POST", body: entry });
		indices.push(await res.text());
		if (res.status !== 200) {
			throw new Error(`POST /add answered ${res.status}: ${indices.at(-1)}`);
		}
	}
	const verified = await verifyLog({
		url: server.url,
		vkey,
		index: BigInt(indices[1] ?? ""),
		entry: new TextEncoder().encode("world"),
	});
	// biome-ignore lint/suspicious/noConsole: the verdict is this script's output.
	console.log(
		`smoke: ok on ${runtime.name}: ${server.url} added entries ${indices.join(", ")}; ` +
			`checkpoint of ${verified.size} verified, entry ${indices[1]} proven`,
	);
} finally {
	await server.close();
	await rm(dir, { recursive: true, force: true });
}
