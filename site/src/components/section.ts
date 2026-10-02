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

// The frame every content section shares: an anchor, an eyebrow numbered like a log
// index with the hash of the section's name beside it, a heading and a lead.

import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { fragment } from "../shared/bytes.ts";
import { html, type Interpolation, type SafeHtml } from "../shared/html.ts";

/** SectionSpec describes one section of the page. */
export interface SectionSpec {
	readonly id: string;
	/** nav is the short name used in the navigation and the eyebrow. */
	readonly nav: string;
	readonly title: string;
	readonly lead?: Interpolation;
	readonly body: Interpolation;
	readonly className?: string;
}

/** section renders a section; index is its position, shown as the log index of an entry. */
export function section(spec: SectionSpec, index: number): SafeHtml {
	const leaf = fragment(DefaultHasher.hashLeaf(new TextEncoder().encode(spec.id)));
	return html`<section id="${spec.id}" class="section${spec.className === undefined ? "" : ` ${spec.className}`}" aria-labelledby="${spec.id}-title">
<div class="wrap">
<header class="section-head">
<p class="eyebrow"><span class="idx">${String(index).padStart(2, "0")}</span><span>${spec.nav}</span><span class="leaf" aria-hidden="true">${leaf}</span></p>
<h2 id="${spec.id}-title">${spec.title}</h2>
${spec.lead === undefined ? "" : html`<p class="lead">${spec.lead}</p>`}
</header>
${spec.body}
</div>
</section>`;
}
