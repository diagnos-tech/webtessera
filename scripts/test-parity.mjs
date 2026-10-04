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

// `bun run test:parity`: proves that every upstream Go test has a TypeScript counterpart.
//
// PORTING.md §4 requires each ported test file to keep upstream's test names. This script
// checks that mechanically, for Tessera at the pinned commit and for the modules this
// repository vendors:
//
//   1. It lists every Go test, example, fuzz target and benchmark with `go test -list`
//      (Tessera inside .upstream/tessera, the vendored modules from fixtures/gen, whose
//      go.mod pins them), merged with a static scan of *_test.go, which also finds the tests
//      of a package that does not build here or whose TestMain exits before listing.
//   2. It runs the TypeScript suites with vitest's JSON reporter (or reads reports given
//      with --report) and collects every describe/it title, per test file.
//   3. A Go test counts as ported when a passing TypeScript test in the mapped directory has
//      a title (or an enclosing describe title) equal to its name, or starting with its name
//      followed by " ", "/", ":" or "(".
//   4. A Go test without a counterpart fails the run unless scripts/test-parity-allowlist.json
//      names it (or its whole package) with the ADR that decided not to port it. Every ADR
//      the allow-list cites, and every ADR the differential suites' divergence allow-list
//      (src/testonly/testing/differential.ts) cites, must exist under docs/decisions/.
//
// Usage:
//   node scripts/test-parity.mjs [--report vitest.json ...] [--verbose] [--json out.json]
//
// It needs Go on PATH and `bun run upstream` to have run (the first run downloads the Go
// modules upstream's test packages import). See docs/compatibility.md ("Test parity").

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamDir = join(root, ".upstream", "tessera");
const genDir = join(root, "fixtures", "gen");

const args = process.argv.slice(2);
const reports = [];
let verbose = false;
let jsonOut;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--report") {
		reports.push(args[++i]);
	} else if (args[i] === "--verbose") {
		verbose = true;
	} else if (args[i] === "--json") {
		jsonOut = args[++i];
	} else {
		fail(`unknown argument ${args[i]}`);
	}
}

function fail(msg) {
	process.stderr.write(`test-parity: ${msg}\n`);
	process.exit(2);
}

// Go package → TypeScript directory holding its ported tests (relative to the repo root).
// A package not listed here has no TypeScript counterpart directory at all; its tests must
// then be allow-listed as a whole.
const vendored = [
	["github.com/transparency-dev/merkle/compact", "src/vendor/merkle/compact"],
	["github.com/transparency-dev/merkle/proof", "src/vendor/merkle/proof"],
	["github.com/transparency-dev/merkle/rfc6962", "src/vendor/merkle/rfc6962"],
	["github.com/transparency-dev/merkle/testonly", "src/vendor/merkle/testonly"],
	["github.com/transparency-dev/merkle", "src/vendor/merkle"],
	["github.com/transparency-dev/formats/log", "src/vendor/formats/log"],
	["github.com/transparency-dev/formats/note", "src/vendor/formats/note"],
	["golang.org/x/mod/sumdb/note", "src/vendor/note"],
	["golang.org/x/crypto/cryptobyte", "src/internal/gostd"],
];
const tesseraModule = "github.com/transparency-dev/tessera";

// Tessera packages whose ported tests live somewhere other than the mirrored directory.
// storage/posix's files.go is ported as the ObjectStore engine (ADR-0100), and its tests
// with it.
const relocated = new Map([[`${tesseraModule}/storage/posix`, ["src/storage/posix", "src/storage/objectstore"]]]);

function tsDirsFor(pkg) {
	for (const [p, d] of vendored) {
		if (pkg === p) {
			return [d];
		}
	}
	if (relocated.has(pkg)) {
		return relocated.get(pkg);
	}
	if (pkg === tesseraModule) {
		return ["src"];
	}
	if (pkg.startsWith(`${tesseraModule}/`)) {
		return [`src/${pkg.slice(tesseraModule.length + 1)}`];
	}
	return [];
}

// --- 1. Go test names -------------------------------------------------------------------

/** goList runs `go test -list` in dir over pkgs and returns {pkg: [names]} for what built. */
function goList(dir, pkgs) {
	const r = spawnSync("go", ["test", "-list", ".*", ...pkgs], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 });
	const out = {};
	let pending = [];
	for (const line of (r.stdout ?? "").split("\n")) {
		const ok = /^ok\s+(\S+)/.exec(line);
		if (ok) {
			out[ok[1]] = pending;
			pending = [];
		} else if (/^(Test|Example|Fuzz|Benchmark)\w*$/.test(line.trim())) {
			pending.push(line.trim());
		} else if (/^\?\s+(\S+)\s+\[no test files\]/.test(line)) {
			pending = [];
		}
	}
	return out;
}

/** staticList scans a package directory's *_test.go files for test functions. */
function staticList(dir) {
	const names = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith("_test.go")) {
			continue;
		}
		const src = readFileSync(join(dir, f), "utf8");
		for (const m of src.matchAll(/^func ((?:Test|Example|Fuzz|Benchmark)\w*)\(/gm)) {
			if (m[1] !== "TestMain") {
				names.push(m[1]);
			}
		}
	}
	return names;
}

/** goPackagesWithTests walks dir for directories holding *_test.go, as import paths. */
function goPackagesWithTests(dir, modPath) {
	const pkgs = [];
	const walk = (d) => {
		const ents = readdirSync(d, { withFileTypes: true });
		if (ents.some((e) => e.isFile() && e.name.endsWith("_test.go"))) {
			const rel = relative(dir, d);
			pkgs.push({ pkg: rel === "" ? modPath : `${modPath}/${rel.split("\\").join("/")}`, dir: d });
		}
		for (const e of ents) {
			if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "testdata") {
				walk(join(d, e.name));
			}
		}
	};
	walk(dir);
	return pkgs;
}

if (!existsSync(upstreamDir)) {
	fail("missing .upstream/tessera: run `bun run upstream` first");
}

const goTests = new Map(); // pkg -> {names, source}
{
	// `go test -list` runs the test binary, so a package whose TestMain exits early (the
	// MySQL and integration suites do without their services) lists nothing; the static
	// scan is therefore always merged in.
	const merge = (pkg, listed, dir) => {
		const scanned = staticList(dir);
		const names = [...new Set([...(listed ?? []), ...scanned])];
		const source =
			listed === undefined
				? "static scan"
				: names.length > listed.length
					? "go test -list + static scan"
					: "go test -list";
		goTests.set(pkg, { names, source });
	};
	const listed = goList(upstreamDir, ["./..."]);
	for (const { pkg, dir } of goPackagesWithTests(upstreamDir, tesseraModule)) {
		merge(pkg, listed[pkg], dir);
	}
	const vpkgs = vendored.map(([p]) => p);
	const vlisted = goList(genDir, vpkgs);
	for (const p of vpkgs) {
		const d = execFileSync("go", ["list", "-f", "{{.Dir}}", p], { cwd: genDir, encoding: "utf8" }).trim();
		merge(p, vlisted[p], d);
	}
}

// --- 2. TypeScript test titles ----------------------------------------------------------

let reportFiles = reports;
let tmp;
if (reportFiles.length === 0) {
	tmp = mkdtempSync(join(tmpdir(), "test-parity-"));
	const out = join(tmp, "vitest.json");
	// Vitest's own entry point, run by this Node: the suites run on Node (ADR-0240), and this
	// works whichever package manager installed the dependencies.
	const r = spawnSync(
		process.execPath,
		[
			join(root, "node_modules", "vitest", "vitest.mjs"),
			"run",
			"--config",
			"vitest.config.ts",
			"--reporter=json",
			`--outputFile=${out}`,
		],
		{ cwd: root, stdio: ["ignore", "ignore", "inherit"] },
	);
	if (!existsSync(out)) {
		fail(`vitest produced no report (exit ${r.status})`);
	}
	reportFiles = [out];
}

const tsTitles = new Map(); // dir -> [{titles, status}]
for (const f of reportFiles) {
	const rep = JSON.parse(readFileSync(f, "utf8"));
	for (const file of rep.testResults ?? []) {
		const dir = relative(root, dirname(file.name)).split("\\").join("/");
		const list = tsTitles.get(dir) ?? [];
		for (const a of file.assertionResults ?? []) {
			list.push({ titles: [...(a.ancestorTitles ?? []), a.title], status: a.status, file: relative(root, file.name) });
		}
		tsTitles.set(dir, list);
	}
}
if (tmp !== undefined) {
	rmSync(tmp, { recursive: true, force: true });
}

// --- 3. Allow-list ----------------------------------------------------------------------

const allowPath = join(root, "scripts", "test-parity-allowlist.json");
const allow = JSON.parse(readFileSync(allowPath, "utf8"));
const decisions = readdirSync(join(root, "docs", "decisions"));
const adrExists = (n) => decisions.some((d) => d.startsWith(`${n}-`));
const problems = [];
for (const [key, entry] of Object.entries(allow.entries ?? {})) {
	for (const adr of entry.adrs ?? []) {
		if (!adrExists(adr)) {
			problems.push(`allow-list entry ${key} cites ADR-${adr}, which does not exist in docs/decisions`);
		}
	}
	if (!entry.adrs || entry.adrs.length === 0) {
		problems.push(`allow-list entry ${key} cites no ADR`);
	}
}
{
	const src = readFileSync(join(root, "src", "testonly", "testing", "differential.ts"), "utf8");
	const block = src.slice(
		src.indexOf("export const DIVERGENCES"),
		src.indexOf("satisfies Record<string, DivergenceRule>"),
	);
	for (const m of block.matchAll(/"([a-z0-9-]+)":\s*\{\s*adrs:\s*\[([^\]]*)\]/g)) {
		for (const a of m[2].matchAll(/"(\d{4})"/g)) {
			if (!adrExists(a[1])) {
				problems.push(`differential divergence ${m[1]} cites ADR-${a[1]}, which does not exist in docs/decisions`);
			}
		}
	}
}

// Allow-list keys are "<import path>.<test name>", where "*" matches any run of
// characters: "<pkg>.*" covers a whole package, "*.Benchmark*" every benchmark.
const allowPatterns = Object.entries(allow.entries ?? {}).map(([key, entry]) => ({
	key,
	entry,
	re: new RegExp(
		`^${key
			.split("*")
			.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	),
	used: false,
}));

function allowed(pkg, name) {
	const hit = allowPatterns.find((p) => p.re.test(`${pkg}.${name}`));
	if (hit !== undefined) {
		hit.used = true;
	}
	return hit?.entry;
}

// --- 4. Compare -------------------------------------------------------------------------

const rows = [];
let missing = 0;
let failing = 0;
for (const [pkg, { names, source }] of [...goTests].sort(([a], [b]) => a.localeCompare(b))) {
	const dirs = tsDirsFor(pkg);
	const dir = dirs.length === 0 ? undefined : dirs.join(", ");
	const cands = dirs.flatMap((d) => tsTitles.get(d) ?? []);
	const counts = { ported: 0, allowed: 0, missing: 0, failing: 0 };
	const details = [];
	for (const name of names) {
		const re = new RegExp(`^${name}(?:$|[ /:(])`);
		const hits = cands.filter((c) => c.titles.some((t) => re.test(t)));
		const passing = hits.filter((h) => h.status === "passed");
		const a = allowed(pkg, name);
		if (passing.length > 0 && hits.every((h) => h.status === "passed")) {
			counts.ported++;
			if (a !== undefined) {
				problems.push(`${pkg}.${name} is ported but still allow-listed; remove the stale entry`);
			}
		} else if (hits.length > 0) {
			counts.failing++;
			failing++;
			details.push(
				`  FAILING  ${name} (${hits
					.filter((h) => h.status !== "passed")
					.map((h) => h.file)
					.join(", ")})`,
			);
		} else if (a !== undefined) {
			counts.allowed++;
			details.push(`  allowed  ${name}  ADR-${a.adrs.join(", ADR-")}: ${a.reason}`);
		} else {
			counts.missing++;
			missing++;
			details.push(`  MISSING  ${name}  (expected in ${dir ?? "no mapped directory"})`);
		}
	}
	rows.push({ pkg, dir: dir ?? "-", source, total: names.length, ...counts, details });
}

for (const p of allowPatterns) {
	if (!p.used) {
		problems.push(`allow-list entry ${p.key} matches no missing Go test; remove the stale entry`);
	}
}

const widths = [56, 8, 8, 8, 8, 8];
const pad = (s, w) => String(s).padEnd(w);
const lines = [];
lines.push(
	[
		pad("Go package", widths[0]),
		pad("tests", widths[1]),
		pad("ported", widths[2]),
		pad("allowed", widths[3]),
		pad("missing", widths[4]),
		pad("failing", widths[5]),
		"TypeScript directory",
	].join(" "),
);
for (const r of rows) {
	lines.push(
		[
			pad(r.pkg.replace("github.com/transparency-dev/", ""), widths[0]),
			pad(r.total, widths[1]),
			pad(r.ported, widths[2]),
			pad(r.allowed, widths[3]),
			pad(r.missing, widths[4]),
			pad(r.failing, widths[5]),
			r.dir + (r.source === "go test -list" ? "" : `  (${r.source})`),
		].join(" "),
	);
	for (const d of r.details) {
		if (verbose || !d.startsWith("  allowed")) {
			lines.push(d);
		}
	}
}
const totals = rows.reduce(
	(t, r) => ({ total: t.total + r.total, ported: t.ported + r.ported, allowed: t.allowed + r.allowed }),
	{ total: 0, ported: 0, allowed: 0 },
);
lines.push("");
lines.push(
	`${totals.total} Go tests: ${totals.ported} ported, ${totals.allowed} allow-listed with an ADR, ${missing} missing, ${failing} failing`,
);
for (const p of problems) {
	lines.push(`PROBLEM  ${p}`);
}
process.stdout.write(`${lines.join("\n")}\n`);
if (jsonOut !== undefined) {
	writeFileSync(jsonOut, `${JSON.stringify({ rows, problems }, null, 2)}\n`);
}
process.exit(missing > 0 || failing > 0 || problems.length > 0 ? 1 : 0);
