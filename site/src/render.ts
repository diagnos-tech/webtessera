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

// Puts the page together: the head, then header, hero, the numbered sections and the
// footer. The order of `sections` is the order of the page and of its navigation.

import type { Highlight } from "./components/code.ts";
import { section } from "./components/section.ts";
import type { SiteData } from "./data/index.ts";
import { build } from "./sections/build.ts";
import { demo } from "./sections/demo.ts";
import { fidelity } from "./sections/fidelity.ts";
import { renderFooter } from "./sections/footer.ts";
import { renderHead } from "./sections/head.ts";
import { renderHeader } from "./sections/header.ts";
import { renderHero } from "./sections/hero.ts";
import { packages } from "./sections/packages.ts";
import { quickstart } from "./sections/quickstart.ts";
import { runtimes } from "./sections/runtimes.ts";
import { storage } from "./sections/storage.ts";
import { why } from "./sections/why.ts";
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
		why(d),
		demo(d),
		quickstart(d, hl),
		storage(d, hl),
		build(d),
		fidelity(d),
		runtimes(d),
		packages(d),
	];
	const body = html`${renderHeader(d, sections)}
<main id="main">
${renderHero(d)}
${sections.map((s, i) => section(s, i + 1))}
</main>
${renderFooter(d)}`;
	return { head: minify(renderHead(d).value), body: minify(body.value) };
}
