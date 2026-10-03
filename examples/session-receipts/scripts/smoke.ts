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
// Starts the real server on whichever runtime runs this file, against a temporary SQLite file,
// and drives it over HTTP with the browser's own session code (an in-memory log stands in for
// IndexedDB): two recorded calls, an upload, and an audit of the commit.
//
//     node scripts/smoke.ts
//     bun scripts/smoke.ts
//     deno run --allow-net --allow-read --allow-write --allow-env scripts/smoke.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLogKey } from "webtessera/browser";
import { newSinkTarget } from "webtessera/mirror";
import { generateKey } from "webtessera/note";
import { originHash } from "webtessera/witness";
import { auditSession } from "../audit/audit.ts";
import { pushLog } from "../client/src/push.ts";
import { recordedFetch } from "../client/src/recorder.ts";
import { openSession, registerSession } from "../client/src/session.ts";
import { committedPrefix } from "../server/committer.ts";
import { loadRuntime } from "../server/runtime/runtime.ts";
import { startServer } from "../server/server.ts";
import { newSessionOrigin, Routes } from "../shared/protocol.ts";

const runtime = await loadRuntime();
const dir = await mkdtemp(join(tmpdir(), "webtessera-session-receipts-"));
const witness = generateKey(undefined, "witness.localhost");
const server = await startServer(
	runtime,
	{
		witnessKey: witness.skey,
		witnessVkey: witness.vkey,
		database: join(dir, "server.db"),
		locking: "lease",
		port: 0,
		hostname: "127.0.0.1",
	},
	{},
);
try {
	const key = await generateLogKey(newSessionOrigin(server.url.host));
	const info = await registerSession({ server: server.url, key });
	const session = await openSession(info, { server: server.url, key, storage: { memory: true } });
	await recordedFetch(session, `${Routes.notes}smoke`, { method: "PUT", body: "hello" });
	await recordedFetch(session, `${Routes.notes}smoke`, { method: "GET" });
	const committed = await pushLog(session);
	await session.log.close();

	const audited = await auditSession({
		log: newSinkTarget(server.sink, {
			prefix: committedPrefix({ origin: info.origin, vkey: key.vkey, hash: originHash(info.origin) }),
		}),
		origin: info.origin,
		vkey: key.vkey,
		witness: witness.vkey,
	});
	// biome-ignore lint/suspicious/noConsole: the verdict is this script's output.
	console.log(
		`smoke: ok on ${runtime.name}: ${server.url} cosigned and committed ${committed} interactions; ` +
			`audit verified ${audited.interactions.map((i) => `${i.method} ${i.status}`).join(", ")}`,
	);
} finally {
	await server.close();
	await rm(dir, { recursive: true, force: true });
}
