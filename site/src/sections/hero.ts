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

// The hero: what webtessera is in one sentence, the install command, the calls to
// action, and a real signed checkpoint with its tile, produced while the page built.

import { copyButton } from "../components/code.ts";
import { icons } from "../components/icons.ts";
import { count } from "../components/words.ts";
import { entry, type SiteData } from "../data/index.ts";
import { html, type SafeHtml } from "../shared/html.ts";
import { renderNote } from "../shared/note.ts";
import { renderTile } from "../shared/tiles.ts";

/** storageWords names the storage the package has, for the lead sentence. */
function storageWords(d: SiteData): string {
	const words = [
		entry(d, "webtessera/storage/indexeddb") && "IndexedDB",
		entry(d, "webtessera/storage/sqlite") && "any SQLite database",
		entry(d, "webtessera/storage/objectstore") && "a key/value store of your own",
	].filter((w): w is string => typeof w === "string");
	if (words.length < 2) {
		return words.join("");
	}
	return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** renderHero renders the hero section. */
export function renderHero(d: SiteData): SafeHtml {
	const { pkg, site, sample, install } = d;
	const tile = sample.tiles[0];
	const deps = pkg.dependencies.length;
	return html`<section class="hero" id="top" aria-labelledby="hero-title">
<div class="wrap hero-grid">
<div class="hero-copy">
<p class="pill"><span class="dot" aria-hidden="true"></span>Open source · ${pkg.license} · v${pkg.version}</p>
<h1 id="hero-title">Transparency logs for browsers, servers and the edge</h1>
<p class="hero-lead"><strong>${pkg.name}</strong> is a faithful TypeScript port of <a href="${site.tessera}">Tessera</a>, the tile-based transparency log from transparency-dev and the successor to Trillian. Keep a verifiable, append-only log in ${storageWords(d)}, and read it back with Tessera’s own Go tools: the two are byte-for-byte compatible.</p>
<div class="install">
<code class="install-cmd"><span class="prompt" aria-hidden="true">$</span> <span data-copy-text>${install.command}</span></code>
${copyButton("Copy the install command")}
</div>
${install.alternatives.length === 0 ? "" : html`<p class="install-alt">or ${install.alternatives.map((a, i) => html`${i === 0 ? "" : " · "}<code>${a}</code>`)}</p>`}
<div class="cta">
<a class="btn primary" href="#quick-start">Get started ${icons.arrow}</a>
<a class="btn" href="${site.repo}">${icons.github} GitHub</a>
<a class="btn" href="${site.npm}">${icons.npm} npm</a>
</div>
<ul class="facts">
<li>ESM + types</li>
<li>${count(deps, "runtime dependency", "runtime dependencies")}</li>
<li>Node ${pkg.node.replace(/^>=\s*/, "≥ ")} · Deno · Bun · browsers · edge</li>
</ul>
<p class="independent">An independent project, not an official Google or transparency-dev project.</p>
</div>
<div class="hero-art">
${renderNote(sample.note, "signed at build time")}
${tile === undefined ? "" : renderTile(tile)}
<p class="art-caption">A real checkpoint. ${pkg.name} signed it while building this page, over a log whose ${sample.entries.length} entries are the package’s entry points; the mosaic is that log’s first tile, one cell per hash. <a href="#demo">Grow your own below.</a></p>
</div>
</div>
</section>`;
}
