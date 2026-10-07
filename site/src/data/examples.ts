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

// examples/*: one runnable application per use case. Each example's title is its README's
// first heading, its pitch is its package.json description, the runtimes it runs on are read
// from what its scripts start (start:node, start:bun and start:deno, Vite for a browser
// page, wrangler for Cloudflare Workers), and its guide is the docs/guides page whose row
// in docs/guides/README.md links to it. They are listed in the order of that table; an example
// it does not list yet comes last.

import type { Repo } from "./repo.ts";
import { requireTable } from "./tables.ts";

/** Example is one runnable example. */
export interface Example {
	readonly dir: string;
	readonly title: string;
	/** pitch is the example's one-line description, from its package.json. */
	readonly pitch: string;
	/** runtimes are the runtimes the example's scripts start it on. */
	readonly runtimes: readonly string[];
	/** imports are the webtessera entry points its code imports. */
	readonly imports: readonly string[];
	/** guide is the repository path and title of the guide that walks through it, if any. */
	readonly guide: { readonly path: string; readonly title: string } | undefined;
}

interface RawExample {
	description?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/** runtimesOf reads the runtimes an example runs on from its package.json. */
export function runtimesOf(pkg: RawExample): string[] {
	const scripts = Object.entries(pkg.scripts ?? {});
	const tools = { ...pkg.dependencies, ...pkg.devDependencies };
	const runs = (re: RegExp) => scripts.some(([, cmd]) => re.test(cmd));
	const out: string[] = [];
	if ("vite" in tools && runs(/^vite\b/)) {
		out.push("Browsers");
	}
	for (const [script, name] of [
		["node", "Node.js"],
		["bun", "Bun"],
		["deno", "Deno"],
	] as const) {
		if (scripts.some(([k]) => k === `start:${script}`)) {
			out.push(name);
		}
	}
	if ("wrangler" in tools && runs(/^wrangler\b/)) {
		out.push("Cloudflare Workers");
	}
	return out;
}

/** guidesIndex is the table that pairs each use-case guide with its example. */
export const guidesIndex = { file: "docs/guides/README.md", heading: "# Guides" } as const;

/**
 * loadGuides reads the first table of docs/guides/README.md: the example directories in the
 * order it lists them, and the guide it pairs with each.
 */
function loadGuides(repo: Repo): { order: string[]; guides: Map<string, { path: string; title: string }> } {
	const order: string[] = [];
	const guides = new Map<string, { path: string; title: string }>();
	for (const row of requireTable(repo.text(guidesIndex.file), guidesIndex.file, guidesIndex.heading)) {
		const guide = /\[([^\]]+)\]\(([\w.-]+\.md)\)/.exec(row[0] ?? "");
		const dir = /examples\/([\w.-]+)/.exec(row[row.length - 1] ?? "")?.[1];
		if (dir !== undefined) {
			order.push(dir);
			if (guide !== null) {
				guides.set(dir, { title: guide[1] ?? "", path: `docs/guides/${guide[2] ?? ""}` });
			}
		}
	}
	return { order, guides };
}

/** loadExamples reads every examples/<dir> that has a package.json. */
export function loadExamples(repo: Repo): Example[] {
	const { order, guides } = loadGuides(repo);
	const rank = (dir: string) => {
		const i = order.indexOf(dir);
		return i < 0 ? order.length : i;
	};
	return repo
		.list("examples", "dir")
		.filter((dir) => repo.exists(`examples/${dir}/package.json`))
		.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
		.map((dir): Example => {
			const readme = repo.textOr(`examples/${dir}/README.md`) ?? "";
			const pkg = repo.json<RawExample>(`examples/${dir}/package.json`);
			const imports = new Set<string>();
			for (const file of repo.walk(`examples/${dir}`, /\.(ts|tsx|js|mjs)$/)) {
				for (const m of repo.text(file).matchAll(/from\s+["'](webtessera(?:\/[\w/-]+)?)["']/g)) {
					imports.add(m[1] ?? "");
				}
			}
			return {
				dir,
				title: /^# (.+)$/m.exec(readme)?.[1]?.trim() ?? dir,
				pitch: pkg.description ?? "",
				runtimes: runtimesOf(pkg),
				imports: [...imports].sort(),
				guide: guides.get(dir),
			};
		});
}
