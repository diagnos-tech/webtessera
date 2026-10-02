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

// `pnpm interop`: proves, against Tessera's own Go code at the pinned commit, that every storage
// backend that runs in Node writes logs Tessera accepts and reproduces, and carries on logs
// Tessera wrote. docs/compatibility.md explains how this fits with the golden fixtures and the
// per-backend golden suite; docs/decisions/0162-bidirectional-go-interop-harness.md records the
// design.
//
// For each backend (scripts/interop/backends.mjs), two scenarios run over one seeded batch plan
// (scripts/interop/plan.mjs) and one seeded entry corpus (interop/internal/entries):
//
//   ts -> go  webtessera appends phase 1 into the backend; the store is exported to a directory
//             that Go's interop/verify checks (signature, fsck, every entry, inclusion and
//             consistency proofs), that must be byte-identical to the log Go's POSIX driver
//             writes for the same plan, and that Go's POSIX driver then carries on through
//             phase 2, after which it is verified and compared again.
//   go -> ts  Go's POSIX driver writes phase 1; its directory, .state/ included, is loaded into
//             the backend; webtessera's own client and fsck verify it; webtessera carries it on
//             through phase 2; and the exported result must pass interop/verify (including
//             consistency from Go's checkpoints to webtessera's) and be byte-identical to the
//             log Go writes for the whole plan.
//
// Usage:
//
//     node scripts/interop.mjs [--seed N] [--size1 N] [--size2 N] [--backend NAME]... [--keep] [--no-build]
//
// The script brings its own prerequisites up to date, idempotently: the upstream checkout
// (scripts/fetch-upstream.mjs) and the package build (dist/, skipped with --no-build). It needs
// Go 1.24 or later on PATH and network access to the Go module proxy the first time.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The interop log's key pair: a published test key, generated once with Go's note.GenerateKey,
 * that protects nothing. Both writers sign with it, so equal trees give equal checkpoints.
 */
const skey = "PRIVATE+KEY+webtessera.interop.log+a01a0444+Af9eVT6/zRe0s2PB71xq38KP3O2VORLCU1mfPIFyISfV";
const vkey = "webtessera.interop.log+a01a0444+AeW2ErYcjY19LHfyIWIs6tiSy7JKhfYiTiqFlN4QnwuX";

const { values: opts } = parseArgs({
	options: {
		seed: { type: "string", default: "1" },
		// 65000 leaves partial resources at levels 0 and 1; 70000 crosses 65536, where the first
		// level-2 tile appears, which no golden fixture reaches.
		size1: { type: "string", default: "65000" },
		size2: { type: "string", default: "70000" },
		backend: { type: "string", multiple: true },
		keep: { type: "boolean", default: false },
		"no-build": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (opts.help) {
	process.stdout.write(
		"usage: node scripts/interop.mjs [--seed N] [--size1 N] [--size2 N] [--backend NAME]... [--keep] [--no-build]\n",
	);
	process.exit(0);
}

const seed = BigInt(opts.seed);
const size1 = BigInt(opts.size1);
const size2 = BigInt(opts.size2);

/** prerequisite runs one setup command with its output shown, and exits if it fails. */
function prerequisite(what, cmd, args) {
	process.stdout.write(`interop: ${what}\n`);
	const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
	if (r.status !== 0) {
		process.stderr.write(`interop: ${what} failed${r.error ? `: ${r.error.message}` : ""}\n`);
		process.exit(1);
	}
}

prerequisite("checking out upstream Tessera at the pin", process.execPath, [
	join(repoRoot, "scripts/fetch-upstream.mjs"),
]);
if (!opts["no-build"]) {
	const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
	prerequisite("building dist/", process.execPath, [tsc, "-p", "tsconfig.build.json"]);
}
prerequisite("checking for Go", "go", ["version"]);

// Imported only now: these import the package by name, which resolves to the dist/ just built.
const { backends } = await import("./interop/backends.mjs");
const { checkCorpus } = await import("./interop/entries.mjs");
const { compareHistories, compareLogDirs, exportStore, loadDir, recordKeys } = await import("./interop/files.mjs");
const { GoTools } = await import("./interop/go.mjs");
const { makePlan } = await import("./interop/plan.mjs");
const { Report } = await import("./interop/report.mjs");
const { appendBatches, verifyStore } = await import("./interop/tslog.mjs");

const selected = opts.backend === undefined ? backends : backends.filter((b) => opts.backend.includes(b.name));
if (selected.length === 0) {
	process.stderr.write(
		`interop: no backend matches ${opts.backend}; known: ${backends.map((b) => b.name).join(", ")}\n`,
	);
	process.exit(1);
}

checkCorpus();
const work = mkdtempSync(join(tmpdir(), "webtessera-interop-"));
const report = new Report();
const go = new GoTools(join(repoRoot, "interop"), join(work, "bin"), work);
const plan = makePlan(seed, size1, size2);
const allEnds = [...plan.phase1, ...plan.phase2];
const at = (name) => join(work, name);

report.line(
	`interop: seed ${seed}, sizes ${size1} then ${size2}, ${plan.phase1.length} + ${plan.phase2.length} batches`,
);
report.line(`interop: working in ${work}`);

/** batches describes a list of batch ends for the report. */
function batches(ends) {
	return ends.length === 1 ? "1 batch" : `${ends.length} batches`;
}

/** verified runs interop/verify and condenses its report to the lines worth reading. */
function verified(dir, size, history) {
	return go
		.verify({ dir, vkey, size, seed, history })
		.filter((l) => !l.endsWith(": OK"))
		.map((l) => l.replace(/^verify: /, "Go: "));
}

/** identical compares a log webtessera wrote, and its checkpoints, with Go's, failing on any difference. */
function identical(dir, goDir, history, goHistory) {
	const diffs = compareLogDirs(dir, goDir);
	const h = compareHistories(history, goHistory);
	const all = [...diffs, ...h.diffs];
	if (all.length > 0) {
		throw new Error(`${all.length} differences from Go's log:\n${all.slice(0, 20).join("\n")}`);
	}
	return `every file and all ${h.compared} signed checkpoints are byte-identical`;
}

report.line();
report.line("reference: Tessera's POSIX driver, in Go");
await report.scenario("reference", "go", async (step) => {
	await step(`Go wrote [0, ${size1}) in ${batches(plan.phase1)}`, () => {
		go.produce({ dir: at("go1"), skey, seed, from: 0n, ends: plan.phase1, history: at("go1.history") });
		return verified(at("go1"), size1, [at("go1.history")]);
	});
	await step(`Go wrote [0, ${size2}) in ${batches(allEnds)}`, () => {
		go.produce({ dir: at("go2"), skey, seed, from: 0n, ends: allEnds, history: at("go2.history") });
		return verified(at("go2"), size2, [at("go2.history")]);
	});
});

for (const [n, backend] of selected.entries()) {
	report.line();
	report.line(backend.name);
	const dir = (name) => at(`b${n}-${name}`);

	await report.scenario(backend.name, "ts -> go", async (step) => {
		const { store, close } = await backend.open();
		try {
			const rec = recordKeys(store);
			await step(`webtessera appended [0, ${size1}) in ${batches(plan.phase1)}`, async () => {
				await appendBatches(rec.store, { skey, vkey, seed, from: 0n, ends: plan.phase1, history: dir("ts1.history") });
				return `exported ${await exportStore(rec, dir("ts1"))} files`;
			});
			await step("Go verified webtessera's log", () => verified(dir("ts1"), size1, [dir("ts1.history")]));
			await step("webtessera's log is Go's log", () =>
				identical(dir("ts1"), at("go1"), dir("ts1.history"), at("go2.history")),
			);
			await step(`Go carried webtessera's log on to ${size2} in ${batches(plan.phase2)}`, () => {
				cpSync(dir("ts1"), dir("ts1go"), { recursive: true });
				go.produce({ dir: dir("ts1go"), skey, seed, from: size1, ends: plan.phase2, history: dir("ts1go.history") });
				return verified(dir("ts1go"), size2, [dir("ts1.history"), dir("ts1go.history")]);
			});
			await step("the result is Go's log", () =>
				identical(dir("ts1go"), at("go2"), dir("ts1go.history"), at("go2.history")),
			);
		} finally {
			await close();
		}
	});

	await report.scenario(backend.name, "go -> ts", async (step) => {
		const { store, close } = await backend.open();
		try {
			const rec = recordKeys(store);
			await step(`webtessera loaded and verified Go's log of ${size1}`, async () => [
				`loaded ${await loadDir(at("go1"), rec.store)} files, .state/ included`,
				`webtessera: ${await verifyStore(rec.store, { vkey, seed, size: size1, historyDir: at("go1.history") })}`,
			]);
			await step(`webtessera carried Go's log on to ${size2} in ${batches(plan.phase2)}`, async () => {
				await appendBatches(rec.store, {
					skey,
					vkey,
					seed,
					from: size1,
					ends: plan.phase2,
					history: dir("ts2.history"),
				});
				return `exported ${await exportStore(rec, dir("ts2"))} files`;
			});
			await step("Go verified it, consistent from Go's checkpoints to webtessera's", () =>
				verified(dir("ts2"), size2, [at("go1.history"), dir("ts2.history")]),
			);
			await step("the result is Go's log", () =>
				identical(dir("ts2"), at("go2"), dir("ts2.history"), at("go2.history")),
			);
		} finally {
			await close();
		}
	});
}

const ok = report.summary();
if (ok && !opts.keep) {
	rmSync(work, { recursive: true, force: true });
} else {
	report.line(`interop: logs kept in ${work}`);
}
process.exit(ok ? 0 : 1);
