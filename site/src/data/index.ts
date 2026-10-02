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

// Everything the page is generated from, read from the repository in one place.

import { execFileSync } from "node:child_process";
import type { SiteConfig } from "../config.ts";
import { loadTestMatrix, type TestMatrix } from "./ci.ts";
import { type Decisions, loadDecisions } from "./decisions.ts";
import { loadSqliteEngines, type SqliteEngine } from "./engines.ts";
import { type EntryPoint, loadEntryPoints } from "./entrypoints.ts";
import { type Example, loadExamples } from "./examples.ts";
import { type Fixtures, loadFixtures } from "./fixtures.ts";
import { type Licensing, loadLicensing } from "./notice.ts";
import { loadPackage, type PackageInfo } from "./package.ts";
import { loadPortingMap, type PortingMap } from "./porting.ts";
import { type Install, loadInstall, loadPackageTable, loadSnippets, type Snippet } from "./readme.ts";
import { Repo } from "./repo.ts";
import { buildSampleLog, type SampleLog } from "./sample-log.ts";

/** SiteData is the input of every section renderer. */
export interface SiteData {
	readonly site: SiteConfig;
	readonly pkg: PackageInfo;
	readonly entryPoints: readonly EntryPoint[];
	/** reserved lists entry points declared in package.json whose source does not exist yet. */
	readonly reserved: readonly string[];
	readonly snippets: ReadonlyMap<string, Snippet>;
	/** drift lists README regions whose copy in README.md differs from the tested source. */
	readonly drift: readonly string[];
	readonly install: Install;
	readonly sqliteEngines: readonly SqliteEngine[];
	readonly porting: PortingMap;
	readonly decisions: Decisions;
	readonly fixtures: Fixtures;
	readonly examples: readonly Example[];
	readonly tests: TestMatrix;
	readonly licensing: Licensing;
	readonly objectStoreMethods: readonly string[];
	readonly sample: SampleLog;
	/** lastModified is the date of the commit the site was built from, if git knows it. */
	readonly lastModified: string | undefined;
}

/** gitDate returns the committer date (YYYY-MM-DD) of HEAD, or undefined outside a git checkout. */
function gitDate(root: string): string | undefined {
	try {
		const out = execFileSync("git", ["log", "-1", "--format=%cs"], { cwd: root, encoding: "utf8" }).trim();
		return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

/** objectStoreMethods lists the methods of the ObjectStore contract, from its declaration. */
function objectStoreMethods(repo: Repo): string[] {
	const src = repo.textOr("src/storage/objectstore/objectstore.ts") ?? "";
	const body = /export interface ObjectStore \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
	return [...body.matchAll(/^\t(\w+)(?:<[^>]*>)?\(/gm)].map((m) => m[1] ?? "");
}

/** loadSiteData reads the repository at root. */
export async function loadSiteData(root: string, site: SiteConfig): Promise<SiteData> {
	const repo = new Repo(root);
	const pkg = loadPackage(repo);
	const { entryPoints, missing } = loadEntryPoints(repo, pkg.exports, loadPackageTable(repo));
	const { snippets, drift } = loadSnippets(repo);
	return {
		site,
		pkg,
		entryPoints,
		reserved: missing,
		snippets,
		drift,
		install: loadInstall(repo),
		sqliteEngines: loadSqliteEngines(
			repo,
			new Set(entryPoints.find((e) => e.specifier === "webtessera/storage/sqlite")?.names.map((n) => n.name)),
		),
		porting: loadPortingMap(repo),
		decisions: loadDecisions(repo),
		fixtures: loadFixtures(repo),
		examples: loadExamples(repo),
		tests: loadTestMatrix(repo),
		licensing: loadLicensing(repo),
		objectStoreMethods: objectStoreMethods(repo),
		sample: await buildSampleLog(
			site.origin,
			entryPoints.map((e) => e.specifier),
			5,
		),
		lastModified: gitDate(root),
	};
}

/** entry returns the entry point with the given specifier, if the package has it. */
export function entry(d: SiteData, specifier: string): EntryPoint | undefined {
	return d.entryPoints.find((e) => e.specifier === specifier);
}
