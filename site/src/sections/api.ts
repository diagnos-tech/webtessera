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

// The full API: the faithful port of Tessera's own API underneath the safe one. First the
// README's tested regions in the order a newcomer needs them, then the package map: every
// entry point of the exports map, its Go counterpart, what it is for, and the names it
// exports with the first sentence of each one's doc comment, as the TypeScript compiler
// resolves them.

import { codeBlock, type Highlight } from "../components/code.ts";
import type { SectionSpec } from "../components/section.ts";
import type { EntryPoint } from "../data/entrypoints.ts";
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

const kindLabel: Record<string, string> = {
	function: "fn",
	class: "class",
	interface: "iface",
	type: "type",
	const: "const",
	enum: "enum",
	namespace: "ns",
};

function row(e: EntryPoint, blob: string): SafeHtml {
	return html`<li><details class="pkg">
<summary><code class="pkg-name">${e.specifier}</code><span class="pkg-desc">${inlineCode(e.summary)}</span><span class="pkg-go">${e.go === "" || e.go.startsWith("—") ? "new in webtessera" : html`Go: <code>${e.go}</code>`}</span><span class="pkg-count">${e.names.length}</span></summary>
<div class="pkg-body">
<ul class="api">${e.names.map(
		(n) =>
			html`<li class="k-${n.kind}" data-kind="${kindLabel[n.kind] ?? n.kind}"><code>${n.name}</code>${n.summary === "" ? "" : html` ${inlineCode(n.summary)}`}</li>`,
	)}</ul>
<p class="pkg-src">Source: <a href="${blob}${e.source}"><code>${e.source}</code></a></p>
</div>
</details></li>`;
}

/** api is the section on the full, ported API and the package map. */
export function api(d: SiteData, hl: Highlight): SectionSpec {
	const rendered: SafeHtml[] = [];
	for (const step of steps) {
		const snippets = step.regions.map((r) => d.snippets.get(r));
		if (snippets.some((s) => s === undefined)) {
			continue;
		}
		const first = snippets[0];
		const imports = snippets.length === 1 ? (first?.imports ?? "") : "";
		const code = [imports, ...snippets.map((s) => s?.code ?? "")].filter((c) => c !== "").join("\n\n");
		const file = first?.file ?? "";
		rendered.push(
			html`<li class="step"><div class="step-text"><span class="step-n" aria-hidden="true">${rendered.length + 1}</span><h3>${step.title}</h3><p>${inlineCode(step.text)}</p></div>${codeBlock(
				hl,
				code,
				"ts",
				{ label: `${file} · ${step.regions.join(", ")}`, href: `${d.site.blob}${file}` },
			)}</li>`,
		);
	}
	const total = d.entryPoints.reduce((n, e) => n + e.names.length, 0);
	return {
		id: "api",
		nav: "API",
		title: "The whole of Tessera’s API, underneath",
		lead: html`Underneath the safe API is the faithful port of Tessera’s own API, for everything the safe API leaves out: custom storage, migration, antispam, witness policies, Static CT, key rotation. Names follow Go’s, camelCased (<code>NewAppender</code> is <code>newAppender</code>); Go’s <code>uint64</code> is <code>bigint</code>, durations are milliseconds, errors are thrown with Go’s message text, and <code>context.Context</code> is an optional trailing <code>AbortSignal</code>.`,
		body: html`<ol class="steps">${rendered}</ol>
<h3 class="sub-title" id="packages">${d.entryPoints.length} entry points, split like Tessera’s Go packages</h3>
<p class="sub-lead">Open an entry point to see its ${total > 0 ? `${total} exports` : "API"}, each with the first sentence of its doc comment.</p>
<ul class="pkgs">${d.entryPoints.map((e) => row(e, d.site.blob))}</ul>`,
	};
}
