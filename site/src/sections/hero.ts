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

// The hero: what webtessera is in one sentence, the install command for each package
// manager, the calls to action, and a real receipt: a C2SP tlog-proof that a log opened with
// webtessera/server returned from append() while the page built, with that log's first tile.

import { icons } from "../components/icons.ts";
import { installSwitcher } from "../components/install.ts";
import { renderReceipt } from "../components/receipt.ts";
import { count } from "../components/words.ts";
import { entry, type SiteData } from "../data/index.ts";
import { html, type SafeHtml } from "../shared/html.ts";
import { renderTile } from "../shared/tiles.ts";

/** storageWords names the storage the package has, for the lead sentence. */
function storageWords(d: SiteData): string {
	const words = [
		entry(d, "webtessera/storage/indexeddb") && "IndexedDB",
		entry(d, "webtessera/storage/sqlite") && "any SQLite",
		entry(d, "webtessera/storage/objectstore") && "any object store",
	].filter((w): w is string => typeof w === "string");
	if (words.length < 2) {
		return words.join("");
	}
	return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** custody describes the key that signed the hero's receipt, as the build found it. */
function custody(d: SiteData): string {
	const { backend, extractable } = d.receipt.custody;
	const where = backend === "webcrypto" ? "WebCrypto" : backend;
	return `${extractable ? "an extractable" : "a non-extractable"} ${where} Ed25519 key`;
}

/** renderHero renders the hero section. */
export function renderHero(d: SiteData): SafeHtml {
	const { pkg, site, receipt, porting } = d;
	const short = porting.commit.slice(0, 7);
	const call = receipt.from === "append" ? "log.append()" : `log.prove(${receipt.index})`;
	return html`<section class="hero" id="top" aria-labelledby="hero-title">
<div class="wrap hero-grid">
<div class="hero-copy">
<p class="pills"><span class="pill"><span class="dot" aria-hidden="true"></span>Open source · ${pkg.license} · v${pkg.version}</span><a class="pill pill-link" href="${porting.upstream}/tree/${porting.commit}">Faithful port of Tessera @ <code>${short}</code></a></p>
<h1 id="hero-title">Transparency logs for browsers, servers and the edge</h1>
<p class="hero-lead"><strong>${pkg.name}</strong> is a faithful TypeScript port of <a href="${site.tessera}">Tessera</a>, the tile-based transparency log from transparency-dev. <code>append()</code> hands back a signed receipt that anyone can verify offline. The log lives in ${storageWords(d)}, and Tessera’s own Go tools read it byte for byte.</p>
${installSwitcher(d.install.managers, "pm-hero")}
<div class="cta">
<a class="btn primary" href="#quick-start">Quick start ${icons.arrow}</a>
<a class="btn" href="${site.repo}">${icons.github} GitHub</a>
<a class="btn" href="${site.npm}">${icons.npm} npm</a>
</div>
<ul class="facts">
<li>ESM + types</li>
<li>${count(pkg.dependencies.length, "runtime dependency", "runtime dependencies")}</li>
<li>Node ${pkg.node.replace(/^>=\s*/, "≥ ")} · Deno · Bun · browsers · edge</li>
</ul>
<p class="independent">An independent project, not an official Google or transparency-dev project.</p>
</div>
<div class="hero-art">
${renderReceipt(receipt.text, "receipt", `returned by ${call}`)}
${receipt.tile === undefined ? "" : renderTile(receipt.tile, receipt.index)}
<div class="hero-verify">
<p class="verify-call"><code>verifyReceipt(text, { vkey, data })</code></p>
<p class="verify-ok"><span class="tick" aria-hidden="true">✓</span> Entry ${receipt.index} is in the tree of ${receipt.size}, checked offline.</p>
<p class="art-caption">A real receipt. <code>webtessera/server</code> signed it with ${custody(d)} while this page was built, over a log of the package’s ${d.sample.entries.length} entry points; the mosaic is that log’s first tile. <a href="#demo">Grow a log of your own.</a></p>
</div>
</div>
</div>
</section>`;
}
