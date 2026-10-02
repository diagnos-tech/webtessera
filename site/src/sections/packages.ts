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

// The package map: every entry point of the exports map, its Go counterpart, what it
// is for, and the names it exports with the first sentence of each one's doc comment,
// as the TypeScript compiler resolves them.

import type { SectionSpec } from "../components/section.ts";
import type { EntryPoint } from "../data/entrypoints.ts";
import type { SiteData } from "../data/index.ts";
import { html, inlineCode } from "../shared/html.ts";

const kindLabel: Record<string, string> = {
	function: "fn",
	class: "class",
	interface: "iface",
	type: "type",
	const: "const",
	enum: "enum",
	namespace: "ns",
};

function row(e: EntryPoint, blob: string) {
	return html`<li><details class="pkg">
<summary><code class="pkg-name">${e.specifier}</code><span class="pkg-desc">${inlineCode(e.summary)}</span><span class="pkg-go">${e.go === "" ? "new in webtessera" : html`Go: <code>${e.go}</code>`}</span><span class="pkg-count">${e.names.length}</span></summary>
<div class="pkg-body">
<ul class="api">${e.names.map(
		(n) =>
			html`<li class="k-${n.kind}" data-kind="${kindLabel[n.kind] ?? n.kind}"><code>${n.name}</code>${n.summary === "" ? "" : html` ${inlineCode(n.summary)}`}</li>`,
	)}</ul>
<p class="pkg-src">Source: <a href="${blob}${e.source}"><code>${e.source}</code></a></p>
</div>
</details></li>`;
}

/** packages is the package-map section. */
export function packages(d: SiteData): SectionSpec {
	const total = d.entryPoints.reduce((n, e) => n + e.names.length, 0);
	return {
		id: "packages",
		nav: "Packages",
		title: `${d.entryPoints.length} entry points, split like Tessera’s Go packages`,
		lead: html`Names follow Go’s, camelCased: <code>NewAppender</code> is <code>newAppender</code>. Go’s <code>uint64</code> is <code>bigint</code>, durations are milliseconds, errors are thrown with Go’s message text, and <code>context.Context</code> is an optional trailing <code>AbortSignal</code>. Open an entry point to see its ${total > 0 ? "exports" : "API"}.`,
		body: html`<ul class="pkgs">${d.entryPoints.map((e) => row(e, d.site.blob))}</ul>`,
	};
}
