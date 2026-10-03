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
// Starts the real session server on Node for the browser tests (vitest.browser.config.ts), on a
// temporary SQLite file, with a fresh witness key, and stops it when they are done.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { generateKey } from "webtessera/note";
import { loadRuntime } from "../server/runtime/runtime.ts";
import { startServer } from "../server/server.ts";

// Vitest runs global setup once per project, and the Chromium instance is a project of its own
// besides the root one. The server is started once, shared, and stopped by the last teardown.
const shared = globalThis as { sessionReceiptsTestServer?: { users: number; stop: Promise<() => Promise<void>> } };

export default function setup(): () => Promise<void> {
	shared.sessionReceiptsTestServer ??= { users: 0, stop: start() };
	const s = shared.sessionReceiptsTestServer;
	s.users++;
	return async () => {
		if (--s.users === 0) {
			delete shared.sessionReceiptsTestServer;
			await (await s.stop)();
		}
	};
}

async function start(): Promise<() => Promise<void>> {
	const dir = await mkdtemp(join(tmpdir(), "session-receipts-browser-"));
	const witness = generateKey(undefined, "witness.localhost");
	const server = await startServer(
		await loadRuntime(),
		{
			witnessKey: witness.skey,
			witnessVkey: witness.vkey,
			database: join(dir, "server.db"),
			locking: "lease",
			port: Number(env.TEST_SERVER_PORT),
			hostname: "127.0.0.1",
		},
		{},
	);
	return async () => {
		await server.close();
		await rm(dir, { recursive: true, force: true });
	};
}
