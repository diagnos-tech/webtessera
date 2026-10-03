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

// README.md embeds code verbatim from the files that exercise it: every fenced block
// tagged `file=<path> region=<name>` must equal the `// #region <name>` block of that
// file. This is the presubmit check upstream's README_test.go leaves as a TODO; the
// snippets themselves run in README_test.ts. Indentation is compared as two spaces per
// tab, which is how README.md renders it. See
// docs/decisions/0140-testonly-and-readme-test-on-the-memory-driver.md.

import { describe, expect, it } from "vitest";

/**
 * ImportMetaWithGlob types the part of Vite's import.meta this file uses. Vite replaces
 * `import.meta.glob(...)` calls at transform time, so each call must spell it out in full.
 */
interface ImportMetaWithGlob extends ImportMeta {
	glob<T>(pattern: string | string[], options: { query: string; import: string; eager: true }): Record<string, T>;
}

// The files a README block may embed, keyed by their path from the repository root.
const embeddable: Record<string, string> = Object.fromEntries(
	Object.entries(
		(import.meta as ImportMetaWithGlob).glob<string>(["./README_test.ts"], {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	).map(([path, text]) => [path.replace(/^\.\.\//, "").replace(/^\.\//, "src/"), text]),
);

const readme =
	(import.meta as ImportMetaWithGlob).glob<string>("../README.md", { query: "?raw", import: "default", eager: true })[
		"../README.md"
	] ?? "";

/** regions extracts every `// #region name` … `// #endregion` block from a source file. */
function regions(source: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = /^[ \t]*\/\/ #region (\S+)\n([\s\S]*?)^[ \t]*\/\/ #endregion$/gm;
	for (const m of source.matchAll(re)) {
		out.set(m[1] ?? "", normalise(m[2] ?? ""));
	}
	return out;
}

/** normalise dedents a block and renders indentation as two spaces per tab. */
function normalise(block: string): string {
	const lines = block.replace(/\s+$/, "").split("\n");
	const indent = Math.min(...lines.filter((l) => l.trim() !== "").map((l) => /^\t*/.exec(l)?.[0].length ?? 0));
	return lines.map((l) => l.slice(indent).replace(/^\t+/, (t) => "  ".repeat(t.length))).join("\n");
}

const blocks = [...readme.matchAll(/^```ts file=(\S+) region=(\S+)\n([\s\S]*?)^```$/gm)].map((m) => ({
	file: m[1] ?? "",
	region: m[2] ?? "",
	body: (m[3] ?? "").replace(/\s+$/, ""),
}));

describe("README.md is up to date", () => {
	it("embeds at least the upstream regions", () => {
		const embedded = new Set(blocks.map((b) => b.region));
		for (const name of ["common_imports", "construct_example", "use_appender_example"]) {
			expect(embedded.has(name), name).toBe(true);
		}
	});

	it.each(blocks.map((b) => [`${b.file}#${b.region}`, b] as const))("%s matches its source", (_, b) => {
		const source = embeddable[b.file];
		expect(source, `README.md embeds ${b.file}, which this test does not load`).toBeDefined();
		const want = regions(source ?? "").get(b.region);
		expect(want, `${b.file} has no region ${b.region}`).toBeDefined();
		expect(b.body).toBe(want);
	});
});
