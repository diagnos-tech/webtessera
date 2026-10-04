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

// Quick start: the safe API, webtessera/server and webtessera/browser. What each entry point
// is for, what it refuses and how a browser build is kept away from the server one are read
// from the repository (data/safe.ts); the steps are the README's tested regions, shown with
// the imports they use from the same test file. A step whose region README.md no longer
// embeds is left out rather than shown stale.

import { codeBlock, type Highlight } from "../components/code.ts";
import { installSwitcher } from "../components/install.ts";
import type { SectionSpec } from "../components/section.ts";
import { list } from "../components/words.ts";
import type { SiteData } from "../data/index.ts";
import type { Snippet } from "../data/readme.ts";
import type { SafeEntry } from "../data/safe.ts";
import { html, inlineCode, type SafeHtml } from "../shared/html.ts";

interface Step {
	readonly title: string;
	readonly text: (d: SiteData) => string;
	readonly region: string;
}

const steps: readonly Step[] = [
	{
		title: "On a server: a log in SQLite",
		text: () =>
			"Import the key from your secret store into a non-extractable WebCrypto key, and say where the log is kept: any SQLite adapter, an `ObjectStore` of your own, or memory if you ask for it by name. `append()` resolves once a published checkpoint covers the entry, with a receipt it has already verified.",
		region: "safe_server_example",
	},
	{
		title: "In a browser: a device key and IndexedDB",
		text: () =>
			"`openDeviceKey` generates an Ed25519 key on first use and keeps the `CryptoKey` itself in IndexedDB, so no script can export it. Every tab of the page’s origin shares the key and the log; Web Locks make their writes take turns.",
		region: "safe_browser_example",
	},
	{
		title: "Verify a receipt, anywhere, offline",
		text: (d) =>
			`A receipt is a C2SP tlog-proof: the entry’s index, its inclusion proof and the signed checkpoint. \`verifyReceipt\` needs nothing but the receipt, the log’s vkey and the entry. When a check fails it throws a \`ReceiptError\` whose reason is ${list(d.safe.receiptReasons.map((r) => `\`${r}\``)).replace(/ and /, " or ")}.`,
		region: "safe_verify_example",
	},
];

/** guardLine says how the entry point keeps to its environment, from the exports map. */
function guardLine(e: SafeEntry): SafeHtml {
	if (e.guardConditions.length > 0) {
		const code = (cs: readonly string[]) =>
			cs.map((c, i) => html`${i === 0 ? "" : i === cs.length - 1 ? " and " : ", "}<code>${c}</code>`);
		return html`Under the ${code(e.guardConditions)} export conditions it resolves to a module that fails the build${
			e.serverConditions.length > 0 ? html`; ${code(e.serverConditions)} get the real one` : ""
		}.`;
	}
	return html`Takes no private-key string, ever, so it is safe to import anywhere.`;
}

function envCard(e: SafeEntry, d: SiteData): SafeHtml {
	const where = e.specifier.endsWith("/server") ? "server" : "browser";
	return html`<li class="card env env-${where}">
<h3><code class="env-name">${e.specifier}</code></h3>
<dl class="card-facts">
<div><dt>Runs in</dt><dd>${e.runsIn}</dd></div>
<div><dt>Holds</dt><dd>${e.holds}</dd></div>
<div><dt>Guard</dt><dd>${guardLine(e)}</dd></div>
</dl>
${
	e.refuses.length === 0
		? ""
		: html`<div class="refuses"><p class="refuses-title">It will not let you</p><ul>${e.refuses.map(
				(r) => html`<li>${r.title.replace(/\.$/, "")}</li>`,
			)}</ul></div>`
}
<p class="env-exports"><a href="${d.site.blob}${e.source}">Exports</a> ${e.functions.map((f, i) => html`${i === 0 ? "" : " "}<code>${f}</code>`)}</p>
</li>`;
}

function snippetCode(s: Snippet): string {
	return s.imports === "" ? s.code : `${s.imports}\n\n${s.code}`;
}

/** quickstart is the getting-started section: the safe API. */
export function quickstart(d: SiteData, hl: Highlight): SectionSpec {
	const rendered: SafeHtml[] = [
		html`<li class="step"><div class="step-text"><span class="step-n" aria-hidden="true">0</span><h3>Install</h3><p>One package, ESM with type declarations, for every runtime. Pick your package manager.</p></div>${installSwitcher(d.install.managers, "pm-start")}</li>`,
	];
	const files = new Set<string>();
	for (const step of steps) {
		const s = d.snippets.get(step.region);
		if (s === undefined) {
			continue;
		}
		files.add(s.file);
		rendered.push(
			html`<li class="step"><div class="step-text"><span class="step-n" aria-hidden="true">${rendered.length}</span><h3>${step.title}</h3><p>${inlineCode(step.text(d))}</p></div>${codeBlock(
				hl,
				snippetCode(s),
				"ts",
				{ label: `${s.file} · ${s.region}`, href: `${d.site.blob}${s.file}` },
			)}</li>`,
		);
	}
	const fileLinks = [...files].map(
		(f, i) => html`${i === 0 ? "" : ", "}<a href="${d.site.blob}${f}"><code>${f}</code></a>`,
	);
	return {
		id: "quick-start",
		nav: "Quick start",
		title: "Start with the safe API",
		lead: html`Two entry points say where your code runs, and refuse the mistakes that are easy to make with a transparency log. Every snippet is a region of ${fileLinks}, which CI runs on every change, shown with the imports it uses from the same file.`,
		body: html`<ul class="cards envs">${d.safe.entries.map((e) => envCard(e, d))}</ul>
<ol class="steps">${rendered}</ol>
<p class="section-next">Custom storage, migration, antispam, witness policies or Static CT? Every log exposes the ported <code>log.reader</code> and <code>log.appender</code>: see <a href="#api">the full API</a>, and the <a href="${d.site.blob}docs/guides/safe-api.md">safe API guide</a> for key custody, witnesses and use cases.</p>`,
	};
}
