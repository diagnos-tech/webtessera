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

// Loads every entry point of the built package (dist/) at a Worker's global scope, in workerd,
// as a deployed Worker loads it. workerd refuses some operations outside a request handler
// (random numbers, timers, I/O), so a module that does one of them at load time breaks every
// Worker that imports it. The workers test suite cannot see this: vitest-pool-workers imports
// test modules inside a request.
//
// Usage, after `bun run build`:
//
//     node scripts/smoke-workerd.mjs
//
// Each entry point is bundled on its own with esbuild, under the `workerd` export condition as
// wrangler resolves it, and served by the workerd binary that wrangler runs; a Worker whose
// global scope throws never answers.

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = createRequire(import.meta.url)("../package.json");
// workerd is wrangler's dependency, not the repository's: resolve it from wrangler.
const workerdPackage = createRequire(realpathSync(join(root, "node_modules/wrangler/package.json"))).resolve(
	"workerd/package.json",
);
const workerd = join(dirname(workerdPackage), "bin", "workerd");

/** freePort asks the operating system for a TCP port no one is listening on. */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** serve runs a Worker in workerd and returns its answer to one request, or what it printed. */
async function serve(script) {
	const dir = mkdtempSync(join(tmpdir(), "webtessera-workerd-"));
	const port = await freePort();
	writeFileSync(join(dir, "worker.js"), script);
	writeFileSync(
		join(dir, "config.capnp"),
		`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .worker)],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-08-01",
);
`,
	);
	const child = spawn(workerd, ["serve", join(dir, "config.capnp")], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (b) => (output += b));
	child.stderr.on("data", (b) => (output += b));
	try {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (/Uncaught|error:/i.test(output)) {
				return { status: 0, text: output.trim() };
			}
			try {
				const response = await fetch(`http://127.0.0.1:${port}/`);
				return { status: response.status, text: response.status === 200 ? await response.text() : output.trim() };
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		return { status: 0, text: `no answer in 10 s\n${output.trim()}` };
	} finally {
		child.kill();
		rmSync(dir, { recursive: true, force: true });
	}
}

const entryPoints = Object.keys(pkg.exports)
	.filter((key) => key !== "./package.json")
	.map((key) => (key === "." ? "webtessera" : `webtessera/${key.slice(2)}`));

const failures = [];
for (const specifier of entryPoints) {
	const result = await build({
		stdin: {
			contents:
				`import * as m from ${JSON.stringify(specifier)};\n` +
				"export default { fetch() { return new Response(String(Object.keys(m).length)); } };\n",
			resolveDir: root,
			loader: "js",
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		logLevel: "silent",
	});
	const { status, text } = await serve(result.outputFiles[0].text);
	if (status === 200) {
		process.stdout.write(`ok ${specifier} (${text} exports)\n`);
	} else {
		failures.push(`${specifier}: ${text.split("\n").slice(0, 3).join(" | ")}`);
	}
}

if (failures.length > 0) {
	process.stderr.write(
		`\n${failures.length} entry point(s) fail to load at a Worker's global scope:\n${failures.join("\n")}\n`,
	);
	process.exit(1);
}
process.stdout.write(`smoke-workerd ok: ${entryPoints.length} entry points load at a Worker's global scope\n`);
