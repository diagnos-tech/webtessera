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

// A content loader for the repository's own Markdown: the guides, the examples' READMEs and
// sections of other documents. It reads each file as GitHub shows it, takes the title from the
// first heading and the description from the first paragraph, rewrites the relative links
// (lib/routes.ts), and renders the rest with Astro's Markdown renderer.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Loader } from "astro/loaders";
import { describe, firstParagraph, rewriteLinks, splitTitle } from "./markdown.ts";
import { resolver } from "./routes.ts";
import { repoRoot, siteConfig } from "./url.ts";

/** Source is one repository document, or one section of it, to load as an entry. */
export interface Source {
	readonly id: string;
	/** file is the document's repository path. */
	readonly file: string;
	/** section, if set, is the heading line ("## Scope") whose section is the entry. */
	readonly section?: string;
	/** description overrides the description taken from the first paragraph. */
	readonly description?: string;
	/** adrs links each plain "ADR-NNNN" mention to its decision record. */
	readonly adrs?: boolean;
}

/** linkAdrs links the "ADR-NNNN" mentions of a document that are not links yet to their files. */
function linkAdrs(markdown: string, root: string): string {
	const files = new Map(
		readdirSync(join(root, "docs/decisions"))
			.filter((f) => /^\d{4}-.+\.md$/.test(f))
			.map((f) => [f.slice(0, 4), f]),
	);
	return markdown.replace(/(?<!\[)\bADR-(\d{4})\b(?!\])/g, (m, n: string) => {
		const file = files.get(n);
		return file === undefined ? m : `[${m}](/docs/decisions/${file})`;
	});
}

/** section returns the part of a document under a heading line, up to the next heading of the same or a higher level. */
export function section(markdown: string, heading: string, file: string): string {
	const lines = markdown.split("\n");
	const start = lines.findIndex((l) => l.trim() === heading);
	if (start < 0) {
		throw new Error(`${file} has no heading "${heading}", which the site renders; update site/src/content.config.ts`);
	}
	const level = /^#+/.exec(heading)?.[0].length ?? 1;
	const rest = lines.slice(start + 1);
	let fenced = false;
	const end = rest.findIndex((l) => {
		if (l.startsWith("```")) {
			fenced = !fenced;
		}
		const h = /^(#+) /.exec(l)?.[1]?.length ?? 0;
		return !fenced && h > 0 && h <= level;
	});
	return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

/** splitLead separates a rendered document's first paragraph, its lead, from the rest. */
function splitLead(html: string): { lead: string; rest: string } {
	const m = /^\s*<p>([\s\S]*?)<\/p>/.exec(html);
	return m === null ? { lead: "", rest: html } : { lead: m[1] ?? "", rest: html.slice(m[0].length) };
}

/** wrapTables puts each table in a scrolling region, so that a wide table scrolls instead of the page. */
function wrapTables(html: string): string {
	return html
		.replace(/<table>/g, '<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table>')
		.replace(/<\/table>/g, "</table></div>");
}

/** repoMarkdown loads repository Markdown documents as content entries. */
export function repoMarkdown(name: string, sources: (root: string) => readonly Source[]): Loader {
	return {
		name: `repo-markdown:${name}`,
		async load({ store, config, parseData, renderMarkdown, generateDigest, watcher }) {
			const root = repoRoot();
			const resolve = resolver(siteConfig(root), root, config.base);
			store.clear();
			for (const source of sources(root)) {
				const raw = readFileSync(join(root, source.file), "utf8");
				const { title, body } =
					source.section === undefined
						? splitTitle(raw)
						: { title: source.section.replace(/^#+\s*/, ""), body: section(raw, source.section, source.file) };
				const linked = source.adrs === true ? linkAdrs(body, root) : body;
				const rendered = await renderMarkdown(rewriteLinks(linked, source.file, resolve));
				// A whole document's first paragraph is its lead, shown before its contents list.
				const { lead, rest } =
					source.section === undefined ? splitLead(rendered.html) : { lead: "", rest: rendered.html };
				const data = await parseData({
					id: source.id,
					data: {
						title,
						description: source.description ?? describe(firstParagraph(body)),
						lead,
						file: source.file,
					},
				});
				store.set({
					id: source.id,
					data,
					rendered: { ...rendered, html: wrapTables(rest) },
					digest: generateDigest(raw + config.base),
				});
				watcher?.add(join(root, source.file));
			}
		},
	};
}
