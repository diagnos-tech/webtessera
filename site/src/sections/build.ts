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

// The roles of a transparency ecosystem webtessera covers, and the runnable examples.
// A role is shown only when the entry points it needs exist; the examples are read from
// examples/*.

import { icons } from "../components/icons.ts";
import { inlineMarkdown } from "../components/markdown.ts";
import type { SectionSpec } from "../components/section.ts";
import type { SiteData } from "../data/index.ts";
import { html, type SafeHtml } from "../shared/html.ts";

interface Role {
	readonly name: string;
	readonly text: string;
	/** needs lists entry points; the role is shown if the first exists, and lists those that do. */
	readonly needs: readonly string[];
}

const roles: readonly Role[] = [
	{
		name: "Log",
		text: "Own a log: decide what goes in, batch and sequence entries, deduplicate them, publish signed checkpoints, gather witness cosignatures and migrate an existing log in.",
		needs: ["webtessera", "webtessera/storage/sqlite", "webtessera/storage/indexeddb"],
	},
	{
		name: "Log server",
		text: "Serve the tlog-tiles read API (checkpoint, tiles, entry bundles) with the right caching headers, from one fetch-style handler that runs wherever Request and Response do.",
		needs: ["webtessera/http"],
	},
	{
		name: "Witness",
		text: "Run a C2SP tlog-witness: check that each new checkpoint of the logs you follow is consistent with the last, and cosign it.",
		needs: ["webtessera/witness"],
	},
	{
		name: "Mirror",
		text: "Copy a log into storage you control, tile by tile, optionally proving each tile against the log’s signed checkpoint first: any ObjectStore, or any S3-compatible bucket (AWS S3, Backblaze B2, Ceph, Cloudflare R2, Google Cloud Storage, MinIO, Wasabi and others).",
		needs: ["webtessera/mirror"],
	},
	{
		name: "Monitor & verifier",
		text: "Follow a log: verify its checkpoints and their consistency, build and check inclusion proofs, stream its entries, and check a whole log’s integrity with fsck.",
		needs: ["webtessera/client", "webtessera/fsck"],
	},
];

function chips(specifiers: readonly string[]): SafeHtml {
	return html`<ul class="imports">${specifiers.map((s) => html`<li><code>${s}</code></li>`)}</ul>`;
}

/** uses lists an example's imports compactly: the package once, then its subpaths. */
function uses(specifiers: readonly string[]): SafeHtml {
	return html`<p class="uses"><span>Imports</span> ${specifiers.map(
		(s, i) => html`${i === 0 ? "" : " "}<code>${s.replace(/^webtessera(?=\/)/, "")}</code>`,
	)}</p>`;
}

/** build is the section on roles and examples. */
export function build(d: SiteData): SectionSpec {
	const has = new Set(d.entryPoints.map((e) => e.specifier));
	const shown = roles.filter((r) => has.has(r.needs[0] ?? ""));
	return {
		id: "build",
		nav: "Build",
		title: "Every role in a transparency ecosystem",
		lead: "A log is one part of the picture: logs are served, watched, cosigned and copied. webtessera has a piece for each, and each runs in any of the runtimes below.",
		body: html`<ul class="cards roles">${shown.map(
			(r) =>
				html`<li class="card role"><h3>${r.name}</h3><p>${r.text}</p>${chips(r.needs.filter((n) => has.has(n)))}</li>`,
		)}</ul>
${
	d.examples.length === 0
		? ""
		: html`<h3 class="sub-title" id="examples">Runnable examples</h3>
<ul class="cards examples">${d.examples.map((x) => {
				const href = `${d.site.tree}examples/${x.dir}`;
				return html`<li class="card example">
<h4><a href="${href}">${x.title}</a></h4>
<p>${inlineMarkdown(x.summary, `${d.site.blob}examples/${x.dir}/README.md`)}</p>
${uses(x.imports)}
<p class="card-foot"><code>examples/${x.dir}</code><a class="more" href="${href}" aria-label="${x.title}: source on GitHub">Source ${icons.arrow}</a></p>
</li>`;
			})}</ul>`
}`,
	};
}
