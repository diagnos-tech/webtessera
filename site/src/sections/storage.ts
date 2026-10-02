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

// Storage: one card per storage entry point the package exports (described by its
// own package comment), the SQLite engines when the SQLite driver exists, and the
// README's tested storage snippets.

import { codeBlock, type Highlight } from "../components/code.ts";
import type { SectionSpec } from "../components/section.ts";
import { count } from "../components/words.ts";
import type { SqliteEngine } from "../data/engines.ts";
import type { SiteData } from "../data/index.ts";
import { html, inlineCode, type SafeHtml } from "../shared/html.ts";

interface DriverFacts {
	readonly name: string;
	readonly runs: string;
	readonly keeps: string;
}

// facts are what a card says beyond the package comment; unknown drivers get a plain card.
const facts: Readonly<Record<string, DriverFacts>> = {
	"webtessera/storage/memory": { name: "Memory", runs: "anywhere", keeps: "nothing: tests, demos, ephemeral logs" },
	"webtessera/storage/indexeddb": {
		name: "IndexedDB",
		runs: "browsers, web and service workers",
		keeps: "durably; tabs share one log through Web Locks",
	},
	"webtessera/storage/sqlite": {
		name: "SQLite",
		runs: "servers, edge runtimes and browsers",
		keeps: "durably, in the SQLite engine you choose",
	},
	"webtessera/storage/objectstore": {
		name: "Your own store",
		runs: "wherever your store runs",
		keeps: "as your store does",
	},
};

const order = ["memory", "indexeddb", "sqlite", "objectstore"];

function rank(specifier: string): number {
	const i = order.indexOf(specifier.split("/").pop() ?? "");
	return i < 0 ? order.length : i;
}

function engines(list: readonly SqliteEngine[]): SafeHtml {
	const groups = [...new Set(list.map((e) => e.group))];
	return html`<div class="engines">
<h3>One SQLite driver, many engines</h3>
<p>The same driver keeps a log in any of these, through a small adapter for each. A check marks the engines the driver’s own test suite runs against.</p>
<div class="engine-groups">${groups.map(
		(g) =>
			html`<div class="engine-group"><h4>${g}</h4><ul>${list
				.filter((e) => e.group === g)
				.map(
					(e) =>
						html`<li class="chip${e.tested ? " tested" : ""}"><span class="chip-name">${e.name}</span><span class="chip-where">${e.where}${
							e.adapter === undefined ? "" : html` · <code>${e.adapter}()</code>`
						}</span>${e.tested ? html`<span class="visually-hidden"> (tested)</span>` : ""}</li>`,
				)}</ul></div>`,
	)}</div>
</div>`;
}

/** storage is the storage section. */
export function storage(d: SiteData, hl: Highlight): SectionSpec {
	const drivers = d.entryPoints
		.filter((e) => e.specifier.includes("/storage/"))
		.sort((a, b) => rank(a.specifier) - rank(b.specifier));
	const methods = d.objectStoreMethods.map((m, i) => {
		const sep = i === 0 ? "" : i === d.objectStoreMethods.length - 1 ? " and " : ", ";
		return html`${sep}<code>${m}</code>`;
	});
	const snippets = [...d.snippets.values()].filter((s) => /indexeddb|sqlite|objectstore/i.test(s.region));
	return {
		id: "storage",
		nav: "Storage",
		title: "Your storage, one engine",
		lead: html`Every driver runs the same storage engine, a port of Tessera’s POSIX driver, over a key/value contract of ${count(d.objectStoreMethods.length, "method")}: ${methods}. Whatever the backend, what it holds is a static tlog-tiles log (<code>checkpoint</code>, <code>tile/0/000</code>, <code>tile/entries/000</code>, …) ready to be served over HTTP as it is.`,
		body: html`<ul class="cards drivers">${drivers.map((e) => {
			const f = facts[e.specifier];
			return html`<li class="card">
<h3>${f?.name ?? e.specifier.split("/").pop()}</h3>
<p class="card-import"><code>${e.specifier}</code></p>
<p>${inlineCode(e.summary)}</p>
${f === undefined ? "" : html`<dl class="card-facts"><div><dt>Runs in</dt><dd>${f.runs}</dd></div><div><dt>Keeps the log</dt><dd>${f.keeps}</dd></div></dl>`}
</li>`;
		})}</ul>
${d.entryPoints.some((e) => e.specifier === "webtessera/storage/sqlite") ? engines(d.sqliteEngines) : ""}
${snippets.length === 0 ? "" : html`<div class="storage-code">${snippets.map((s) => codeBlock(hl, s.code, "ts", { label: `${s.file} · ${s.region}`, href: `${d.site.blob}${s.file}` }))}</div>`}`,
	};
}
