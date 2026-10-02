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

// The library's package.json: name, version, licence, repository and, above all, the
// exports map, which is the list of public entry points.

import type { Repo } from "./repo.ts";

/** ExportTarget is one public entry point of the package. */
export interface ExportTarget {
	/** specifier is what users import, e.g. webtessera/client. */
	readonly specifier: string;
	/** dist is the built file it resolves to, e.g. ./dist/client/index.js. */
	readonly dist: string;
	/** source is the TypeScript file it is built from, e.g. src/client/index.ts. */
	readonly source: string;
}

/** PackageInfo is what the site uses from package.json. */
export interface PackageInfo {
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly license: string;
	readonly author: string;
	readonly node: string;
	readonly dependencies: readonly string[];
	readonly repo: { readonly owner: string; readonly name: string; readonly url: string };
	readonly exports: readonly ExportTarget[];
}

interface RawPackage {
	name: string;
	version: string;
	description?: string;
	keywords?: string[];
	license?: string;
	author?: string;
	engines?: { node?: string };
	dependencies?: Record<string, string>;
	repository?: { url?: string } | string;
	exports?: Record<string, string | Record<string, string>>;
}

/** sourceOf maps a built file of the exports map back to the source it is compiled from. */
function sourceOf(dist: string): string {
	return dist.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
}

function repository(raw: RawPackage): PackageInfo["repo"] {
	const url = typeof raw.repository === "string" ? raw.repository : (raw.repository?.url ?? "");
	const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
	if (m === null) {
		throw new Error(`package.json: cannot find the GitHub repository in ${JSON.stringify(url)}`);
	}
	const [, owner = "", name = ""] = m;
	return { owner, name, url: `https://github.com/${owner}/${name}` };
}

/** loadPackage reads the library's package.json. */
export function loadPackage(repo: Repo): PackageInfo {
	const raw = repo.json<RawPackage>("package.json");
	const exports: ExportTarget[] = [];
	for (const [key, value] of Object.entries(raw.exports ?? {})) {
		const dist = typeof value === "string" ? value : (value.import ?? value.default ?? "");
		if (!dist.endsWith(".js")) {
			continue; // ./package.json and other non-module exports
		}
		const specifier = key === "." ? raw.name : `${raw.name}/${key.replace(/^\.\//, "")}`;
		exports.push({ specifier, dist, source: sourceOf(dist) });
	}
	return {
		name: raw.name,
		version: raw.version,
		description: raw.description ?? "",
		keywords: raw.keywords ?? [],
		license: raw.license ?? "",
		author: raw.author ?? "",
		node: raw.engines?.node ?? "",
		dependencies: Object.keys(raw.dependencies ?? {}),
		repo: repository(raw),
		exports,
	};
}
