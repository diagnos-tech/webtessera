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

// The footer: project links, the licence, and the attributions NOTICE requires.

import { logo } from "../components/icons.ts";
import type { SiteData } from "../data/index.ts";
import type { Attribution } from "../data/notice.ts";
import { html, type SafeHtml } from "../shared/html.ts";

/** credits groups NOTICE's attributions by copyright holder and licence. */
function credits(list: readonly Attribution[]): SafeHtml {
	const groups = new Map<string, { names: Attribution[]; holder: string; license: string }>();
	// Test material is not part of the package, so it is not something the package translates.
	for (const a of list.filter((x) => !x.testOnly)) {
		// "2009 The Go Authors (atoi.go, quote.go)" holds the same copyright as "2017 The Go Authors".
		const holder = a.copyright.replace(/^\d{4}\s+/, "").replace(/\s*\([^)]*\)$/, "");
		const key = `${holder}|${a.license}`;
		const g = groups.get(key) ?? { names: [], holder, license: a.license };
		g.names.push(a);
		groups.set(key, g);
	}
	// Files translated from Go and its golang.org/x modules are listed file by file in
	// NOTICE; here one phrase stands for them.
	return html`${[...groups.values()].map((g, i) => {
		const linked = g.names.filter((a) => a.url !== "");
		const names =
			linked.length === g.names.length
				? linked.map((a, j) => html`${j === 0 ? "" : ", "}<a href="${a.url}">${a.name}</a>`)
				: html`parts of Go and its libraries`;
		return html`${i === 0 ? "" : "; "}${names} (© ${g.holder}, ${g.license})`;
	})}`;
}

/** renderFooter renders the site footer. */
export function renderFooter(d: SiteData): SafeHtml {
	const { site, pkg, licensing } = d;
	const columns: readonly [string, readonly [string, string][]][] = [
		[
			"Project",
			[
				["GitHub", site.repo],
				["npm", site.npm],
				["GitHub Packages", site.packages],
				["Changelog", `${site.blob}CHANGELOG.md`],
				["Issues", `${site.repo}/issues`],
			],
		],
		[
			"Documentation",
			[
				["README", `${site.repo}#readme`],
				["Guides", `${site.tree}docs/guides`],
				["Safe API guide", `${site.blob}docs/guides/safe-api.md`],
				["Compatibility", `${site.blob}docs/compatibility.md`],
				["Porting map", `${site.blob}docs/PORTING-MAP.md`],
				["Decision records", `${site.tree}docs/decisions`],
			],
		],
		[
			"Policies",
			[
				["Security policy", `${site.blob}SECURITY.md`],
				["Contributing", `${site.blob}CONTRIBUTING.md`],
				["Code of conduct", `${site.blob}CODE_OF_CONDUCT.md`],
				["License", `${site.blob}LICENSE`],
				["NOTICE", `${site.blob}NOTICE`],
			],
		],
	];
	return html`<footer class="site-footer">
<div class="wrap">
<div class="footer-grid">
<div class="footer-brand">
<p class="brand">${logo(24)}<span class="brand-name">${pkg.name}</span></p>
<p>${pkg.description}</p>
<p class="independent">An independent, open-source project. Not an official Google or transparency-dev project.</p>
</div>
${columns.map(
	([title, links]) =>
		html`<nav class="footer-col" aria-label="${title}"><h2>${title}</h2><ul>${links.map(([label, href]) => html`<li><a href="${href}">${label}</a></li>`)}</ul></nav>`,
)}
</div>
<div class="legal">
<p>${licensing.holder.replace(/^Copyright/, "©")}. ${pkg.name} is licensed under the <a href="${site.blob}LICENSE">${licensing.title.replace(/, January \d{4}$/, "")}</a>.</p>
<p>It translates ${credits(licensing.attributions)}. It owes its design, its comments and its tests to the Tessera authors.</p>
</div>
</div>
</footer>`;
}
