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

// Smoke-tests the packed npm tarball the way a consumer would meet it.
//
// Usage:
//
//     pnpm pack --pack-destination /tmp/pack
//     node scripts/smoke-pack.mjs /tmp/pack/webtessera-<version>.tgz
//
// It installs the tarball into a throwaway project, then checks that:
//
//   - the licence files that must accompany the code are in the package (LICENSE,
//     NOTICE and LICENSES/, whose BSD-3-Clause text redistribution requires);
//   - no test files were published;
//   - the shipped JavaScript imports no Node built-in (AGENTS.md §7: this code runs
//     in browsers and on the edge);
//   - every entry in package.json's `exports` resolves to a file that exists and
//     can be imported by a real Node process.
//
// All problems are collected and reported together. Zero dependencies; needs
// Node >= 20 and npm on PATH.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const print = (message) => process.stdout.write(`${message}\n`);
const printErr = (message) => process.stderr.write(`${message}\n`);

const tarball = process.argv[2] ? resolve(process.argv[2]) : "";
if (!tarball || !existsSync(tarball)) {
	printErr("usage: node scripts/smoke-pack.mjs <path-to-tarball.tgz>");
	process.exit(2);
}

const problems = [];
const fail = (message) => problems.push(message);

/** walk lists every file below dir, as paths relative to base. */
function walk(dir, base = dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full, base));
		} else {
			out.push(relative(base, full).split("\\").join("/"));
		}
	}
	return out;
}

const tmp = mkdtempSync(join(tmpdir(), "webtessera-smoke-"));
try {
	writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "webtessera-smoke", private: true, type: "module" }));

	print(`installing ${tarball}`);
	execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", tarball], {
		cwd: tmp,
		stdio: "inherit",
		shell: process.platform === "win32",
	});

	const pkgDir = join(tmp, "node_modules", "webtessera");
	const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	const files = walk(pkgDir);
	print(`${pkg.name}@${pkg.version}: ${files.length} files`);

	for (const required of ["LICENSE", "NOTICE", "README.md"]) {
		if (!files.includes(required)) {
			fail(`package is missing ${required}`);
		}
	}
	if (!files.some((f) => f.startsWith("LICENSES/"))) {
		fail(
			'package is missing LICENSES/ (add "LICENSES" to package.json "files"): the BSD-3-Clause text must accompany the code derived from Go sources',
		);
	}

	for (const f of files) {
		if (/(^|\/)[^/]*_(browser_)?test\.[^/]*$/.test(f) || f.split("/").includes("testing")) {
			fail(`test-only file was published: ${f}`);
		}
	}

	const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, "").split("/")[0]));
	const importRe = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']((?:node:)?[A-Za-z_][\w/.-]*)["']/g;
	for (const f of files.filter((f) => f.endsWith(".js"))) {
		const src = readFileSync(join(pkgDir, f), "utf8");
		for (const m of src.matchAll(importRe)) {
			const spec = m[1];
			if (spec.startsWith("node:") || builtins.has(spec.split("/")[0])) {
				fail(`${f} imports the Node built-in "${spec}"`);
			}
		}
	}

	const specifiers = [];
	for (const [key, target] of Object.entries(pkg.exports ?? {})) {
		if (key === "./package.json") continue;
		const path = typeof target === "string" ? target : (target.import ?? target.default);
		if (typeof path !== "string" || !files.includes(path.replace(/^\.\//, ""))) {
			fail(`exports["${key}"] points at ${JSON.stringify(path)}, which is not in the package`);
			continue;
		}
		const types = path.replace(/\.js$/, ".d.ts");
		if (!files.includes(types.replace(/^\.\//, ""))) {
			fail(`exports["${key}"] has no declaration file ${types}`);
		}
		specifiers.push(key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`);
	}

	writeFileSync(
		join(tmp, "smoke.mjs"),
		`const failed = [];
for (const spec of ${JSON.stringify(specifiers)}) {
	try {
		const ns = await import(spec);
		process.stdout.write("  ok  " + spec + " (" + Object.keys(ns).length + " runtime exports)\\n");
	} catch (err) {
		failed.push(spec);
		process.stderr.write("  FAIL " + spec + ": " + (err && err.message ? err.message : err) + "\\n");
	}
}
process.exit(failed.length === 0 ? 0 : 1);
`,
	);
	try {
		execFileSync(process.execPath, ["smoke.mjs"], { cwd: tmp, stdio: "inherit" });
	} catch {
		fail("one or more entry points failed to import (see above)");
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

if (problems.length > 0) {
	printErr(`\nsmoke-pack: ${problems.length} problem(s):`);
	for (const p of problems) printErr(`  - ${p}`);
	process.exit(1);
}
print("\nsmoke-pack: ok");
