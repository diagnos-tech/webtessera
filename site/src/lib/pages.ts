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

// The site's pages: the titles and descriptions of the hand-written ones, the order the docs
// are read in, and the list of every page with its title and description, which the social
// images are drawn from.

import { getCollection } from "astro:content";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryPoint } from "../data/entrypoints.ts";
import type { Link } from "../layouts/Doc.astro";
import { describe, plainText } from "./markdown.ts";
import { guideSlug } from "./routes.ts";
import { getSiteData } from "./site.ts";

/** Meta is a page's title and its description for search results. */
export interface Meta {
	readonly title: string;
	readonly description: string;
	/** headline is the page's h1, where it differs from its title. */
	readonly headline?: string;
}

/** meta are the hand-written pages. */
export const meta = {
	home: {
		title: "webtessera: Tessera transparency logs in TypeScript",
		headline: "Tessera transparency logs, in TypeScript",
		description:
			"A TypeScript port of Tessera, the tile-based transparency log: append an entry and get a receipt anyone can verify offline. Runs on any SQLite or IndexedDB.",
	},
	docs: {
		title: "Documentation",
		description:
			"Documentation for webtessera: start with the safe API, follow the guide for your use case, read how transparency logs work, or look up an entry point.",
	},
	concepts: {
		title: "Transparency logs, explained",
		description:
			"How a transparency log works: entries hashed into a Merkle tree, tiles, signed checkpoints, inclusion and consistency proofs, receipts and witnesses.",
	},
	reference: {
		title: "API reference",
		description:
			"The API reference of every webtessera entry point: its exports with the first sentence of their doc comments, the Go package it ports, and its source.",
	},
	examples: {
		title: "Examples",
		description:
			"Runnable webtessera applications, one per use case, each with its own README, tests and guide: from a browser's own log to a log server at the edge.",
	},
	compatibility: {
		title: "Compatibility with Tessera",
		description:
			"How webtessera proves that its logs are byte for byte Tessera's: golden fixtures, Go interop, differential corpora, test parity, and the CI that runs them.",
	},
	security: {
		title: "Security",
		description:
			"webtessera's safe defaults, the security reviews behind them, the hardening it adds beyond Tessera, and how to report a vulnerability privately.",
	},
	notFound: {
		title: "Page not found",
		description:
			"There is no page at this address on the webtessera site. Start again from the home page, the documentation or the examples, or search the repository.",
	},
} as const satisfies Record<string, Meta>;

/**
 * guideOrder lists the guides in reading order: the topics of docs/guides/README.md (the safe
 * API first), then the use-case guides in the order of its table; guides it does not link to
 * come last.
 */
export function guideOrder(root: string, slugs: readonly string[]): string[] {
	const index = readFileSync(join(root, "docs/guides/README.md"), "utf8");
	const topics = index.slice(index.indexOf("## Topics"));
	const linked = (text: string) => [...text.matchAll(/\]\(([\w.-]+)\.md(?:#[^)]*)?\)/g)].map((m) => m[1] ?? "");
	const order = [...new Set([...linked(topics), ...linked(index)])].filter((s) => slugs.includes(s));
	return [...order, ...slugs.filter((s) => !order.includes(s)).sort()];
}

/** docsSequence is every docs page in reading order: the guides, the concepts, the reference. */
export async function docsSequence(): Promise<Link[]> {
	const { root } = await getSiteData();
	const guides = await getCollection("guides");
	const order = guideOrder(
		root,
		guides.map((g) => g.id),
	);
	const title = new Map(guides.map((g) => [g.id, plainText(g.data.title)]));
	return [
		...order.map((id) => ({ path: `docs/${id}/`, title: title.get(id) ?? id })),
		{ path: "docs/concepts/", title: meta.concepts.title },
		{ path: "docs/reference/", title: meta.reference.title },
	];
}

/** neighbours returns the pages before and after a path in a sequence. */
export function neighbours(sequence: readonly Link[], path: string): { prev?: Link; next?: Link } {
	const i = sequence.findIndex((l) => l.path === path);
	if (i < 0) {
		return {};
	}
	const prev = sequence[i - 1];
	const next = sequence[i + 1];
	return { ...(prev === undefined ? {} : { prev }), ...(next === undefined ? {} : { next }) };
}

/** referenceSlug is the page name of an entry point: webtessera/storage/sqlite is "storage/sqlite". */
export function referenceSlug(specifier: string): string {
	return specifier === "webtessera" ? "webtessera" : specifier.replace(/^webtessera\//, "");
}

/** referenceMeta is the title and description of an entry point's reference page. */
export function referenceMeta(e: EntryPoint): Meta {
	const summary = plainText(e.summary).replace(/\.$/, "");
	// "The storage engine" reads "the storage engine" after a colon; "RFC 6962" and identifiers keep their case.
	const what = /^[A-Z][a-z]/.test(summary) ? summary.charAt(0).toLowerCase() + summary.slice(1) : summary;
	const port = e.go === "" ? "an addition with no Go counterpart" : `the port of ${e.go}`;
	return {
		title: e.specifier,
		description: describe(`API reference for ${e.specifier}, ${port}: ${what}. Its exports and their doc comments.`),
	};
}

/** PageInfo is a page of the site: its path under the base, title and description. */
export interface PageInfo extends Meta {
	readonly path: string;
}

/** allPages lists every page of the site, for the social images. */
export async function allPages(): Promise<PageInfo[]> {
	const d = await getSiteData();
	const guides = await getCollection("guides");
	const examples = await getCollection("examples");
	return [
		{ path: "", ...meta.home },
		{ path: "docs/", ...meta.docs },
		{ path: "docs/concepts/", ...meta.concepts },
		{ path: "docs/reference/", ...meta.reference },
		{ path: "examples/", ...meta.examples },
		{ path: "compatibility/", ...meta.compatibility },
		{ path: "security/", ...meta.security },
		{ path: "404/", ...meta.notFound },
		...guides.map((g) => ({
			path: `docs/${guideSlug(g.id)}/`,
			title: plainText(g.data.title),
			description: g.data.description,
		})),
		...examples.map((x) => ({
			path: `examples/${x.id}/`,
			title: plainText(x.data.title),
			description: x.data.description,
		})),
		...d.entryPoints.map((e) => ({ path: `docs/reference/${referenceSlug(e.specifier)}/`, ...referenceMeta(e) })),
	];
}
