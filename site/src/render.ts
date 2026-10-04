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

// Puts the page together: the head, then header, hero, the numbered sections and the
// footer. The order of `sections` is the order of the page and of its navigation: the safe
// API first, then what a log is and a live one, where it is kept, what is built around it,
// the examples, the evidence and the security posture, and the full ported API last.

import type { Highlight } from "./components/code.ts";
import { section } from "./components/section.ts";
import type { SiteData } from "./data/index.ts";
import { api } from "./sections/api.ts";
import { compatibility } from "./sections/compatibility.ts";
import { concepts } from "./sections/concepts.ts";
import { demo } from "./sections/demo.ts";
import { examples } from "./sections/examples.ts";
import { renderFooter } from "./sections/footer.ts";
import { renderHead } from "./sections/head.ts";
import { renderHeader } from "./sections/header.ts";
import { renderHero } from "./sections/hero.ts";
import { quickstart } from "./sections/quickstart.ts";
import { runtimes } from "./sections/runtimes.ts";
import { security } from "./sections/security.ts";
import { serve } from "./sections/serve.ts";
import { storage } from "./sections/storage.ts";
import { html } from "./shared/html.ts";

/** Page is the rendered page, as the two placeholders of index.html receive it. */
export interface Page {
	readonly head: string;
	readonly body: string;
}

/** minify collapses runs of whitespace between tags, leaving <pre> blocks untouched. */
function minify(markup: string): string {
	return markup
		.split(/(<pre[\s\S]*?<\/pre>)/)
		.map((part) => (part.startsWith("<pre") ? part : part.replace(/\n\s*/g, "\n").replace(/[ \t]{2,}/g, " ")))
		.join("");
}

/** renderPage renders the whole page from the repository's data. */
export function renderPage(d: SiteData, hl: Highlight): Page {
	const sections = [
		quickstart(d, hl),
		concepts(d),
		demo(d),
		storage(d, hl),
		serve(d),
		examples(d),
		compatibility(d),
		security(d),
		api(d, hl),
		runtimes(d),
	];
	const body = html`${renderHeader(d, sections)}
<main id="main">
${renderHero(d)}
${sections.map((s, i) => section(s, i + 1))}
</main>
${renderFooter(d)}`;
	return { head: minify(renderHead(d).value), body: minify(body.value) };
}
