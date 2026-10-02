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

// Compatibility and fidelity, as the repository records it: the porting map drawn as a
// mosaic (one cell per upstream Go file), the decision records, the golden fixtures and
// what CI checks. Every number is counted at build time.

import type { SectionSpec } from "../components/section.ts";
import { count, list } from "../components/words.ts";
import type { SiteData } from "../data/index.ts";
import { countByStatus, type PortingRow } from "../data/porting.ts";
import { html, type SafeHtml } from "../shared/html.ts";

function statusClass(status: string): string {
	return `st-${status.replace(/\s+/g, "-").toLowerCase()}`;
}

function mosaic(title: string, rows: readonly PortingRow[], unit: string): SafeHtml {
	const counts = countByStatus(rows);
	const summary = counts.map((c) => `${c.count} ${c.status}`).join(", ");
	return html`<figure class="port">
<figcaption><span class="port-title">${title}</span><span class="port-count">${rows.length} ${unit}</span></figcaption>
<div class="port-grid" role="img" aria-label="${title}: ${summary}">${rows.map(
		(r) => html`<i class="${statusClass(r.status)}" title="${r.go}: ${r.status}"></i>`,
	)}</div>
<ul class="legend">${counts.map(
		(c) => html`<li><i class="${statusClass(c.status)}" aria-hidden="true"></i>${c.count} ${c.status}</li>`,
	)}</ul>
</figure>`;
}

/** fidelity is the compatibility and fidelity section. */
export function fidelity(d: SiteData): SectionSpec {
	const { porting, decisions, fixtures, tests, site } = d;
	const short = porting.commit.slice(0, 7);
	const runtimes = ["Node.js", ...(tests.chromium ? ["Chromium"] : []), ...(tests.workerd ? ["workerd"] : [])];
	const runtimeName: Record<string, string> = { node: "Node.js", chromium: "Chromium", workerd: "workerd" };
	const order = Object.keys(runtimeName);
	const golden = Object.entries(tests.golden)
		.filter(([r]) => r in runtimeName)
		.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
	const checks: SafeHtml[] = [
		html`<li><strong>Golden fixtures from the real Tessera.</strong> ${fixtures.files.length} fixture files recorded by running Tessera at <code>${short}</code>${
			fixtures.logSizes.length > 0
				? `, including complete logs of ${list(fixtures.logSizes.map(String))} entries written by its POSIX driver`
				: ""
		}. Tests compare tiles, entry bundles, checkpoints, proofs and notes byte for byte${tests.fixturesReproduced ? ", and CI regenerates the fixtures from upstream and fails on any difference" : ""}.</li>`,
	];
	if (golden.length > 0) {
		checks.push(
			html`<li><strong>Byte-for-byte on every runtime.</strong> Golden log tests run in ${list(golden.map(([r, n]) => `${runtimeName[r] ?? r} (${count(n, "suite")})`))}: each storage backend must write exactly the bytes Tessera writes.</li>`,
		);
	}
	if (tests.interop) {
		checks.push(
			html`<li><strong>Go and TypeScript interoperate, both ways.</strong> In CI, Tessera’s Go code reads and verifies logs webtessera wrote, and webtessera reads and verifies logs Tessera wrote.</li>`,
		);
	}
	checks.push(
		html`<li><strong>A translation, reviewable line by line.</strong> Each source file mirrors the upstream file of the same name, with its comments carried over. Every divergence, however small, and every file not ported has a decision record.</li>`,
	);
	const stats: readonly [string, string, string][] = [
		[String(porting.files), "upstream Go files, each with a row", `${site.blob}docs/PORTING-MAP.md`],
		[String(decisions.total), "decision records", `${site.tree}docs/decisions`],
		[String(fixtures.files.length), "golden fixture files", `${site.tree}fixtures`],
		[String(runtimes.length), `runtimes the suites run in: ${list(runtimes)}`, `${site.tree}.github/workflows`],
	];
	return {
		id: "fidelity",
		nav: "Fidelity",
		title: "Faithful to Tessera, byte for byte",
		lead: html`webtessera is a translation of <a href="${porting.upstream}/tree/${porting.commit}">Tessera at <code>${short}</code></a>, not a reimplementation. A log written by one is read and verified by the other.`,
		body: html`<ul class="stats">${stats.map(
			([n, label, href]) =>
				html`<li><a href="${href}"><span class="stat-n">${n}</span><span class="stat-l">${label}</span></a></li>`,
		)}</ul>
<div class="fidelity-grid">
<div class="ports">
${mosaic(`Tessera @ ${short}`, porting.tessera, "rows")}
${porting.dependencies.length === 0 ? "" : mosaic("Its Go dependencies", porting.dependencies, "rows")}
<p class="port-note">One cell per row of <a href="${site.blob}docs/PORTING-MAP.md">docs/PORTING-MAP.md</a>. Decision records: ${decisions.byStatus.map((s, i) => html`${i === 0 ? "" : ", "}${s.count} ${s.status}`)}.</p>
</div>
<ul class="checks">${checks}</ul>
</div>`,
	};
}
