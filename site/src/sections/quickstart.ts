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

// Quick start: install, then the README's tested regions in the order a newcomer needs
// them. A step whose region README.md no longer embeds is left out rather than shown
// stale.

import { codeBlock, type Highlight } from "../components/code.ts";
import type { SectionSpec } from "../components/section.ts";
import type { SiteData } from "../data/index.ts";
import { html, inlineCode, type SafeHtml } from "../shared/html.ts";

interface Step {
	readonly title: string;
	readonly text: string;
	readonly regions: readonly string[];
}

const steps: readonly Step[] = [
	{
		title: "Generate the log’s key",
		text: "A log signs its checkpoints with a signed-note key, whose name is the log’s origin. Publish the verifier key so that anyone can check what the log signs.",
		regions: ["create_signer_example"],
	},
	{
		title: "Start an appender",
		text: "Pick a storage driver and start an appender on it. The appender batches entries, integrates them into the tree and publishes checkpoints on a timer.",
		regions: ["common_imports", "construct_example"],
	},
	{
		title: "Append, then wait for the checkpoint",
		text: "`appender.add()` resolves once the entry is durably sequenced. A `PublicationAwaiter` resolves once a signed checkpoint commits to it, which is when you can hand out a proof.",
		regions: ["await_publication_example"],
	},
	{
		title: "Verify it, from anywhere",
		text: "`webtessera/client` reads any tlog-tiles log, whether webtessera, Tessera or another implementation wrote it, and checks every signature and hash it reads.",
		regions: ["verify_example"],
	},
];

/** quickstart is the getting-started section. */
export function quickstart(d: SiteData, hl: Highlight): SectionSpec {
	const rendered: SafeHtml[] = [
		html`<li class="step"><div class="step-text"><span class="step-n" aria-hidden="true">0</span><h3>Install</h3><p>One package, ESM with type declarations, for every runtime.</p></div>${codeBlock(hl, d.install.command, "sh", { label: "terminal" })}</li>`,
	];
	const files = new Set<string>();
	for (const step of steps) {
		const snippets = step.regions.map((r) => d.snippets.get(r));
		if (snippets.some((s) => s === undefined)) {
			continue;
		}
		const code = snippets.map((s) => s?.code ?? "").join("\n\n");
		const file = snippets[0]?.file ?? "";
		files.add(file);
		rendered.push(
			html`<li class="step"><div class="step-text"><span class="step-n" aria-hidden="true">${rendered.length}</span><h3>${step.title}</h3><p>${inlineCode(step.text)}</p></div>${codeBlock(
				hl,
				code,
				"ts",
				{ label: `${file} · ${step.regions.join(", ")}`, href: `${d.site.blob}${file}` },
			)}</li>`,
		);
	}
	const fileLinks = [...files].map(
		(f, i) => html`${i === 0 ? "" : ", "}<a href="${d.site.blob}${f}"><code>${f}</code></a>`,
	);
	return {
		id: "quick-start",
		nav: "Quick start",
		title: "From install to a verified proof",
		lead: html`Every snippet below is a region of ${fileLinks}, which CI compiles and runs on every change, and which README.md is checked against. The code on this page is code that works.`,
		body: html`<ol class="steps">${rendered}</ol>`,
	};
}
