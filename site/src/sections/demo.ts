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

// The live demo's markup. Without JavaScript it shows the log the build created; the
// demo script (src/demo/) replaces it with a log running in the visitor's tab, using the
// same renderers, and reveals the controls.

import type { SectionSpec } from "../components/section.ts";
import type { SiteData } from "../data/index.ts";
import { html } from "../shared/html.ts";
import { renderNoteBody } from "../shared/note.ts";
import { renderEntries, renderFiles, renderInclusion, renderTiles } from "../shared/panels.ts";

/** demo is the live demo section. */
export function demo(d: SiteData): SectionSpec {
	const s = d.sample;
	const entries = s.entries.map((text, i) => ({ index: BigInt(i), text })).slice(-8);
	return {
		id: "demo",
		nav: "Live demo",
		title: "A real log, running in this tab",
		lead: "This is webtessera itself, from the same build as the package: an in-memory log with a fresh Ed25519 key, seeded with the package’s entry points. Append entries, watch the checkpoint get signed and the tiles fill, check an inclusion proof with webtessera/client, then tamper with an entry and watch the proof fail.",
		body: html`<div class="demo" data-demo data-origin="${d.site.origin}" data-seed="${JSON.stringify(s.entries)}">
<div class="demo-side">
<form class="demo-form js-only" data-demo-form>
<label for="demo-entry">New entry</label>
<div class="field"><input id="demo-entry" name="entry" maxlength="200" autocomplete="off" spellcheck="false" placeholder="hello, transparency" required disabled><button class="btn primary" type="submit" disabled>Append</button></div>
<div class="demo-actions"><button class="btn small" type="button" data-demo-add="10" disabled>+10 random</button><button class="btn small" type="button" data-demo-fill disabled>Fill the tile</button></div>
</form>
<p class="demo-status" role="status" aria-live="polite" data-demo-status>Showing the log built with this page. <span class="js-only">The live log starts when this section is on screen.</span></p>
<noscript><p class="demo-status">The live log needs JavaScript; this is the same view, rendered from a real webtessera log while the page was built.</p></noscript>
<h3 class="panel-title">Latest entries</h3>
<ol class="demo-entries" data-demo-entries>${renderEntries(entries, s.inclusion.index)}</ol>
</div>
<div class="demo-main">
<figure class="note">
<figcaption class="note-head"><span class="note-path"><span class="verb">GET</span> /checkpoint</span><span class="note-meta" data-demo-note-meta>signed at build time</span></figcaption>
<div class="note-body" translate="no" data-demo-note>${renderNoteBody(s.note)}</div>
</figure>
<div class="demo-store">
<div class="demo-tiles" data-demo-tiles>${renderTiles(s.tiles, s.inclusion.index)}</div>
<div class="demo-files-wrap"><h3 class="panel-title">Files in the store</h3><ul class="demo-files" data-demo-files>${renderFiles(s.files)}</ul><p class="demo-files-note">Every object is a tlog-tiles resource, at its path in the spec: copy them to any static host and the log is served.</p></div>
</div>
<div class="demo-proof">
<div class="proof-head"><h3 class="panel-title">Inclusion proof</h3><label class="tamper js-only"><input type="checkbox" data-demo-tamper disabled> Tamper with the entry</label></div>
<div data-demo-proof>${renderInclusion(s.inclusion, false)}</div>
</div>
</div>
</div>`,
	};
}
