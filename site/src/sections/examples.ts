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

// The examples: one card per directory of examples/ that has a package.json, with its
// one-line pitch, the runtimes its scripts start it on, the entry points it imports, and
// links to its folder and its guide. Nothing here names an example: adding one adds a card.

import { icons } from "../components/icons.ts";
import type { SectionSpec } from "../components/section.ts";
import { count } from "../components/words.ts";
import type { Example } from "../data/examples.ts";
import type { SiteData } from "../data/index.ts";
import { html, type SafeHtml } from "../shared/html.ts";

function card(x: Example, d: SiteData, i: number): SafeHtml {
	const href = `${d.site.tree}examples/${x.dir}`;
	return html`<li class="card example">
<p class="example-n" aria-hidden="true">${String(i).padStart(2, "0")}</p>
<h3><a href="${href}">${x.title}</a></h3>
<p class="example-pitch">${x.pitch}</p>
<ul class="runs" aria-label="Runs on">${x.runtimes.map((r) => html`<li>${r}</li>`)}</ul>
<p class="uses"><span>Imports</span> ${x.imports.map((s, j) => html`${j === 0 ? "" : " "}<code>${s.replace(/^webtessera(?=\/)/, "")}</code>`)}</p>
<p class="card-foot"><a class="more" href="${href}" aria-label="${x.title}: source on GitHub"><code>examples/${x.dir}</code> ${icons.arrow}</a>${
		x.guide === undefined
			? ""
			: html`<a class="guide-link" href="${d.site.blob}${x.guide.path}" aria-label="Guide: ${x.guide.title}">${icons.book} Guide</a>`
	}</p>
</li>`;
}

function capitalise(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** examples is the section listing the runnable examples. */
export function examples(d: SiteData): SectionSpec {
	return {
		id: "examples",
		nav: "Examples",
		title: capitalise(`${count(d.examples.length, "complete application", "complete applications")}, one per use case`),
		lead: html`Each example under <a href="${d.site.tree}examples"><code>examples/</code></a> is a small application with its own README, its trust model and its own tests, ${d.tests.examples ? "which CI runs on every change" : "which run"} with no network and no external service. <a href="${d.site.tree}docs/guides">The guides</a> walk through each one.`,
		body: html`<ul class="cards examples">${d.examples.map((x, i) => card(x, d, i + 1))}</ul>`,
	};
}
