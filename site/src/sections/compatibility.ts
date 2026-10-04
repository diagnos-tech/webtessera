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

// Compatibility with Tessera, as the repository proves it: the golden fixtures recorded
// from the real Tessera, the golden suite on every backend and runtime, the Go interop
// harness, the differential corpora and test parity, then the porting map drawn as a mosaic
// (one cell per upstream Go file) with the decision records. Every number is counted while
// the page builds; a check is claimed as CI's only when a workflow runs it.

import type { SectionSpec } from "../components/section.ts";
import { count, list } from "../components/words.ts";
import { runtimeOrder } from "../data/evidence.ts";
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

function capitalise(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** goldenMatrix draws which backend runs the golden suite in which runtime. */
function goldenMatrix(d: SiteData): SafeHtml {
	const { golden, webCrypto } = d.evidence;
	const rows = [...golden, ...(webCrypto.length > 0 ? [{ backend: "WebCrypto keys", runtimes: webCrypto }] : [])];
	const columns = runtimeOrder.filter((r) => rows.some((row) => row.runtimes.includes(r)));
	return html`<figure class="matrix">
<figcaption id="golden-matrix">Byte for byte against Tessera’s own files: each backend, in each runtime it supports</figcaption>
<div class="matrix-scroll">
<table aria-labelledby="golden-matrix">
<thead><tr><th scope="col">Backend</th>${columns.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
<tbody>${rows.map(
		(r) =>
			html`<tr><th scope="row">${r.backend}</th>${columns.map((c) =>
				r.runtimes.includes(c)
					? html`<td class="yes"><span aria-hidden="true">✓</span><span class="visually-hidden">yes</span></td>`
					: html`<td class="no"><span aria-hidden="true">·</span><span class="visually-hidden">no</span></td>`,
			)}</tr>`,
	)}</tbody>
</table>
</div>
${webCrypto.length > 0 ? html`<p class="matrix-note">The last row replays Go’s signed notes and checkpoints through non-extractable WebCrypto keys: Ed25519 is deterministic, so they must match to the byte.</p>` : ""}
</figure>`;
}

/** compatibility is the compatibility-evidence section. */
export function compatibility(d: SiteData): SectionSpec {
	const { porting, decisions, fixtures, tests, site, evidence } = d;
	const short = porting.commit.slice(0, 7);
	const fmt = (n: number) => n.toLocaleString("en-US");
	const checks: SafeHtml[] = [
		html`<li><strong>Golden fixtures from the real Tessera.</strong> ${count(fixtures.files.length, "fixture file")} recorded by running Tessera at <code>${short}</code>${
			fixtures.logSizes.length > 0
				? `, including complete logs of ${list(fixtures.logSizes.map(String))} entries written by its POSIX driver`
				: ""
		}. Tests compare tiles, entry bundles, checkpoints, proofs and notes byte for byte${tests.fixturesReproduced ? ", and CI regenerates the fixtures from upstream and fails on any difference" : ""}.</li>`,
	];
	if (evidence.golden.length > 0) {
		checks.push(
			html`<li><strong>The golden suite, on every backend.</strong> ${capitalise(count(evidence.golden.length, "storage backend"))} must store exactly the files Tessera’s POSIX driver stores for the fixture logs, in one batch, in batches, across restarts, and when carrying on a log Go wrote.</li>`,
		);
	}
	if (tests.interop && evidence.interop.length > 0) {
		checks.push(
			html`<li><strong>Go and TypeScript interoperate, both ways.</strong> In CI, Tessera’s own Go code verifies, reproduces byte for byte and carries on logs webtessera wrote, and webtessera does the same with Go’s, on ${list(evidence.interop)}.</li>`,
		);
	}
	if (evidence.corpora.length > 0) {
		checks.push(
			html`<li><strong>Differential corpora.</strong> Go’s verdict, error text and output on ${fmt(evidence.differentialRecords)} generated inputs, most of them malformed${evidence.everyCodePoint ? ", and on every Unicode code point" : ""}, in ${count(evidence.corpora.length, "corpus", "corpora")} replayed in ${list(evidence.differentialRuntimes)}. Every difference is a named divergence with a decision record, or a failure.</li>`,
		);
	}
	if (tests.parity) {
		checks.push(
			html`<li><strong>Test parity with upstream.</strong> Every Go test, example, fuzz target and benchmark of Tessera and its vendored modules must have a passing TypeScript test of the same name, or an allow-list entry that cites the decision record leaving it out (${count(evidence.parity.entries, "entry", "entries")}, citing ${count(evidence.parity.adrs, "record")}). CI fails on any other.</li>`,
		);
	}
	checks.push(
		html`<li><strong>A translation, reviewable line by line.</strong> Each source file mirrors the upstream file of the same name, with its comments carried over. Every divergence, however small, and every file not ported has a decision record.</li>`,
	);
	const stats: readonly [string, string, string][] = [
		[
			String(fixtures.files.length),
			`golden fixture files, recorded from Go Tessera @ ${short}`,
			`${site.tree}fixtures`,
		],
		[
			fmt(evidence.differentialRecords),
			`differential cases from Go, replayed in ${list(evidence.differentialRuntimes)}`,
			`${site.tree}src/testonly/testing/differential`,
		],
		[
			String(evidence.golden.length),
			"storage backends held to Tessera’s bytes by the golden suite",
			`${site.blob}src/storage/objectstore/testing/golden.ts`,
		],
		[String(evidence.interop.length), "backends in the Go interop harness, both ways", `${site.tree}interop`],
	];
	return {
		id: "compatibility",
		nav: "Compatibility",
		title: "Faithful to Tessera, byte for byte",
		lead: html`webtessera is a translation of <a href="${porting.upstream}/tree/${porting.commit}">Tessera at <code>${short}</code></a>, not a reimplementation. A log written by one is read, verified and carried on by the other, and every claim below is checked on every change. <a href="${site.blob}docs/compatibility.md">How it is proven, and how to reproduce it</a>.`,
		body: html`<ul class="stats">${stats.map(
			([n, label, href]) =>
				html`<li><a href="${href}"><span class="stat-n">${n}</span><span class="stat-l">${label}</span></a></li>`,
		)}</ul>
<div class="fidelity-grid">
<ul class="checks">${checks}</ul>
<div class="ports">
${goldenMatrix(d)}
${mosaic(`Tessera @ ${short}`, porting.tessera, "rows")}
${porting.dependencies.length === 0 ? "" : mosaic("Its Go dependencies", porting.dependencies, "rows")}
<p class="port-note">One cell per row of <a href="${site.blob}docs/PORTING-MAP.md">docs/PORTING-MAP.md</a>. <a href="${site.tree}docs/decisions">${decisions.total} decision records</a>: ${decisions.byStatus.map((s, i) => html`${i === 0 ? "" : ", "}${s.count} ${s.status}`)}.</p>
</div>
</div>`,
	};
}
