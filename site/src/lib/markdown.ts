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

// The repository's Markdown, as the site shows it. Its relative links are written for GitHub
// (`safe-api.md`, `../../examples/notary`); on the site, a link to a guide or an example goes
// to its page, and any other file to GitHub at the build's commit. Titles come from the first
// `#` heading and descriptions from the first paragraph, so the files need no front matter.

import { escapeHtml } from "../shared/html.ts";

/** Resolve maps a repository path (and a #fragment, or "") to the URL the site links it to. */
export type Resolve = (path: string, hash: string) => string;

/** normalisePath resolves "." and ".." segments of a repository-relative path. */
export function normalisePath(path: string): string {
	const out: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "..") {
			out.pop();
		} else if (seg !== "." && seg !== "") {
			out.push(seg);
		}
	}
	return out.join("/");
}

/** resolveTarget turns a link target written in the file `from` into a URL, or leaves it as it is. */
export function resolveTarget(target: string, from: string, resolve: Resolve): string {
	if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) {
		return target; // absolute URLs, mailto:, and fragments of the same page
	}
	const [path = "", hash = ""] = target.split(/#(.*)/s);
	const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
	const absolute = path.startsWith("/") ? path.slice(1) : `${dir}/${path}`;
	return resolve(normalisePath(absolute), hash);
}

/** outsideCode applies f to the parts of a Markdown document that are not code, fenced or inline. */
function outsideCode(markdown: string, f: (text: string) => string): string {
	return markdown
		.split(/(^```[\s\S]*?^```$)/m)
		.map((block) =>
			block.startsWith("```")
				? block
				: block
						.split(/(`+[^`]*`+)/)
						.map((part) => (part.startsWith("`") ? part : f(part)))
						.join(""),
		)
		.join("");
}

/** rewriteLinks rewrites every relative link and link reference of a Markdown file at `from`. */
export function rewriteLinks(markdown: string, from: string, resolve: Resolve): string {
	return outsideCode(markdown, (text) =>
		text
			.replace(
				/(\]\()(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?\))/g,
				(_m, open: string, target: string, close: string) =>
					`${open}${resolveTarget(target.replace(/^<|>$/g, ""), from, resolve)}${close}`,
			)
			.replace(
				/^(\s*\[[^\]]+\]:\s*)(\S+)/gm,
				(_m, open: string, target: string) => `${open}${resolveTarget(target, from, resolve)}`,
			),
	);
}

/** splitTitle separates a document's first `#` heading from the rest. */
export function splitTitle(markdown: string): { title: string; body: string } {
	const m = /^# (.+)\n/m.exec(markdown);
	if (m === null) {
		return { title: "", body: markdown };
	}
	return { title: m[1]?.trim() ?? "", body: markdown.slice(0, m.index) + markdown.slice(m.index + m[0].length) };
}

/** plainText turns inline Markdown into text: links keep their labels, code and emphasis lose their marks. */
export function plainText(markdown: string): string {
	return markdown
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s.,;:)]|$)/g, "$1$2")
		.replace(/\s+/g, " ")
		.trim();
}

/** firstParagraph returns the first paragraph of prose of a document body, as plain text. */
export function firstParagraph(body: string): string {
	for (const block of body.split(/\n\s*\n/)) {
		const text = block.trim();
		if (text !== "" && !/^(#|>|```|\||[-*] |\d+\. |<|!\[|\[!)/.test(text)) {
			return plainText(text);
		}
	}
	return "";
}

/**
 * describe fits a text to a search result's description, at most `max` characters: whole
 * sentences while they fit, else the text up to its last clause boundary, else up to its last
 * word, with an ellipsis.
 */
export function describe(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) {
		return flat;
	}
	const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
	let out = "";
	for (const s of sentences) {
		if ((out + s).trim().length > max) {
			break;
		}
		out += s;
	}
	if (out.trim().length >= max * 0.6) {
		return out.trim();
	}
	const head = flat.slice(0, max - 1);
	const clause = Math.max(head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(", "));
	if (clause >= max * 0.6) {
		return `${head.slice(0, clause)}.`;
	}
	return `${head.slice(0, head.lastIndexOf(" "))}…`;
}

/**
 * inline renders a line of inline Markdown (code, links, strong and emphasis) as HTML,
 * escaping everything else. Links are resolved as if written in the file `from`.
 */
export function inline(markdown: string, from = "", resolve?: Resolve): string {
	return markdown
		.split(/(`[^`]+`)/)
		.map((part) => {
			if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
				return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
			}
			return escapeHtml(part)
				.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, target: string) => {
					const url = resolve === undefined ? target : resolveTarget(target, from, resolve);
					return `<a href="${url}">${label}</a>`;
				})
				.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
				.replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s.,;:)]|$)/g, "$1<em>$2</em>");
		})
		.join("");
}
