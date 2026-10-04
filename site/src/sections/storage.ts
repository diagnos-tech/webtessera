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

// Storage: one card per storage entry point the package exports (its row of README.md's
// driver table, and its own package comment), the SQLite engines with their default locking
// and whether the driver's own tests run them, how locking fails closed, and the README's
// tested storage snippets. Engines are listed alphabetically within each group, so no
// vendor comes first.

import { codeBlock, type Highlight } from "../components/code.ts";
import type { SectionSpec } from "../components/section.ts";
import { count } from "../components/words.ts";
import type { SqliteEngine } from "../data/engines.ts";
import type { SiteData } from "../data/index.ts";
import { html, inlineCode, type SafeHtml } from "../shared/html.ts";

const order = ["memory", "indexeddb", "sqlite", "objectstore"];

function rank(specifier: string): number {
	const i = order.indexOf(specifier.split("/").pop() ?? "");
	return i < 0 ? order.length : i;
}

function engines(list: readonly SqliteEngine[]): SafeHtml {
	const groups = [...new Set(list.map((e) => e.group))];
	const tested = list.filter((e) => e.tested).length;
	return html`<div class="engines">
<div class="engines-head"><h3>One SQLite driver, any SQLite engine</h3>
<p>The same driver keeps a log in five tables of an ordinary database, through a small adapter per engine; the adapters are typed structurally, so webtessera depends on none of them, and any other SQLite plugs in by implementing <code>SqlDatabase</code>. The driver’s own test suite runs ${count(tested, "of these engines", "of these engines")}, marked ✓.</p></div>
<div class="engine-groups">${groups.map(
		(g) =>
			html`<div class="engine-group"><h4>${g}</h4><ul>${list
				.filter((e) => e.group === g)
				.map(
					(e) =>
						html`<li class="chip${e.tested ? " tested" : ""}"><span class="chip-name">${e.name}</span><span class="chip-where">${e.where}${
							e.adapter === undefined ? "" : html` · <code>${e.adapter}()</code>`
						}</span>${e.locking === undefined ? "" : html`<span class="chip-lock"><span class="lock-k">locking</span> ${e.locking}</span>`}${
							e.tested ? html`<span class="visually-hidden"> (tested)</span>` : ""
						}</li>`,
				)}</ul></div>`,
	)}</div>
</div>`;
}

/** locking explains how the stores keep several writers from forking a log. */
function locking(d: SiteData): SafeHtml {
	return html`<div class="locking">
<h3>Locking fails closed</h3>
<ul class="lock-modes">
<li><span class="lock-mode">lease</span><p>The default wherever another process, connection or instance could open the database. Each lock is a lease renewed while it is held, and every write made under it is fenced on it in the same transaction, so a writer that stalled past its lease can never overwrite the next holder’s work.</p></li>
<li><span class="lock-mode">local</span><p>Locks kept in memory: the default only where the database is private (in memory, a Durable Object’s own storage), or when you declare with <code>locking: "local"</code> that this process is the only writer.</p></li>
<li><span class="lock-mode">Web Locks</span><p>IndexedDB logs are shared between tabs through Web Locks. Without them, opening the log throws, unless you pass <code>singleWriter: true</code>.</p></li>
</ul>
<p class="lock-more">How each backend behaves, and what to pick: <a href="${d.site.blob}docs/guides/choosing-storage.md">choosing storage</a>.</p>
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
	const snippets = [...d.snippets.values()].filter((s) => /indexeddb|sqlite/i.test(s.region));
	return {
		id: "storage",
		nav: "Storage",
		title: "Keep the log in the storage you already have",
		lead: html`Every backend runs the same storage engine, a port of Tessera’s POSIX driver, over a key/value contract of ${count(d.objectStoreMethods.length, "method")}: ${methods}. Whatever the backend, what it holds is a static tlog-tiles log (<code>checkpoint</code>, <code>tile/0/000</code>, <code>tile/entries/000</code>, …), ready to be served over HTTP as it is.`,
		body: html`<ul class="cards drivers">${drivers.map((e) => {
			const row = d.storage.find((r) => r.specifier === e.specifier);
			return html`<li class="card">
<h3>${row?.name ?? e.specifier.split("/").pop()}</h3>
<p class="card-import"><code>${e.specifier}</code></p>
<p>${inlineCode(e.summary)}</p>
${row === undefined ? "" : html`<dl class="card-facts"><div><dt>Runs in</dt><dd>${row.runsIn}</dd></div><div><dt>Keeps the log</dt><dd>${row.persistence}</dd></div></dl>`}
</li>`;
		})}</ul>
${d.entryPoints.some((e) => e.specifier === "webtessera/storage/sqlite") ? engines(d.sqliteEngines) : ""}
${locking(d)}
${
	snippets.length === 0
		? ""
		: html`<h3 class="sub-title">With the full API</h3><div class="storage-code">${snippets.map((s) =>
				codeBlock(hl, s.imports === "" ? s.code : `${s.imports}\n\n${s.code}`, "ts", {
					label: `${s.file} · ${s.region}`,
					href: `${d.site.blob}${s.file}`,
				}),
			)}</div>`
}`,
	};
}
