#!/usr/bin/env node
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

// Derives the GitHub Packages variant of an npm tarball.
//
// Usage:
//
//     node scripts/release/rescope.mjs webtessera-0.1.0.tgz --scope diagnos-tech [--out-dir dir]
//
// GitHub Packages' npm registry only accepts packages whose scope is the owner of the
// repository (@diagnos-tech/webtessera), while npm publishes the unscoped `webtessera`. So
// the same build ships under two names, and this script makes the second tarball from the
// first instead of building twice: it unpacks the tarball, changes "name" in package.json
// and nothing else, and packs it again. The result is written to <out-dir> (default: next to
// the input) as <scope>-webtessera-<version>.tgz, the file name npm gives scoped packages,
// and its path is the last line printed.
//
// Before it finishes it unpacks both tarballs and checks that they hold the same files with
// the same bytes, and that the two package.json files differ in "name" only. A derivation
// that quietly changed anything else would otherwise publish something nobody tested.
//
// Zero dependencies; needs Node >= 20, and tar and npm on PATH.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const fail = (message) => {
	process.stderr.write(`rescope: ${message}\n`);
	process.exit(1);
};

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const [, value] = args.splice(i, 2);
	return value;
};
const scopeArg = flag("--scope");
const outDirArg = flag("--out-dir");
const [input, ...extra] = args;
if (!input || extra.length > 0 || !scopeArg) {
	fail("usage: node scripts/release/rescope.mjs <tarball.tgz> --scope <owner> [--out-dir <dir>]");
}

// npm scopes are lowercase, and GitHub treats owner names case-insensitively.
const scope = scopeArg.toLowerCase();
if (!/^[a-z0-9][a-z0-9-]*$/.test(scope)) {
	fail(`"${scopeArg}" is not usable as an npm scope`);
}

const tarball = resolve(input);
const outDir = resolve(outDirArg ?? dirname(tarball));
mkdirSync(outDir, { recursive: true });

/** extract unpacks a tarball into a fresh directory and returns the path of its `package/` root. */
function extract(file, parent, label) {
	const dir = join(parent, label);
	mkdirSync(dir);
	execFileSync("tar", ["-xzf", file, "-C", dir], { stdio: "inherit" });
	return join(dir, "package");
}

/** walk lists every file below dir as sorted relative paths. */
function walk(dir, base = dir) {
	const out = [];
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full, base));
		} else {
			out.push(relative(base, full).split("\\").join("/"));
		}
	}
	return out;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const work = mkdtempSync(join(tmpdir(), "webtessera-rescope-"));
try {
	const original = extract(tarball, work, "original");
	const manifest = JSON.parse(readFileSync(join(original, "package.json"), "utf8"));
	if (typeof manifest.name !== "string" || manifest.name.startsWith("@")) {
		fail(`expected an unscoped package name, got ${JSON.stringify(manifest.name)}`);
	}
	const scopedName = `@${scope}/${manifest.name}`;

	// Edit a copy of the unpacked tree; the original stays untouched for the comparison below.
	const copy = extract(tarball, work, "scoped");
	writeFileSync(join(copy, "package.json"), `${JSON.stringify({ ...manifest, name: scopedName }, null, 2)}\n`);

	// --ignore-scripts: the package's own `prepack` would delete dist/ and rebuild it, which
	// cannot work in a directory that holds no sources.
	const packed = JSON.parse(
		execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir, copy], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}),
	);
	const output = join(outDir, packed[0].filename);

	const rebuilt = extract(output, work, "check");
	const before = walk(original);
	const after = walk(rebuilt);
	if (JSON.stringify(before) !== JSON.stringify(after)) {
		const missing = before.filter((f) => !after.includes(f));
		const added = after.filter((f) => !before.includes(f));
		fail(`file lists differ; missing: [${missing.join(", ")}], added: [${added.join(", ")}]`);
	}
	for (const f of before.filter((f) => f !== "package.json")) {
		if (sha256(join(original, f)) !== sha256(join(rebuilt, f))) {
			fail(`${f} differs between the two tarballs`);
		}
	}
	const rebuiltManifest = JSON.parse(readFileSync(join(rebuilt, "package.json"), "utf8"));
	const { name: _before, ...restBefore } = manifest;
	const { name: nameAfter, ...restAfter } = rebuiltManifest;
	if (nameAfter !== scopedName || JSON.stringify(restBefore) !== JSON.stringify(restAfter)) {
		fail("package.json differs in more than its name");
	}

	process.stderr.write(`rescope: ${manifest.name} -> ${scopedName}; ${before.length} files identical\n`);
	process.stdout.write(`${output}\n`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
