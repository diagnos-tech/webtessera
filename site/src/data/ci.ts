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

// What the test suites and CI actually run: the vitest configurations, the matrices and
// commands of .github/workflows/*.yml, and the golden (byte-for-byte) test files per
// runtime. The site claims a runtime or a check only if one of these says so.

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
	/** golden counts the byte-for-byte golden test files per runtime (node, chromium, workerd). */
	readonly golden: Readonly<Record<string, number>>;
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

/** runtimeOf classifies a test file by the suffix that routes it to a vitest configuration. */
function runtimeOf(file: string): string {
	if (file.endsWith("_browser_test.ts")) return "chromium";
	if (file.endsWith("_workers_test.ts")) return "workerd";
	if (file.endsWith("_services_test.ts")) return "services";
	return "node";
}

/** loadTestMatrix reads the vitest configurations, the CI workflows and the golden tests. */
export function loadTestMatrix(repo: Repo): TestMatrix {
	const workflows = repo.list(".github/workflows", "file").filter((f) => /\.ya?ml$/.test(f));
	const yaml = workflows.map((f) => repo.text(`.github/workflows/${f}`)).join("\n");
	const scripts = repo.json<{ scripts?: Record<string, string> }>("package.json").scripts ?? {};
	const golden: Record<string, number> = {};
	for (const f of repo.walk("src", /_golden\w*_test\.ts$/)) {
		const r = runtimeOf(f);
		golden[r] = (golden[r] ?? 0) + 1;
	}
	return {
		nodeVersions: matrix(yaml, "node").sort((a, b) => Number(a) - Number(b)),
		runtimes: matrix(yaml, "runtime"),
		chromium: repo.exists("vitest.browser.config.ts") && /test:browser/.test(yaml),
		workerd: repo.exists("vitest.workers.config.ts") && /test:workers/.test(yaml),
		services: repo.exists("vitest.services.config.ts") && /test:services/.test(yaml),
		interop: scripts.interop !== undefined && /pnpm (run )?interop\b/.test(yaml),
		fixturesReproduced: /pnpm (run )?fixtures\b/.test(yaml),
		golden,
	};
}
