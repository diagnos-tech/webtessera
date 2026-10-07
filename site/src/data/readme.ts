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

// What the site reads from the README and the guides: the README's install command and its
// embedded code blocks, the package map of docs/guides/ported-api.md and the safe API's
// environment table in docs/guides/safe-api.md.
//
// The README's code blocks are tagged `file=<path> region=<name>`; each is the `// #region name`
// block of a source file that the test suite runs (src/README_test.ts), and
// src/README_sync_test.ts fails if README.md drifts from them. regions() and normalise() below
// are that test's extraction and normalisation, so a snippet on the site is byte for byte the
// tested code. A region that does not contain its own imports is shown with the import
// declarations of the same test file that it uses (snippetImports), so that every block on the
// site can be copied as it is.

import type { Repo } from "./repo.ts";
import { codeSpans, plain, requireTable } from "./tables.ts";

/** Snippet is a tested code region, as README.md embeds it. */
export interface Snippet {
	readonly file: string;
	readonly region: string;
	readonly code: string;
	/** imports are the test file's import declarations of the names the region uses ("" if none). */
	readonly imports: string;
	/** lines are the first and last line numbers of the region's code in its file. */
	readonly lines: readonly [number, number];
}

/** PackageRow is a row of the package table in docs/guides/ported-api.md. */
export interface PackageRow {
	readonly imports: readonly string[];
	/** go is the Go counterpart, or "" for an entry point with none. */
	readonly go: string;
	/** contents is the row's description, as inline Markdown. */
	readonly contents: string;
}

/** Region is a `// #region` block: its normalised code and where it sits in its file. */
interface Region {
	readonly code: string;
	readonly lines: readonly [number, number];
}

/** regions extracts every `// #region name` … `// #endregion` block from a source file. */
export function regions(source: string): Map<string, Region> {
	const out = new Map<string, Region>();
	const re = /^[ \t]*\/\/ #region (\S+)\n([\s\S]*?)^[ \t]*\/\/ #endregion$/gm;
	for (const m of source.matchAll(re)) {
		const first = source.slice(0, m.index).split("\n").length + 1;
		const body = (m[2] ?? "").replace(/\s+$/, "");
		out.set(m[1] ?? "", { code: normalise(body), lines: [first, first + body.split("\n").length - 1] });
	}
	return out;
}

/** normalise dedents a block and renders indentation as two spaces per tab. */
export function normalise(block: string): string {
	const lines = block.replace(/\s+$/, "").split("\n");
	const indent = Math.min(...lines.filter((l) => l.trim() !== "").map((l) => /^\t*/.exec(l)?.[0].length ?? 0));
	return lines.map((l) => l.slice(indent).replace(/^\t+/, (t) => "  ".repeat(t.length))).join("\n");
}

interface ImportDecl {
	readonly module: string;
	/** names are the imported bindings as written ("a", "type B", "c as d"), with their local names. */
	readonly names: readonly { readonly spec: string; readonly local: string }[];
}

/** importDecls reads a module's named import declarations, leaving out relative and test-only modules. */
function importDecls(source: string): ImportDecl[] {
	const out: ImportDecl[] = [];
	for (const m of source.matchAll(/^import\s+\{([^}]*)\}\s+from\s+"([^"]+)";/gm)) {
		const module = m[2] ?? "";
		if (module.startsWith(".") || module === "vitest") {
			continue;
		}
		const names = (m[1] ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s !== "")
			.map((spec) => ({
				spec,
				local:
					spec
						.replace(/^type\s+/, "")
						.split(/\s+as\s+/)
						.pop() ?? spec,
			}));
		out.push({ module, names });
	}
	return out;
}

/**
 * snippetImports returns the import declarations, from the test file `source`, of the names
 * `code` uses, in the file's order: the imports that make the region compile as it is.
 */
export function snippetImports(source: string, code: string): string {
	if (/^import\s/m.test(code)) {
		return "";
	}
	const used = (name: string) => new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}\\b`).test(code);
	return importDecls(source)
		.map((d) => ({ module: d.module, names: d.names.filter((n) => used(n.local)).map((n) => n.spec) }))
		.filter((d) => d.names.length > 0)
		.map((d) => `import { ${d.names.join(", ")} } from "${d.module}";`)
		.join("\n");
}

/**
 * loadSnippets returns README.md's embedded regions, keyed by region name. The code is read
 * from the source files, which are what the tests run, never from README.md's copy; a region
 * whose README copy differs is listed in `drift` (src/README_sync_test.ts fails on it too). A
 * region README.md names but no source has is an error.
 */
export function loadSnippets(repo: Repo): { snippets: Map<string, Snippet>; drift: string[] } {
	const readme = repo.text("README.md");
	const out = new Map<string, Snippet>();
	const drift: string[] = [];
	for (const m of readme.matchAll(/^```ts file=(\S+) region=(\S+)\n([\s\S]*?)^```$/gm)) {
		const [, file = "", region = "", body = ""] = m;
		const source = repo.text(file);
		const found = regions(source).get(region);
		if (found === undefined) {
			throw new Error(`README.md embeds ${file}#${region}, which does not exist`);
		}
		if (found.code !== body.replace(/\s+$/, "")) {
			drift.push(`${file}#${region}`);
		}
		out.set(region, {
			file,
			region,
			code: found.code,
			imports: snippetImports(source, found.code),
			lines: found.lines,
		});
	}
	return { snippets: out, drift };
}

/** packageTable is where the package map lives. */
export const packageTable = { file: "docs/guides/ported-api.md", heading: "## Packages" } as const;

/** loadPackageTable reads the package map of docs/guides/ported-api.md. */
export function loadPackageTable(repo: Repo): PackageRow[] {
	const { file, heading } = packageTable;
	return requireTable(repo.text(file), file, heading)
		.filter(([imports = ""]) => imports.startsWith("`"))
		.map(([imports = "", go = "", contents = ""]) => ({
			imports: codeSpans(imports),
			go: go.startsWith("—") ? "" : go.replace(/`/g, ""),
			contents: contents.trim(),
		}));
}

/** describe finds the package-table row covering an import specifier, globs included. */
export function describe(rows: readonly PackageRow[], specifier: string): PackageRow | undefined {
	return (
		rows.find((r) => r.imports.includes(specifier)) ??
		rows.find((r) => r.imports.some((i) => i.endsWith("/*") && specifier.startsWith(i.slice(0, -1))))
	);
}

/** Install is README.md's install command, and its sentence on where webtessera runs. */
export interface Install {
	readonly command: string;
	readonly runs: string;
}

/** loadInstall reads the shell block under README.md's "## Install" heading, and the sentence after it. */
export function loadInstall(repo: Repo): Install {
	const readme = repo.text("README.md");
	const m = /^## Install\n[\s\S]*?^```sh\n([\s\S]*?)^```\n+([^\n#][\s\S]*?)(?:\n\n|(?![\s\S]))/m.exec(readme);
	if (m === null) {
		throw new Error('README.md has no shell block under "## Install", which the site reads');
	}
	const command = (m[1] ?? "")
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "" && !l.startsWith("#"));
	if (command === undefined) {
		throw new Error('README.md\'s shell block under "## Install" has no command');
	}
	return { command, runs: (m[2] ?? "").replace(/\s+/g, " ").trim() };
}

/** SafeRow is a row of the safe API's environment table: an entry point, where it runs and what key it holds. */
export interface SafeRow {
	readonly specifier: string;
	readonly runsIn: string;
	readonly holds: string;
}

/** safeTable is where the safe API's environment table lives. */
export const safeTable = { file: "docs/guides/safe-api.md", heading: "## The environment model" } as const;

/** loadSafeTable reads the environment table of docs/guides/safe-api.md. */
export function loadSafeTable(repo: Repo): SafeRow[] {
	const { file, heading } = safeTable;
	return requireTable(repo.text(file), file, heading).map(([imp = "", runsIn = "", holds = ""]) => ({
		specifier: codeSpans(imp)[0] ?? plain(imp),
		runsIn: plain(runsIn),
		holds: plain(holds),
	}));
}
