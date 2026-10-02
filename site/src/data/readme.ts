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

// README.md: its embedded code blocks and its package table.
//
// The code blocks are tagged `file=<path> region=<name>`; each is the `// #region name`
// block of a source file that the test suite runs (src/README_test.ts), and
// src/README_sync_test.ts fails if README.md drifts from them. regions() and normalise()
// below are that test's extraction and normalisation, so a snippet on the site is
// byte-for-byte the tested code.

import type { Repo } from "./repo.ts";

/** Snippet is a tested code region, as README.md embeds it. */
export interface Snippet {
	readonly file: string;
	readonly region: string;
	readonly code: string;
}

/** PackageRow is a row of README.md's package table. */
export interface PackageRow {
	readonly imports: readonly string[];
	readonly go: string;
	readonly contents: string;
}

/** regions extracts every `// #region name` … `// #endregion` block from a source file. */
export function regions(source: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = /^[ \t]*\/\/ #region (\S+)\n([\s\S]*?)^[ \t]*\/\/ #endregion$/gm;
	for (const m of source.matchAll(re)) {
		out.set(m[1] ?? "", normalise(m[2] ?? ""));
	}
	return out;
}

/** normalise dedents a block and renders indentation as two spaces per tab. */
export function normalise(block: string): string {
	const lines = block.replace(/\s+$/, "").split("\n");
	const indent = Math.min(...lines.filter((l) => l.trim() !== "").map((l) => /^\t*/.exec(l)?.[0].length ?? 0));
	return lines.map((l) => l.slice(indent).replace(/^\t+/, (t) => "  ".repeat(t.length))).join("\n");
}

/**
 * loadSnippets returns README.md's embedded regions, keyed by region name. The code is
 * read from the source files, which are what the tests run, never from README.md's copy;
 * a region whose README copy differs is listed in `drift` (src/README_sync_test.ts fails
 * on it too). A region README.md names but no source has is an error.
 */
export function loadSnippets(repo: Repo): { snippets: Map<string, Snippet>; drift: string[] } {
	const readme = repo.text("README.md");
	const out = new Map<string, Snippet>();
	const drift: string[] = [];
	for (const m of readme.matchAll(/^```ts file=(\S+) region=(\S+)\n([\s\S]*?)^```$/gm)) {
		const [, file = "", region = "", body = ""] = m;
		const code = regions(repo.text(file)).get(region);
		if (code === undefined) {
			throw new Error(`README.md embeds ${file}#${region}, which does not exist`);
		}
		if (code !== body.replace(/\s+$/, "")) {
			drift.push(`${file}#${region}`);
		}
		out.set(region, { file, region, code });
	}
	return { snippets: out, drift };
}

/** cells splits a Markdown table row into its trimmed cells. */
function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) => c.trim());
}

/** loadPackageTable reads the table under README.md's "## Packages" heading. */
export function loadPackageTable(repo: Repo): PackageRow[] {
	const readme = repo.text("README.md");
	const section = /^## Packages\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1] ?? "";
	return section
		.split("\n")
		.filter((l) => l.startsWith("| `"))
		.map((l) => {
			const [imports = "", go = "", contents = ""] = cells(l);
			return {
				imports: [...imports.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""),
				go: go.replace(/`/g, ""),
				contents,
			};
		});
}

/** describe finds the package-table row covering an import specifier, globs included. */
export function describe(rows: readonly PackageRow[], specifier: string): PackageRow | undefined {
	return (
		rows.find((r) => r.imports.includes(specifier)) ??
		rows.find((r) => r.imports.some((i) => i.endsWith("/*") && specifier.startsWith(i.slice(0, -1))))
	);
}

/** Install is README.md's install command and the alternatives it lists. */
export interface Install {
	readonly command: string;
	readonly alternatives: readonly string[];
}

/** loadInstall reads the shell block under README.md's "## Install" heading. */
export function loadInstall(repo: Repo): Install {
	const readme = repo.text("README.md");
	const block = /^## Install\n[\s\S]*?^```sh\n([\s\S]*?)^```$/m.exec(readme)?.[1] ?? "";
	const lines = block.split("\n").map((l) => l.trim());
	const command = lines.find((l) => l !== "" && !l.startsWith("#")) ?? "npm install webtessera";
	const alternatives = lines
		.filter((l) => l.startsWith("#"))
		.flatMap((l) => l.replace(/^#\s*(or:)?\s*/, "").split(/\s+\/\s+/))
		.map((s) => s.trim())
		.filter((s) => s !== "");
	return { command, alternatives };
}
