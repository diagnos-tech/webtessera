#!/usr/bin/env node
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

// Checks out the upstream Tessera source at the commit webtessera is pinned to.
//
// The Go source in `.upstream/tessera` is the specification this repository
// ports (AGENTS.md §1) and the code the golden-fixture generator runs against
// (fixtures/gen). The repository URL and the pinned commit live in exactly one
// place, scripts/upstream.json; change them there and nowhere else.
//
// Usage:
//
//     node scripts/fetch-upstream.mjs            # clone or move the checkout to the pin
//     node scripts/fetch-upstream.mjs --force    # also discard local changes in the checkout
//
// The script is idempotent. When the checkout is already at the pin and clean it
// runs one `git rev-parse` and one `git status` and exits. It never overwrites
// local modifications unless --force is given: fixtures are only evidence if they
// were generated from pristine upstream source, so a modified checkout is an error
// rather than something to work around silently.
//
// Zero dependencies; needs Node >= 20 and git on PATH.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(join(repoRoot, "scripts", "upstream.json"), "utf8"));

for (const key of ["repository", "commit", "directory"]) {
	if (typeof pin[key] !== "string" || pin[key] === "") {
		fail(`scripts/upstream.json: "${key}" must be a non-empty string`);
	}
}
if (!/^[0-9a-f]{40}$/.test(pin.commit)) {
	fail(`scripts/upstream.json: "commit" must be a full 40-character lowercase SHA-1, got "${pin.commit}"`);
}

const dir = resolve(repoRoot, pin.directory);
const shown = relative(repoRoot, dir) || ".";
const short = pin.commit.slice(0, 7);
const force = process.argv.includes("--force");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	print("usage: node scripts/fetch-upstream.mjs [--force]");
	process.exit(0);
}

// Never let git block on a credentials prompt. (A global core.autocrlf cannot
// rewrite upstream's bytes either: the fresh checkout below pins it to false,
// and the fixtures embed some of those bytes.)
const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** git runs git in the checkout (or in cwd) and returns trimmed stdout. */
function git(args, { cwd = dir, inherit = false } = {}) {
	try {
		const out = execFileSync("git", args, {
			cwd,
			env,
			encoding: "utf8",
			stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
		});
		return (out ?? "").trim();
	} catch (err) {
		if (err.code === "ENOENT") {
			fail("git was not found on PATH; install git and retry");
		}
		const stderr = err.stderr ? String(err.stderr).trim() : "";
		throw new Error(`git ${args.join(" ")} failed${stderr ? `:\n${stderr}` : ""}`);
	}
}

function fail(message) {
	process.stderr.write(`fetch-upstream: ${message}\n`);
	process.exit(1);
}

function print(message) {
	process.stdout.write(`${message}\n`);
}

function head() {
	try {
		return git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	} catch {
		return "";
	}
}

function hasCommit(sha) {
	try {
		git(["cat-file", "-e", `${sha}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

function dirty() {
	return git(["status", "--porcelain", "--untracked-files=all"]) !== "";
}

/** fetchAndCheckout makes the pinned commit the detached HEAD, fetching it if needed. */
function fetchAndCheckout() {
	if (!hasCommit(pin.commit)) {
		print(`fetch-upstream: fetching ${short} from ${pin.repository}`);
		// Depth 1 keeps the clone small. GitHub serves any reachable commit by SHA.
		git(["fetch", "--quiet", "--depth", "1", "origin", pin.commit], { inherit: true });
	}
	git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", pin.commit]);
}

function verify() {
	const got = head();
	if (got !== pin.commit) {
		throw new Error(`checkout ended at ${got || "no commit"}, expected ${pin.commit}`);
	}
}

function main() {
	if (!existsSync(dir) || readdirSync(dir).length === 0) {
		mkdirSync(dir, { recursive: true });
		try {
			git(["init", "--quiet"]);
			git(["config", "core.autocrlf", "false"]);
			git(["config", "core.eol", "lf"]);
			git(["remote", "add", "origin", pin.repository]);
			fetchAndCheckout();
			verify();
		} catch (err) {
			// Do not leave a half-initialised checkout behind for the next run to trip over.
			rmSync(dir, { recursive: true, force: true });
			throw err;
		}
		print(`fetch-upstream: ${shown} is at ${short}`);
		return;
	}

	if (!existsSync(join(dir, ".git"))) {
		fail(`${shown} exists but is not a git checkout; move it away or delete it, then retry`);
	}
	const origin = git(["remote", "get-url", "origin"]);
	if (origin.replace(/\.git$/, "") !== pin.repository) {
		fail(`${shown} has origin ${origin}, expected ${pin.repository}; delete it and retry`);
	}

	const atPin = head() === pin.commit;
	if (dirty()) {
		if (!force) {
			fail(
				`${shown} has local changes, so it is not pristine upstream source.\n` +
					`  Inspect them with: git -C ${shown} status\n` +
					`  Discard them with: node scripts/fetch-upstream.mjs --force`,
			);
		}
		print(`fetch-upstream: discarding local changes in ${shown}`);
		git(["reset", "--quiet", "--hard"]);
		git(["clean", "--quiet", "-fd"]);
	}

	if (atPin) {
		print(`fetch-upstream: ${shown} is already at ${short}`);
		return;
	}

	print(`fetch-upstream: moving ${shown} from ${head().slice(0, 7) || "(no commit)"} to ${short}`);
	fetchAndCheckout();
	verify();
	print(`fetch-upstream: ${shown} is at ${short}`);
}

try {
	main();
} catch (err) {
	fail(err.message);
}
