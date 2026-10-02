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

// examples/*: each runnable example's title and summary (the first heading and
// paragraph of its README) and the webtessera entry points its code imports.

import type { Repo } from "./repo.ts";

/** Example is one runnable example. */
export interface Example {
	readonly dir: string;
	readonly title: string;
	/** summary is the README's first paragraph, in Markdown. */
	readonly summary: string;
	readonly imports: readonly string[];
	readonly scripts: readonly string[];
}

/** firstParagraph returns the first prose paragraph after a Markdown document's title. */
export function firstParagraph(markdown: string): string {
	const blocks = markdown.replace(/^#[^\n]*\n/, "").split(/\n\s*\n/);
	const p = blocks.find((b) => {
		const t = b.trim();
		return t !== "" && !/^(#|>|\||```|!\[|\[!\[|<|- |\* |\d+\. )/.test(t);
	});
	return (p ?? "").replace(/\s*\n\s*/g, " ").trim();
}

/** loadExamples reads every examples/<dir> that has a package.json. */
export function loadExamples(repo: Repo): Example[] {
	return repo
		.list("examples", "dir")
		.filter((dir) => repo.exists(`examples/${dir}/package.json`))
		.map((dir): Example => {
			const readme = repo.textOr(`examples/${dir}/README.md`) ?? "";
			const pkg = repo.json<{ description?: string; scripts?: Record<string, string> }>(`examples/${dir}/package.json`);
			const title = /^# (.+)$/m.exec(readme)?.[1]?.trim() ?? dir;
			const imports = new Set<string>();
			for (const file of repo.walk(`examples/${dir}`, /\.(ts|tsx|js|mjs)$/)) {
				for (const m of repo.text(file).matchAll(/from\s+["'](webtessera(?:\/[\w/-]+)?)["']/g)) {
					imports.add(m[1] ?? "");
				}
			}
			return {
				dir,
				title,
				summary: firstParagraph(readme) || pkg.description || "",
				imports: [...imports].sort(),
				scripts: Object.keys(pkg.scripts ?? {}).filter((s) => !s.startsWith("pre")),
			};
		});
}
