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

// What the test suites and CI actually run: the vitest configurations, the matrices and
// commands of .github/workflows/*.yml, and the jobs ci.yml runs on every change. The site
// claims a runtime or a check only if one of these says so. (Which backend runs the golden
// suite in which runtime is evidence.ts's business.)

import type { Repo } from "./repo.ts";

/** TestMatrix is where the test suites run. */
export interface TestMatrix {
	/** nodeVersions are the Node.js majors the unit tests run on in CI. */
	readonly nodeVersions: readonly string[];
	/** runtimes are the runtimes the built package is smoke-tested on (node, bun, deno, …). */
	readonly runtimes: readonly string[];
	readonly chromium: boolean;
	readonly workerd: boolean;
	/** services is true when suites run against real external services in CI. */
	readonly services: boolean;
	/** interop is true when CI checks that Go and TypeScript read each other's logs. */
	readonly interop: boolean;
	/** fixturesReproduced is true when CI regenerates the fixtures from upstream and diffs them. */
	readonly fixturesReproduced: boolean;
	/** parity is true when CI checks that every upstream Go test has a port or an allow-list entry. */
	readonly parity: boolean;
	/** examples is true when CI runs every example's own `ci` script. */
	readonly examples: boolean;
	/** jobs are the checks ci.yml runs on every change, grouped by the workflow that defines them. */
	readonly jobs: readonly JobGroup[];
	/** gate names ci.yml's own job that fails when any other does, if it has one. */
	readonly gate: string | undefined;
	/** releaseGated is true when release.yml runs ci.yml before it publishes. */
	readonly releaseGated: boolean;
}

/** JobGroup is one workflow that ci.yml calls, with the names of the jobs it runs, matrix expanded. */
export interface JobGroup {
	readonly name: string;
	readonly file: string;
	readonly jobs: readonly string[];
}

/** matrix collects the values of a matrix key, written as `key: [a, b]` or as `- key: a` entries. */
function matrix(yaml: string, key: string): string[] {
	const out = new Set<string>();
	for (const m of yaml.matchAll(new RegExp(`^\\s+${key}:\\s*\\[([^\\]]*)\\]`, "gm"))) {
		for (const v of (m[1] ?? "").split(",")) {
			out.add(v.trim().replace(/^["']|["']$/g, ""));
		}
	}
	for (const m of yaml.matchAll(new RegExp(`^\\s+-\\s+${key}:\\s*["']?([\\w.-]+)`, "gm"))) {
		out.add(m[1] ?? "");
	}
	out.delete("");
	return [...out];
}

/** RUN_SCRIPT matches a workflow step that runs a root package.json script, whichever package manager starts it. */
const RUN_SCRIPT = (name: string): RegExp => new RegExp(`\\b(?:bun|npm|pnpm|yarn) (?:run )?${name}\\b`);

/** jobBlocks splits a workflow's `jobs:` mapping into one block of YAML per job. */
function jobBlocks(yaml: string): string[] {
	const jobs = yaml.slice(Math.max(0, yaml.search(/^jobs:\s*$/m)));
	return jobs.split(/^ {2}(?=[\w-]+:\s*$)/m).slice(1);
}

/** jobNames returns the display names of a workflow's jobs, one per matrix entry. */
function jobNames(yaml: string): string[] {
	return jobBlocks(yaml).flatMap((block) => {
		const name = /^ {4}name:\s*(.+?)\s*$/m.exec(block)?.[1]?.replace(/^["']|["']$/g, "");
		if (name === undefined) {
			return [];
		}
		const key = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/.exec(name)?.[1];
		const values = key === undefined ? [] : matrix(block, key);
		return values.length === 0 ? [name] : values.map((v) => name.replace(/\$\{\{[^}]*\}\}/, v));
	});
}

/**
 * loadJobs reads the jobs ci.yml runs: each job that calls a reusable workflow is expanded
 * into that workflow's jobs; the aggregate "passed" gate, which runs no check of its own, is
 * left out.
 */
function loadJobs(repo: Repo): JobGroup[] {
	const ci = repo.textOr(".github/workflows/ci.yml") ?? "";
	const out: JobGroup[] = [];
	for (const block of jobBlocks(ci)) {
		const name = /^ {4}name:\s*(.+?)\s*$/m.exec(block)?.[1] ?? "";
		const uses = /^ {4}uses:\s*\.\/(\.github\/workflows\/[\w.-]+\.ya?ml)\s*$/m.exec(block)?.[1];
		if (uses === undefined) {
			continue;
		}
		const jobs = jobNames(repo.textOr(uses) ?? "");
		if (jobs.length > 0) {
			out.push({ name, file: uses, jobs });
		}
	}
	return out;
}

/** loadTestMatrix reads the vitest configurations and the CI workflows. */
export function loadTestMatrix(repo: Repo): TestMatrix {
	const workflows = repo.list(".github/workflows", "file").filter((f) => /\.ya?ml$/.test(f));
	const yaml = workflows.map((f) => repo.text(`.github/workflows/${f}`)).join("\n");
	const scripts = repo.json<{ scripts?: Record<string, string> }>("package.json").scripts ?? {};
	return {
		nodeVersions: matrix(yaml, "node").sort((a, b) => Number(a) - Number(b)),
		runtimes: matrix(yaml, "runtime"),
		chromium: repo.exists("vitest.browser.config.ts") && /test:browser/.test(yaml),
		workerd: repo.exists("vitest.workers.config.ts") && /test:workers/.test(yaml),
		services: repo.exists("vitest.services.config.ts") && /test:services/.test(yaml),
		interop: scripts.interop !== undefined && RUN_SCRIPT("interop").test(yaml),
		fixturesReproduced: RUN_SCRIPT("fixtures").test(yaml),
		parity: scripts["test:parity"] !== undefined && RUN_SCRIPT("test:parity").test(yaml),
		examples: /--filter\s+['"]?\.\/examples\/\*['"]?\s+ci\b/.test(yaml),
		jobs: loadJobs(repo),
		gate: jobBlocks(repo.textOr(".github/workflows/ci.yml") ?? "")
			.filter((b) => !/^ {4}uses:/m.test(b) && /^ {4}needs:/m.test(b))
			.map((b) => /^ {4}name:\s*(.+?)\s*$/m.exec(b)?.[1])
			.find((n) => n !== undefined),
		releaseGated: /^\s+uses:\s*\.\/\.github\/workflows\/ci\.ya?ml\s*$/m.test(
			repo.textOr(".github/workflows/release.yml") ?? "",
		),
	};
}
