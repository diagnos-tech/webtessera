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

// The `prepare` script: what a checkout needs after `bun install`, beyond the packages.
//
//     node scripts/prepare.mjs
//
// It does two independent things. Neither can fail the install: every problem is reported on
// stderr and the script exits 0, because a checkout without them is still a working checkout.
//
// 1. Link the library into the workspace.
//
//    The examples and the landing page import the library by its package name, so
//    `webtessera` must resolve from their directories. The library is the repository root, and
//    Bun cannot link a workspace root into its own members: `"webtessera": "workspace:*"`
//    fails with "Workspace dependency not found", and `file:../..` trips over a path
//    normalisation bug when the target is the root itself (oven-sh/bun, open as of 1.3). So
//    this makes the link by hand: `node_modules/webtessera` -> the repository root, which
//    Node-style resolution finds from every workspace package by walking up. It is the link
//    pnpm made for `workspace:*`, one level higher, and it follows `exports` into dist/, so
//    the examples see exactly what a consumer of the package sees (`bun run build` first).
//    docs/decisions/0240-bun-as-package-manager-and-script-runner.md has the details.
//
// 2. Point git at the pre-commit hook in .githooks/.
//
//    `core.hooksPath` is set to `.githooks` only at the top level of a git working tree, only
//    when nobody has configured it already (a hook manager or a personal setup is never
//    overridden), and never in CI, where nothing is committed. A checkout without git and a
//    tarball therefore do nothing. Installs from the registry never get here at all: npm and
//    Bun run `prepare` for the root project, for git dependencies and for `pack` and
//    `publish`, not for registry packages.
//
// Zero dependencies; needs Node >= 20 and, for the hook, git on PATH.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const warn = (message) => process.stderr.write(`prepare: ${message}\n`);

/** git returns what a git command prints in the repository root, or undefined if it fails (or git is missing). */
function git(...args) {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function linkLibrary() {
	const modules = join(repoRoot, "node_modules");
	if (!existsSync(modules)) return; // Nothing was installed, so there is nothing to link into.
	const link = join(modules, "webtessera");

	let existing;
	try {
		existing = lstatSync(link);
	} catch {
		// No such entry: create it below.
	}
	if (existing !== undefined) {
		// Linked by an earlier install, or somebody else's: say so rather than delete anything.
		if (!existing.isSymbolicLink()) {
			warn(`${link} is not a symlink, so the examples will not resolve "webtessera" to this checkout`);
		} else if (resolve(modules, readlinkSync(link)) !== repoRoot) {
			warn(`${link} links elsewhere, so the examples will not resolve "webtessera" to this checkout`);
		}
		return;
	}
	// A relative target keeps the checkout relocatable. "junction" only matters on Windows,
	// where it needs no privilege.
	symlinkSync("..", link, "junction");
}

function enableGitHooks() {
	if (process.env.CI || !existsSync(join(repoRoot, ".githooks"))) return;

	// The top level of a working tree, and this one: not a repository that merely contains this directory.
	const top = git("rev-parse", "--show-toplevel");
	if (top === undefined || realpathSync(top) !== realpathSync(repoRoot)) return;

	// `git config --get` prints nothing and fails when the key is unset anywhere (system, global or local).
	if ((git("config", "--get", "core.hooksPath") ?? "") !== "") return;

	if (git("config", "core.hooksPath", ".githooks") === undefined) {
		warn("could not set core.hooksPath; run `git config core.hooksPath .githooks` to enable the pre-commit hook");
		return;
	}
	process.stdout.write("prepare: git hooks enabled (core.hooksPath = .githooks)\n");
}

for (const step of [linkLibrary, enableGitHooks]) {
	try {
		step();
	} catch (err) {
		warn(`${step.name} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
