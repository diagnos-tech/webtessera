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

// What a transparency log is, in five ideas and one picture.

import type { SectionSpec } from "../components/section.ts";
import { merkleTree } from "../components/tree.ts";
import type { SiteData } from "../data/index.ts";
import { html } from "../shared/html.ts";

const ideas: readonly { title: string; text: string; spec?: [string, string] }[] = [
	{
		title: "Entries become leaves",
		text: "Each entry is hashed into a Merkle tree. Change a single byte of any entry and the root hash changes.",
		spec: ["RFC 6962", "https://www.rfc-editor.org/rfc/rfc6962#section-2.1"],
	},
	{
		title: "Checkpoints commit",
		text: "The log regularly signs its size and root hash. That signed checkpoint commits to every entry before it, forever.",
		spec: ["C2SP signed-note", "https://c2sp.org/signed-note"],
	},
	{
		title: "Proofs replace trust",
		text: "An inclusion proof shows an entry is under a checkpoint; a consistency proof shows a newer checkpoint extends an older one. Each is a few dozen hashes, at most.",
	},
	{
		title: "Tiles make it cheap",
		text: "The tree is stored as immutable tiles of 256 hashes. They are static files: any CDN, bucket or browser cache can serve them.",
		spec: ["C2SP tlog-tiles", "https://c2sp.org/tlog-tiles"],
	},
	{
		title: "Witnesses keep it honest",
		text: "Independent witnesses cosign checkpoints they have checked for consistency, so a log cannot show different histories to different readers.",
		spec: ["C2SP tlog-witness", "https://c2sp.org/tlog-witness"],
	},
];

/** why is the section explaining transparency logs. */
export function why(_d: SiteData): SectionSpec {
	return {
		id: "why",
		nav: "Why",
		title: "An append-only log that anyone can check",
		lead: "A transparency log is a tamper-evident record. Its operator can add entries but cannot remove, reorder or rewrite them unnoticed, because every reader can check two things alone: that an entry is in the log, and that today’s log extends yesterday’s. Certificate Transparency, the Go checksum database and Sigstore’s signature log all work this way.",
		body: html`<div class="why-grid">
<ol class="ideas">${ideas.map(
			(idea, i) =>
				html`<li><span class="idea-n" aria-hidden="true">${i}</span><div><h3>${idea.title}</h3><p>${idea.text}${
					idea.spec === undefined ? "" : html` <a class="spec" href="${idea.spec[1]}">${idea.spec[0]}</a>`
				}</p></div></li>`,
		)}</ol>
<figure class="tree-figure">
<div class="tree-scroll" tabindex="0" role="group" aria-label="Merkle tree diagram (scrollable)">${merkleTree(5)}</div>
<figcaption><span class="key key-path">path</span> <span class="key key-proof">proof</span> Proving entry 5 takes three hashes, not eight entries: the siblings of its path to the root. A log of a billion entries needs thirty.</figcaption>
</figure>
</div>`,
	};
}
