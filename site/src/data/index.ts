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

// Everything the site is generated from, read from the repository in one place.

import type { SiteConfig } from "../lib/url.ts";
import { loadTestMatrix, type TestMatrix } from "./ci.ts";
import { type Decisions, loadDecisions } from "./decisions.ts";
import { type EntryPoint, loadEntryPoints } from "./entrypoints.ts";
import { type Evidence, loadEvidence } from "./evidence.ts";
import { type Example, loadExamples } from "./examples.ts";
import { type Fixtures, loadFixtures } from "./fixtures.ts";
import { type Licensing, loadLicensing } from "./notice.ts";
import { loadPackage, type PackageInfo } from "./package.ts";
import { loadPortingMap, type PortingMap } from "./porting.ts";
import { type Install, loadInstall, loadPackageTable, loadSnippets, type PackageRow, type Snippet } from "./readme.ts";
import { type BuiltReceipt, buildReceipt } from "./receipt-log.ts";
import { Repo } from "./repo.ts";
import { loadSafeApi, type SafeApi } from "./safe.ts";
import { buildSampleLog, type SampleLog } from "./sample-log.ts";
import { loadSecurity, type Security } from "./security.ts";

/** SiteData is the input of every page. */
export interface SiteData {
	readonly root: string;
	readonly site: SiteConfig;
	readonly pkg: PackageInfo;
	readonly entryPoints: readonly EntryPoint[];
	/** packages are the rows of the package map in docs/guides/ported-api.md. */
	readonly packages: readonly PackageRow[];
	/** reserved lists entry points declared in package.json whose source does not exist yet. */
	readonly reserved: readonly string[];
	readonly snippets: ReadonlyMap<string, Snippet>;
	/** drift lists README regions whose copy in README.md differs from the tested source. */
	readonly drift: readonly string[];
	readonly install: Install;
	readonly safe: SafeApi;
	readonly porting: PortingMap;
	readonly decisions: Decisions;
	readonly fixtures: Fixtures;
	readonly examples: readonly Example[];
	readonly tests: TestMatrix;
	readonly evidence: Evidence;
	readonly security: Security;
	readonly licensing: Licensing;
	readonly sample: SampleLog;
	/** receipt is the receipt a safe-API log returned while the site built. */
	readonly receipt: BuiltReceipt;
}

/** loadSiteData reads the repository at root. */
export async function loadSiteData(root: string, site: SiteConfig): Promise<SiteData> {
	const repo = new Repo(root);
	const pkg = loadPackage(repo);
	const packages = loadPackageTable(repo);
	const { entryPoints, missing } = loadEntryPoints(repo, pkg.exports, packages);
	const { snippets, drift } = loadSnippets(repo);
	const specifiers = entryPoints.map((e) => e.specifier);
	const [sample, receipt] = await Promise.all([
		buildSampleLog(site.origin, specifiers, 5),
		buildReceipt(site.origin, specifiers, 5),
	]);
	return {
		root,
		site,
		pkg,
		entryPoints,
		packages,
		reserved: missing,
		snippets,
		drift,
		install: loadInstall(repo),
		safe: loadSafeApi(repo, entryPoints),
		porting: loadPortingMap(repo),
		decisions: loadDecisions(repo),
		fixtures: loadFixtures(repo),
		examples: loadExamples(repo),
		tests: loadTestMatrix(repo),
		evidence: loadEvidence(repo),
		security: loadSecurity(repo),
		licensing: loadLicensing(repo),
		sample,
		receipt,
	};
}

/** snippet returns a README region the site shows, and fails the build if README.md no longer embeds it. */
export function snippet(d: SiteData, region: string): Snippet {
	const s = d.snippets.get(region);
	if (s === undefined) {
		throw new Error(
			`README.md no longer embeds the region "${region}", which the site shows; choose another region in site/src`,
		);
	}
	return s;
}
