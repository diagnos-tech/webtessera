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

// Building and running the Go half of the harness: interop/produce (Tessera's POSIX driver
// writing a log) and interop/verify (Tessera's client and fsck judging one).

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * GoTools builds interop/produce and interop/verify into binDir and runs them. Every run uses
 * workDir as its working directory, never a log directory: see files.mjs's symlinkError for why
 * that matters to posix's writeTile.
 */
export class GoTools {
	#bin;
	#workDir;

	constructor(interopDir, binDir, workDir) {
		this.#bin = binDir;
		this.#workDir = workDir;
		// The module's own tests pin the entry corpus that entries.mjs must reproduce.
		run("go", ["test", "./..."], interopDir, "testing the Go interop module");
		run("go", ["build", "-o", `${binDir}/`, "./produce", "./verify"], interopDir, "building the Go interop tools");
	}

	/** produce appends the batches ending at `ends` to the log in dir, which holds `from` entries. */
	produce({ dir, skey, seed, from, ends, history }) {
		const args = ["-dir", dir, "-skey", skey, "-seed", `${seed}`, "-from", `${from}`, "-ends", ends.join(",")];
		return run(join(this.#bin, "produce"), [...args, "-history", history], this.#workDir, "interop/produce");
	}

	/** verify checks the log in dir with Tessera's own client and fsck, and returns its report. */
	verify({ dir, vkey, size, seed, history }) {
		const args = ["-dir", dir, "-vkey", vkey, "-size", `${size}`, "-seed", `${seed}`, "-history", history.join(",")];
		return run(join(this.#bin, "verify"), args, this.#workDir, "interop/verify");
	}
}

/**
 * run runs a command to completion and returns its stdout lines. On failure it throws with
 * everything the command printed: klog's lines on stderr are noise on success and evidence on
 * failure.
 */
function run(cmd, args, cwd, what) {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
	if (r.error !== undefined) {
		throw new Error(`${what}: ${r.error.code === "ENOENT" ? `${cmd} not found on PATH` : r.error.message}`);
	}
	if (r.status !== 0) {
		throw new Error(`${what} exited with ${r.status}:\n${r.stdout}${r.stderr}`.trimEnd());
	}
	return r.stdout.trim().split("\n");
}
