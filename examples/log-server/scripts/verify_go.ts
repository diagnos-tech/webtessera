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
// Optional: has Tessera's own Go client verify a log this server serves, to show that the two
// are byte-for-byte compatible. It needs Go and the pinned upstream checkout (run
// `node scripts/fetch-upstream.mjs` at the repository root once), which is why it is not part
// of `ci`:
//
//     node scripts/verify_go.ts

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, exit } from "node:process";
import { generateKey } from "webtessera/note";
import { loadRuntime } from "../src/runtime/runtime.ts";
import { startLogServer } from "../src/server.ts";

const go = env.GO ?? "go";
if (spawnSync(go, ["version"]).status !== 0) {
	say("verify:go needs Go (https://go.dev/dl/); set GO to its path if it is not on PATH");
	exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "webtessera-log-server-go-"));
const { skey, vkey } = generateKey(undefined, "localhost/go-interop");
const server = await startLogServer(await loadRuntime(), {
	logKey: skey,
	database: join(dir, "log.db"),
	port: 0,
	hostname: "127.0.0.1",
});
let status: number | null = 1;
try {
	// Enough entries for a full tile and entry bundle, and a partial one after them.
	const writes = Array.from({ length: 300 }, (_, i) =>
		fetch(new URL("add", server.url), { method: "POST", body: `entry ${i}` }).then((r) => r.text()),
	);
	await Promise.all(writes);
	// Asynchronously: the server answering Go's requests runs on this process's event loop.
	const child = spawn(go, ["run", ".", "-log", server.url.href, "-vkey", vkey], {
		stdio: "inherit",
		cwd: new URL("../go/", import.meta.url).pathname,
	});
	status = await new Promise((resolve) => child.on("close", resolve));
} finally {
	await server.close();
	await rm(dir, { recursive: true, force: true });
}
exit(status ?? 1);

function say(line: string): void {
	// biome-ignore lint/suspicious/noConsole: the verdict is this script's output.
	console.error(line);
}
