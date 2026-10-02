// Copyright 2025 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/storage/storage_test.go @ 4a6d9f9
//
// Port note: Go walks the storage directory with filepath.WalkDir and greps every non-test
// .go file for the substring "layout.EntriesPath". The project has no Node built-ins and no
// @types/node, so the walk is done at transform time by Vite's `import.meta.glob`, which hands
// the test the raw text of every file under this directory. The substring grep becomes a walk
// of each file's syntax tree: Go can grep because every use is qualified by the package name
// (`layout.EntriesPath`), whereas TypeScript also allows `import { entriesPath }`, which no
// substring identifies, and a grep would trip over comments that merely explain the rule. See
// docs/decisions/0132-storage-forbidden-function-test.md.

import ts from "typescript";
import { describe, expect, it } from "vitest";

/** GlobOptions is the subset of Vite's `import.meta.glob` options this file uses. */
interface GlobOptions {
	readonly query: string;
	readonly import: string;
	readonly eager: true;
}

/**
 * ImportMetaWithGlob types the one Vite extension this file needs. The project compiles with
 * `types: []` and does not depend on `vite/client`, whose ambient `ImportMeta` augmentation
 * would otherwise declare it.
 */
interface ImportMetaWithGlob {
	glob(pattern: string, options: GlobOptions): Record<string, string>;
}

// storageSources maps each .ts file under src/storage/, keyed by its path relative to this
// directory (e.g. "./internal/queue.ts"), to its source text.
const storageSources = (import.meta as unknown as ImportMetaWithGlob).glob("./**/*.ts", {
	query: "?raw",
	import: "default",
	eager: true,
});

/**
 * forbiddenNames are the api/layout functions storage implementations must not call.
 *
 * Go forbids the substring "layout.EntriesPath", which also matches
 * "layout.EntriesPathForLogIndex"; that is deliberate here too, since entriesPathForLogIndex is
 * a thin wrapper that hard-wires the same tlog-tiles path and would bypass
 * AppendOptions.entriesPath() just the same.
 */
const forbiddenNames: ReadonlySet<string> = new Set(["entriesPath", "entriesPathForLogIndex"]);

/** layoutModule matches the specifier of any import of the api/layout module or one of its files. */
const layoutModule = /(?:^|\/)api\/layout(?:\/|$)/;

/**
 * forbiddenEntriesPathUses reports every way source reaches a function in forbiddenNames:
 *
 *   - a named import or re-export of it from the api/layout module, under any local alias;
 *   - a member access on a namespace import of that module (`import * as l ...; l.entriesPath`);
 *   - the literal `layout.entriesPath`, which is what upstream greps for.
 *
 * Importing it from any other module, or merely having a property or comment of that name (as
 * AppendOptions.entriesPath() and the `internal.entriesPath` field do), is not a use.
 *
 * Dynamic `import()` of the module, and re-exports of it through a third module, are not
 * followed. Upstream's grep has the same blind spots.
 */
function forbiddenEntriesPathUses(source: string): string[] {
	const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
	const found: string[] = [];
	// `layout` is checked even when it was not imported by name, as upstream's grep does.
	const namespaceAliases = new Set<string>(["layout"]);

	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
			continue;
		}
		const specifier = statement.moduleSpecifier;
		if (specifier === undefined || !ts.isStringLiteral(specifier) || !layoutModule.test(specifier.text)) {
			continue;
		}

		const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause;
		if (bindings === undefined) {
			continue;
		}
		if (ts.isNamespaceImport(bindings)) {
			namespaceAliases.add(bindings.name.text);
		} else if (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) {
			for (const element of bindings.elements) {
				// `propertyName` is the original name when the element is renamed with `as`.
				const name = (element.propertyName ?? element.name).text;
				if (forbiddenNames.has(name)) {
					found.push(
						`${name} ${ts.isImportDeclaration(statement) ? "imported" : "re-exported"} from ${specifier.text}`,
					);
				}
			}
		}
	}

	const visit = (node: ts.Node): void => {
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			namespaceAliases.has(node.expression.text) &&
			forbiddenNames.has(node.name.text)
		) {
			found.push(`${node.expression.text}.${node.name.text}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/**
 * isImplementation reports whether a path under src/storage/ is storage implementation code.
 *
 * Go skips only `_test.go` files. The TypeScript equivalents are `_test.ts` files and the
 * `testing/` directories that hold test-only harnesses; tsconfig.build.json excludes both from
 * the published package, so neither can ship a driver that bypasses AppendOptions.entriesPath().
 */
function isImplementation(path: string): boolean {
	return !path.endsWith("_test.ts") && !path.split("/").includes("testing");
}

// The layout.entriesPath function should never be called by storage implementations.
// They should use `AppendOptions.entriesPath()` instead.
it("TestForbiddenFunction", () => {
	const implementations = Object.entries(storageSources).filter(([path]) => isImplementation(path));

	// A glob that silently matched nothing would pass vacuously. Mirroring storage/internal in
	// Go, src/storage/internal/integrate.ts must always be among the files walked.
	expect(implementations.map(([path]) => path)).toContain("./internal/integrate.ts");

	const found = implementations.flatMap(([path, source]) =>
		forbiddenEntriesPathUses(source).map((use) => `${use} in file ${path}`),
	);
	expect(found, "storage implementations must use AppendOptions.entriesPath(), not api/layout").toEqual([]);
});

// The tests below have no upstream counterpart. Go's check is one strings.Contains; this one
// has to understand imports, so it needs its own proof that it fails on violations and stays
// quiet on the look-alikes that are legitimate.
describe("forbiddenEntriesPathUses (port additions)", () => {
	const violations: { name: string; source: string; want: string[] }[] = [
		{
			name: "named import",
			source: `import { entriesPath } from "../api/layout/index.ts";`,
			want: ["entriesPath imported from ../api/layout/index.ts"],
		},
		{
			name: "named import from the paths file, with other names and a type modifier",
			source: `import { type TilePath, entriesPath, tilePath } from "../../api/layout/paths.ts";`,
			want: ["entriesPath imported from ../../api/layout/paths.ts"],
		},
		{
			name: "named import under an alias",
			source: `import { entriesPath as bundlePath } from "../api/layout/index.ts";`,
			want: ["entriesPath imported from ../api/layout/index.ts"],
		},
		{
			name: "multi-line named import",
			source: `import {\n\tEntryBundleWidth,\n\tentriesPath,\n\ttilePath,\n} from "../api/layout/index.ts";`,
			want: ["entriesPath imported from ../api/layout/index.ts"],
		},
		{
			name: "named import of the log-index wrapper",
			source: `import { entriesPathForLogIndex } from "../api/layout/index.ts";`,
			want: ["entriesPathForLogIndex imported from ../api/layout/index.ts"],
		},
		{
			name: "package self-reference",
			source: `import { entriesPath } from "webtessera/api/layout";`,
			want: ["entriesPath imported from webtessera/api/layout"],
		},
		{
			name: "re-export",
			source: `export { entriesPath } from "../api/layout/index.ts";`,
			want: ["entriesPath re-exported from ../api/layout/index.ts"],
		},
		{
			name: "layout.entriesPath call through a namespace import",
			source: `import * as layout from "../api/layout/index.ts";\nconst p = layout.entriesPath(0n, 0);`,
			want: ["layout.entriesPath"],
		},
		{
			name: "call through a namespace import with another alias",
			source: `import * as paths from "../api/layout/index.ts";\nconst p = paths.entriesPath(0n, 0);`,
			want: ["paths.entriesPath"],
		},
		{
			name: "log-index wrapper through a namespace import",
			source: `import * as layout from "../api/layout/index.ts";\nconst p = layout.entriesPathForLogIndex(1n, 2n);`,
			want: ["layout.entriesPathForLogIndex"],
		},
		{
			name: "the literal layout.entriesPath call, however layout was obtained",
			source: `const p = layout.entriesPath(0n, 0);`,
			want: ["layout.entriesPath"],
		},
		{
			name: "spaced member access",
			source: `import * as layout from "../api/layout/index.ts";\nconst p = layout\n\t.entriesPath(0n, 0);`,
			want: ["layout.entriesPath"],
		},
	];

	for (const test of violations) {
		it(`flags: ${test.name}`, () => {
			expect(forbiddenEntriesPathUses(test.source)).toEqual(test.want);
		});
	}

	const allowed: { name: string; source: string }[] = [
		{
			name: "the AppendOptions accessor",
			source: `const p = opts.entriesPath()(0n, 0);`,
		},
		{
			name: "a field of that name",
			source: `const o = { entriesPath: ctEntriesPath };\no.internal.entriesPath = ctEntriesPath;`,
		},
		{
			name: "other layout functions",
			source: `import { tilePath, nWithSuffix } from "../api/layout/index.ts";\nimport * as layout from "../api/layout/index.ts";\nlayout.tilePath(0n, 0n, 0);`,
		},
		{
			name: "an identically named import from an unrelated module",
			source: `import { entriesPath } from "./elsewhere.ts";`,
		},
		{
			name: "a longer identifier that merely contains the name",
			source: `import { ctEntriesPath } from "../ct_only.ts";\nctEntriesPath(0n, 0);`,
		},
		{
			name: "a namespace member access on an unrelated module",
			source: `import * as other from "./elsewhere.ts";\nother.entriesPath(0n, 0);`,
		},
		{
			name: "a line comment that mentions the call",
			source: `// Never call layout.entriesPath(...) here; use opts.entriesPath().`,
		},
		{
			name: "a block comment that mentions the import",
			source: `/*\n * import { entriesPath } from "../api/layout/index.ts";\n * layout.entriesPath(0n, 0)\n */`,
		},
		{
			name: "a string that mentions the call",
			source: `const msg = "do not call layout.entriesPath";`,
		},
	];

	for (const test of allowed) {
		it(`allows: ${test.name}`, () => {
			expect(forbiddenEntriesPathUses(test.source)).toEqual([]);
		});
	}

	it("still sees a violation that follows a string containing a comment marker", () => {
		const source = `const url = "https://example.com/a";\nimport * as layout from "../api/layout/index.ts";\nlayout.entriesPath(0n, 0);`;
		expect(forbiddenEntriesPathUses(source)).toEqual(["layout.entriesPath"]);
	});

	it("sees a violation appended to a real storage source file", () => {
		// This is the whole pipeline short of the file system: raw text as the glob delivers it, with
		// a violation added, so the walk above cannot be passing for lack of reading the files.
		const real = storageSources["./internal/integrate.ts"];
		expect(real).toBeDefined();
		expect(forbiddenEntriesPathUses(real ?? "")).toEqual([]);
		const violating = `${real}\nimport { entriesPath } from "../../api/layout/index.ts";\n`;
		expect(forbiddenEntriesPathUses(violating)).toEqual(["entriesPath imported from ../../api/layout/index.ts"]);
	});

	it("still sees a violation that follows a comment", () => {
		const source = `/* a comment */\nimport { entriesPath } from "../api/layout/index.ts"; // trailing`;
		expect(forbiddenEntriesPathUses(source)).toEqual(["entriesPath imported from ../api/layout/index.ts"]);
	});
});

describe("isImplementation (port additions)", () => {
	it("excludes test files and test-only harness directories", () => {
		expect(isImplementation("./internal/queue.ts")).toBe(true);
		expect(isImplementation("./objectstore/objectstore.ts")).toBe(true);
		expect(isImplementation("./internal/queue_test.ts")).toBe(false);
		expect(isImplementation("./indexeddb/smoke_browser_test.ts")).toBe(false);
		expect(isImplementation("./objectstore/testing/harness.ts")).toBe(false);
	});
});
