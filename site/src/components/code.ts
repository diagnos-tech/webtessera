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

// Code blocks: Shiki-highlighted at build time (light and dark themes through CSS
// variables), with a caption naming the tested source the code comes from and a copy
// button that the page's script reveals.

import { createHighlighter } from "shiki";
import { html, raw, type SafeHtml } from "../shared/html.ts";
import { icons } from "./icons.ts";

/** Lang is a language the page highlights. */
export type Lang = "ts" | "sh";

/** Highlight renders code as highlighted HTML. */
export type Highlight = (code: string, lang: Lang) => SafeHtml;

/** createHighlight loads Shiki with the page's two themes and languages. */
export async function createHighlight(): Promise<Highlight> {
	const themes = { light: "github-light-default", dark: "github-dark-default" } as const;
	const hl = await createHighlighter({ themes: Object.values(themes), langs: ["ts", "sh"] });
	return (code, lang) => raw(hl.codeToHtml(code, { lang, themes, defaultColor: false }));
}

/** copyButton renders a copy button; it stays hidden until the page's script wires it up. */
export function copyButton(label: string): SafeHtml {
	return html`<button class="copy" type="button" hidden data-copy aria-label="${label}">${icons.copy}${icons.check}</button>`;
}

/** CodeSource names where a snippet comes from. */
export interface CodeSource {
	readonly label: string;
	readonly href?: string;
}

/** codeBlock renders a highlighted code block with its caption and copy button. */
export function codeBlock(hl: Highlight, code: string, lang: Lang, source: CodeSource): SafeHtml {
	const label =
		source.href === undefined
			? html`<span class="code-src">${source.label}</span>`
			: html`<a class="code-src" href="${source.href}">${source.label}</a>`;
	return html`<figure class="code">
<figcaption>${label}${copyButton("Copy code")}</figcaption>
${hl(code, lang)}
</figure>`;
}
