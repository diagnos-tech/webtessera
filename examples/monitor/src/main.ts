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
// The monitor's command line, the same file on every runtime:
//
//     node src/main.ts <log URL> <vkey> [--state DIR] [--every SECONDS] [--once]
//     bun src/main.ts ...
//     deno run --allow-net --allow-read --allow-write src/main.ts ...
//
// It checks the log every SECONDS (30 by default), keeping its state in DIR (.monitor). It exits
// 3 on a fork, after saving the evidence, and 1 if it cannot resume from its saved checkpoint.
// With --once it checks once, and exits 0 if the log is consistent, 1 on an error, 2 on a
// rollback and 3 on a fork, for cron jobs and CI.

import { argv, exit } from "node:process";
import { type MonitorEvent, openMonitor } from "./monitor.ts";
import { newFileStateStore } from "./state.ts";

const args = argv.slice(2);
const [url, vkey] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(state|every)$/));
if (url === undefined || vkey === undefined) {
	say("usage: node src/main.ts <log URL> <vkey> [--state DIR] [--every SECONDS] [--once]");
	exit(64);
}
const stateDir = option("--state") ?? ".monitor";
const everyMs = Number(option("--every") ?? "30") * 1000;

const monitor = await openMonitor({ url: new URL(url), vkey, state: newFileStateStore(stateDir) }).catch((err) => {
	// Resuming builds proofs at the saved checkpoint's size from the log's tiles. A log that no
	// longer has them shrank, or forked, below what this monitor verified.
	alarm(`cannot resume from ${stateDir}/checkpoint: ${err instanceof Error ? err.message : String(err)}`);
	return exit(1);
});
say(`${monitor.started.resumed ? "resumed from" : "trusting on first use"} a checkpoint of ${monitor.started.size}`);
for (;;) {
	const event = await monitor.check();
	report(event);
	if (args.includes("--once")) {
		exit({ grew: 0, unchanged: 0, error: 1, rollback: 2, fork: 3 }[event.kind]);
	}
	if (event.kind === "fork") {
		exit(3);
	}
	await new Promise((resolve) => setTimeout(resolve, everyMs));
}

function report(event: MonitorEvent): void {
	switch (event.kind) {
		case "grew":
			say(`ok: grew from ${event.from} to ${event.to} entries, consistency proven`);
			break;
		case "unchanged":
			say(`ok: still ${event.size} entries`);
			break;
		case "error":
			say(`error: could not check the log: ${event.detail}`);
			break;
		case "rollback":
			alarm(`ROLLBACK: the log served a checkpoint of ${event.served} entries after one of ${event.verified}`);
			break;
		case "fork":
			alarm(
				`FORK: the log signed two histories that cannot both be true.\n${event.detail}\nevidence: ${event.evidence}`,
			);
			break;
	}
}

function option(name: string): string | undefined {
	const i = args.indexOf(name);
	return i < 0 ? undefined : args[i + 1];
}

function say(line: string): void {
	// biome-ignore lint/suspicious/noConsole: a monitor's verdicts are its console output.
	console.log(`${new Date().toISOString()} ${line}`);
}

function alarm(text: string): void {
	// biome-ignore lint/suspicious/noConsole: alarms go to stderr, where supervisors look.
	console.error(`\n!!! ${new Date().toISOString()} ${text}\n`);
}
