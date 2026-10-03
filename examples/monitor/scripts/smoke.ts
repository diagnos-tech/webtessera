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
// Runs the monitor on whichever runtime runs this file, with its state in a temporary
// directory, against the deliberately forking log of the tests: it must follow honest growth,
// then report the fork.
//
//     node scripts/smoke.ts
//     bun scripts/smoke.ts
//     deno run --allow-net --allow-read --allow-write --allow-env scripts/smoke.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitor } from "../src/monitor.ts";
import { newFileStateStore } from "../src/state.ts";
import { newForkingLog } from "../src/testing/forking_log.ts";

const runtime = "Deno" in globalThis ? "deno" : "Bun" in globalThis ? "bun" : "node";
const dir = await mkdtemp(join(tmpdir(), "webtessera-monitor-"));
const log = await newForkingLog();
try {
	await log.append("a", "b");
	await log.appendHonest("c");
	await log.appendForked("x");
	const state = newFileStateStore(dir);
	const monitor = await openMonitor({ url: new URL("http://log.test/"), vkey: log.vkey, state, fetch: log.fetch });
	await log.appendHonest("d");
	const grew = await monitor.check();
	log.serve("forked");
	const forked = await monitor.check();
	if (grew.kind !== "grew" || forked.kind !== "fork") {
		throw new Error(`expected grew then fork, got ${grew.kind} then ${forked.kind}`);
	}
	// biome-ignore lint/suspicious/noConsole: the verdict is this script's output.
	console.log(
		`smoke: ok on ${runtime}: followed ${grew.from} -> ${grew.to}, then reported the fork (${forked.evidence})`,
	);
} finally {
	await log.close();
	await rm(dir, { recursive: true, force: true });
}
