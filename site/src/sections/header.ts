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

// The site header: the mark, the version, a link per section and the project links.

import { icons, logo } from "../components/icons.ts";
import type { SectionSpec } from "../components/section.ts";
import type { SiteData } from "../data/index.ts";
import { html, type SafeHtml } from "../shared/html.ts";

/** renderHeader renders the skip link and the sticky header. */
export function renderHeader(d: SiteData, sections: readonly SectionSpec[]): SafeHtml {
	return html`<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
<div class="wrap header-row">
<a class="brand" href="#top">${logo()}<span class="brand-name">${d.pkg.name}</span><span class="brand-ver">v${d.pkg.version}</span></a>
<nav class="site-nav" aria-label="Sections"><ul>${sections.map((s) => html`<li><a href="#${s.id}">${s.nav}</a></li>`)}</ul></nav>
<div class="header-links">
<a class="icon-link" href="${d.site.repo}" aria-label="${d.pkg.name} on GitHub">${icons.github}</a>
<a class="icon-link" href="${d.site.npm}" aria-label="${d.pkg.name} on npm">${icons.npm}</a>
</div>
</div>
</header>`;
}
