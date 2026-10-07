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

// The public entry points, as the TypeScript compiler sees them: for every subpath of
// the exports map, the names it exports (resolved through the barrels), what kind of
// declaration each is, and the first sentence of its doc comment. The package
// comment of the entry file (or of the first module it re-exports that has one)
// describes the entry point itself.

import ts from "typescript";
import type { ExportTarget } from "./package.ts";
import { describe, type PackageRow } from "./readme.ts";
import type { Repo } from "./repo.ts";

/** ExportedName is one name an entry point exports. */
export interface ExportedName {
	readonly name: string;
	readonly kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "namespace";
	readonly summary: string;
}

/** EntryPoint is a public entry point of the package. */
export interface EntryPoint {
	readonly specifier: string;
	readonly source: string;
	/** summary describes the entry point in a sentence, as inline Markdown (`code` spans). */
	readonly summary: string;
	/** go names the Go package it corresponds to, if any. */
	readonly go: string;
	readonly names: readonly ExportedName[];
}

/** firstSentence returns the first sentence of a paragraph of prose. */
export function firstSentence(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const m = /^(.+?[.!?])(?=\s+[A-Z(`]|$)/.exec(flat);
	return (m?.[1] ?? flat).trim();
}

/** cleanDoc turns doc-comment Markdown into plain prose: links lose their targets, tags go. */
function cleanDoc(text: string): string {
	return text
		.split("\n")
		.filter((l) => !/^\s*\[[^\]]+\]:\s*\S+/.test(l))
		.join("\n")
		.replace(/\{@link\s+([^}\s|]+)(?:[\s|][^}]*)?\}/g, "`$1`")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\s*\(https?:\/\/[^)\s]+\)/g, "")
		.replace(/\[([^\]]+)\]/g, "$1")
		.replace(/https:\/\/c2sp\.org\/([\w-]+)/g, "C2SP $1")
		.replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s.,;:)]|$)/g, "$1$2")
		.trim();
}

/**
 * goPackageOf returns the Go package a module was ported from, from the "Ported from
 * <path>" header of the module or of the first module it re-exports that has one, or
 * "" for modules with no upstream counterpart. A glob in the README's table (merkle/*)
 * is resolved this way rather than guessed.
 */
function goPackageOf(repo: Repo, file: string, glob: string): string {
	const source = repo.text(file);
	for (const f of [file, ...reexportedFiles(repo, file, source)]) {
		const from = /^\/\/ Ported from (\S+)\.go\b/m.exec(repo.text(f))?.[1];
		if (from !== undefined) {
			const dir = from.slice(0, from.lastIndexOf("/"));
			// Upstream paths are relative to their module; the README's glob names the module.
			return dir.startsWith("tessera") || !glob.endsWith("/*") ? dir : `${glob.slice(0, -2)}/${dir.split("/").pop()}`;
		}
	}
	return "";
}

/** leadIn matches how a package comment starts: "Package x", "Module x" or the import specifier itself. */
const leadIn = /^(?:(?:Package|Module) [\w/-]+|webtessera(?:\/[\w/-]+)?) /;

/** packageComment finds a module's package comment, with its lead-in ("Package x …") removed. */
function packageComment(source: string): string | undefined {
	for (const m of source.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
		const body = (m[1] ?? "").replace(/^\s*\* ?/gm, "").trim();
		if (body.includes("@module") || leadIn.test(body)) {
			return cleanDoc((body.split(/\n\s*\n/)[0] ?? "").replace(leadIn, ""));
		}
	}
	// Line comments: paragraphs end at a blank comment line or at a line of code.
	const paragraphs: string[] = [];
	let current: string[] = [];
	for (const line of source.split("\n")) {
		const text = line.startsWith("//") ? line.replace(/^\/\/ ?/, "") : undefined;
		if (text === undefined || text.trim() === "") {
			paragraphs.push(current.join("\n"));
			current = [];
		} else {
			current.push(text);
		}
	}
	const p = paragraphs.find((x) => leadIn.test(x.trim()));
	return p === undefined ? undefined : cleanDoc(p.trim().replace(leadIn, ""));
}

/** capitalise uppercases the first letter of a sentence. */
function capitalise(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * reexportedFiles lists the relative modules a barrel re-exports from: those in its own
 * directory first (they are the package), then the rest, each group in source order.
 */
function reexportedFiles(repo: Repo, file: string, source: string): string[] {
	const dir = file.slice(0, file.lastIndexOf("/"));
	const specs = [...source.matchAll(/export\s+(?:type\s+)?\{[^}]*\}\s+from\s+"(\.[^"]+)"/g)].map((m) => m[1] ?? "");
	const own = specs.filter((s) => s.startsWith("./"));
	const other = specs.filter((s) => !s.startsWith("./"));
	return [...own, ...other].map((s) => normalisePath(`${dir}/${s}`)).filter((f) => repo.exists(f));
}

/** normalisePath resolves "." and ".." segments of a repository-relative path. */
function normalisePath(path: string): string {
	const out: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "..") {
			out.pop();
		} else if (seg !== ".") {
			out.push(seg);
		}
	}
	return out.join("/");
}

function moduleSummary(repo: Repo, file: string): string {
	const source = repo.text(file);
	const doc = packageComment(source);
	if (doc !== undefined) {
		return capitalise(firstSentence(doc));
	}
	for (const f of reexportedFiles(repo, file, source)) {
		const d = packageComment(repo.text(f));
		if (d !== undefined) {
			return capitalise(firstSentence(d));
		}
	}
	return "";
}

function kindOf(symbol: ts.Symbol): ExportedName["kind"] {
	const f = symbol.flags;
	if (f & ts.SymbolFlags.Class) return "class";
	if (f & ts.SymbolFlags.Function) return "function";
	if (f & ts.SymbolFlags.Enum) return "enum";
	if (f & ts.SymbolFlags.Interface) return "interface";
	if (f & ts.SymbolFlags.TypeAlias) return "type";
	if (f & ts.SymbolFlags.Module) return "namespace";
	return "const";
}

/**
 * loadEntryPoints resolves every entry point of the exports map whose source exists.
 * Entry points reserved in package.json but not yet written are returned in `missing`.
 */
export function loadEntryPoints(
	repo: Repo,
	targets: readonly ExportTarget[],
	table: readonly PackageRow[],
): { entryPoints: EntryPoint[]; missing: string[] } {
	const present = targets.filter((t) => repo.exists(t.source));
	const missing = targets.filter((t) => !repo.exists(t.source)).map((t) => t.specifier);
	const program = ts.createProgram(
		present.map((t) => repo.path(t.source)),
		{
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			allowImportingTsExtensions: true,
			noEmit: true,
			skipLibCheck: true,
			types: [],
			lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
		},
	);
	const checker = program.getTypeChecker();
	const entryPoints = present.map((t): EntryPoint => {
		const sf = program.getSourceFile(repo.path(t.source));
		const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
		const names = (mod === undefined ? [] : checker.getExportsOfModule(mod))
			.map((s): ExportedName => {
				const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
				const doc = ts.displayPartsToString(target.getDocumentationComment(checker));
				return { name: s.getName(), kind: kindOf(target), summary: firstSentence(cleanDoc(doc)) };
			})
			.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
		const row = describe(table, t.specifier);
		const position = row?.imports.indexOf(t.specifier) ?? -1;
		const own = moduleSummary(repo, t.source);
		const contents = row?.contents.replace(/\s*\(see above\)/, "").trim() ?? "";
		// A description that starts with an identifier keeps its case.
		const fromTable = contents.startsWith("`") ? contents : capitalise(contents);
		// A table row that names only this entry point describes it best; a shared or glob
		// row is less specific than the module's own package comment.
		const exact = position >= 0 && row?.imports.length === 1;
		const goNames = row?.go.split(/,\s*/) ?? [];
		const glob = row?.imports.find((i) => i.endsWith("/*")) !== undefined;
		return {
			specifier: t.specifier,
			source: t.source,
			summary: exact ? fromTable || own : own || fromTable,
			go: glob
				? goPackageOf(repo, t.source, row?.go ?? "")
				: position >= 0 && goNames.length === row?.imports.length
					? (goNames[position] ?? "")
					: (row?.go ?? ""),
			names,
		};
	});
	return { entryPoints, missing };
}
