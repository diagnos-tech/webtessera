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

// Inline Markdown, as far as README paragraphs need it: `code`, **bold**, *emphasis*
// and links. Absolute links stay links; links relative to a README in the repository
// are resolved against its GitHub URL.

import { html, raw, type SafeHtml } from "../shared/html.ts";

/** inlineMarkdown renders a paragraph of inline Markdown; base resolves relative links. */
export function inlineMarkdown(text: string, base: string): SafeHtml {
	const out: SafeHtml[] = [];
	const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		out.push(html`${text.slice(last, m.index)}`);
		const [, code, bold, em, label, href] = m;
		if (code !== undefined) {
			out.push(html`<code>${code}</code>`);
		} else if (bold !== undefined) {
			out.push(html`<strong>${bold}</strong>`);
		} else if (em !== undefined) {
			out.push(html`<em>${em}</em>`);
		} else if (label !== undefined && href !== undefined) {
			out.push(html`<a href="${new URL(href, base).href}">${inlineMarkdown(label, base)}</a>`);
		}
		last = (m.index ?? 0) + m[0].length;
	}
	out.push(html`${text.slice(last)}`);
	return raw(out.join(""));
}
