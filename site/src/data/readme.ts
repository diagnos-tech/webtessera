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

// README.md: its embedded code blocks and its tables.
//
// The code blocks are tagged `file=<path> region=<name>`; each is the `// #region name`
// block of a source file that the test suite runs (src/README_test.ts), and
// src/README_sync_test.ts fails if README.md drifts from them. regions() and normalise()
// below are that test's extraction and normalisation, so a snippet on the site is
// byte-for-byte the tested code. A region that does not contain its own imports is shown
// with the import declarations of the same test file that it uses (snippetImports), so
// that every block on the page can be copied as it is.

import type { Repo } from "./repo.ts";
import { codeSpans, markdownTable, plain } from "./tables.ts";

/** Snippet is a tested code region, as README.md embeds it. */
export interface Snippet {
	readonly file: string;
	readonly region: string;
	readonly code: string;
	/** imports are the test file's import declarations of the names the region uses ("" if none). */
	readonly imports: string;
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
		const source = repo.text(file);
		const code = regions(source).get(region);
		if (code === undefined) {
			throw new Error(`README.md embeds ${file}#${region}, which does not exist`);
		}
		if (code !== body.replace(/\s+$/, "")) {
			drift.push(`${file}#${region}`);
		}
		out.set(region, { file, region, code, imports: snippetImports(source, code) });
	}
	return { snippets: out, drift };
}

/** loadPackageTable reads the table under README.md's "## Packages" heading. */
export function loadPackageTable(repo: Repo): PackageRow[] {
	return markdownTable(repo.text("README.md"), "## Packages")
		.filter(([imports = ""]) => imports.startsWith("`"))
		.map(([imports = "", go = "", contents = ""]) => ({
			imports: codeSpans(imports),
			go: go.replace(/`/g, ""),
			contents,
		}));
}

/** describe finds the package-table row covering an import specifier, globs included. */
export function describe(rows: readonly PackageRow[], specifier: string): PackageRow | undefined {
	return (
		rows.find((r) => r.imports.includes(specifier)) ??
		rows.find((r) => r.imports.some((i) => i.endsWith("/*") && specifier.startsWith(i.slice(0, -1))))
	);
}

/** PackageManager is one way to install the package, named by its tool. */
export interface PackageManager {
	readonly name: string;
	readonly command: string;
}

/** Install is README.md's install command and the alternatives it lists, one per package manager. */
export interface Install {
	readonly command: string;
	readonly managers: readonly PackageManager[];
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
	const managers = [command, ...alternatives].map((c) => ({ name: c.split(/\s+/)[0] ?? c, command: c }));
	return { command, managers };
}

/** SafeRow is a row of README.md's safe API table: an entry point, where it runs and what key it holds. */
export interface SafeRow {
	readonly specifier: string;
	readonly runsIn: string;
	readonly holds: string;
}

/** loadSafeTable reads the table under README.md's "## The safe API" heading. */
export function loadSafeTable(repo: Repo): SafeRow[] {
	return markdownTable(repo.text("README.md"), "## The safe API").map(([imp = "", runsIn = "", holds = ""]) => ({
		specifier: codeSpans(imp)[0] ?? plain(imp),
		runsIn: plain(runsIn),
		holds: plain(holds),
	}));
}

/** StorageRow is a row of README.md's storage driver table. */
export interface StorageRow {
	readonly name: string;
	readonly specifier: string;
	readonly runsIn: string;
	readonly persistence: string;
}

/** loadStorageTable reads the table under README.md's "## Storage drivers" heading. */
export function loadStorageTable(repo: Repo): StorageRow[] {
	return markdownTable(repo.text("README.md"), "## Storage drivers").map(
		([name = "", imp = "", runsIn = "", persistence = ""]) => ({
			name: plain(name),
			specifier: codeSpans(imp)[0] ?? "",
			runsIn: plain(runsIn).replace(/\s*\(see below\)/, ""),
			persistence: plain(persistence),
		}),
	);
}

/** EngineRow is a row of README.md's SQLite engine table: the adapter call and its default locking. */
export interface EngineRow {
	readonly engine: string;
	/** adapter is the adapter function's name, e.g. fromSqliteSync. */
	readonly adapter: string;
	readonly locking: string;
}

/** loadEngineTable reads the table under README.md's "### On any SQLite" heading. */
export function loadEngineTable(repo: Repo): EngineRow[] {
	return markdownTable(repo.text("README.md"), "### On any SQLite").map(
		([engine = "", adapter = "", locking = ""]) => ({
			engine: plain(engine),
			adapter: /`(\w+)\(/.exec(adapter)?.[1] ?? "",
			locking: plain(locking),
		}),
	);
}

/** loadExampleOrder returns the example directories in the order README.md's "## Examples" table lists them. */
export function loadExampleOrder(repo: Repo): string[] {
	return markdownTable(repo.text("README.md"), "## Examples")
		.map(([first = ""]) => /\(examples\/([\w.-]+)\)/.exec(first)?.[1] ?? "")
		.filter((d) => d !== "");
}
