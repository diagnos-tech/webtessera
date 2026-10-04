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

// Runtimes and tooling: what each runtime needs and the CI check that backs the claim,
// read from the workflows and vitest configurations; every check ci.yml runs on a change,
// read from the workflows; and the contributor commands CONTRIBUTING.md documents, run with
// the package manager package.json pins.

import type { SectionSpec } from "../components/section.ts";
import { count } from "../components/words.ts";
import type { SiteData } from "../data/index.ts";
import { html, type SafeHtml } from "../shared/html.ts";

interface RuntimeCard {
	readonly name: string;
	readonly needs: string;
	readonly entry: string;
	readonly tested: string | undefined;
}

// contributorCommands are the commands the page shows, in this order; what each does is
// CONTRIBUTING.md's wording.
const contributorCommands = [
	"bun run test:unit",
	"bun run test:browser",
	"bun run test:workers",
	"bun run interop",
	"bun run fixtures",
	"bun run check",
];

function ciBoard(d: SiteData): SafeHtml {
	const jobs = d.tests.jobs;
	const total = jobs.reduce((n, g) => n + g.jobs.length, 0);
	if (total === 0) {
		return html``;
	}
	return html`<div class="ci-board">
<h3>${count(total, "check", "checks")} on every pull request</h3>
<p>The jobs <a href="${d.site.blob}.github/workflows/ci.yml"><code>ci.yml</code></a> runs, read from the workflows when this page was built.${
		d.tests.gate === undefined
			? ""
			: html` A last job, <code>${d.tests.gate}</code>, fails if any of them fails${d.tests.releaseGated ? ", and a release runs the same workflow before it publishes" : ""}.`
	}</p>
<ul class="ci-groups">${jobs.map(
		(g) =>
			html`<li class="ci-row"><a class="ci-group" href="${d.site.blob}${g.file}">${g.name}</a><ul class="ci-jobs">${g.jobs.map((j) => html`<li class="ci-job">${j}</li>`)}</ul></li>`,
	)}</ul>
</div>`;
}

function contributing(d: SiteData): SafeHtml {
	const commands = contributorCommands
		.map((c) => d.contributing.commands.find((x) => x.command === c))
		.filter((c) => c !== undefined);
	if (commands.length === 0) {
		return html``;
	}
	const pm = d.contributing.packageManager.split("@")[0] ?? "";
	return html`<div class="contrib">
<h3>Contributing</h3>
<p>The repository uses ${pm === "" ? "its package manager" : html`<strong>${pm[0]?.toUpperCase()}${pm.slice(1)}</strong> (<code>${d.contributing.packageManager}</code>)`} to install and run every script; the suites themselves run on Node, Chromium and workerd. <a href="${d.site.blob}CONTRIBUTING.md">CONTRIBUTING.md</a> has the rest.</p>
<dl class="commands">${commands.map((c) => html`<div><dt><code class="cmd">${c?.command}</code></dt><dd>${c?.does}</dd></div>`)}</dl>
</div>`;
}

/** runtimes is the runtime-support and tooling section. */
export function runtimes(d: SiteData): SectionSpec {
	const t = d.tests;
	const smoke = (r: string) => (t.runtimes.includes(r) ? "smoke test of the built package" : undefined);
	const node = [
		t.nodeVersions.length > 0 ? `full test suite on Node ${t.nodeVersions.join(", ")}` : undefined,
		smoke("node"),
	].filter((x) => x !== undefined);
	const cards: readonly RuntimeCard[] = [
		{
			name: "Node.js",
			needs: `Node ${d.pkg.node.replace(/^>=\s*/, "")} or later`,
			entry: "webtessera/server",
			tested: node.length > 0 ? node.join("; ") : undefined,
		},
		{ name: "Deno", needs: "Deno 2", entry: "webtessera/server", tested: smoke("deno") },
		{ name: "Bun", needs: "Bun 1", entry: "webtessera/server", tested: smoke("bun") },
		{
			name: "Browsers",
			needs: "current browsers; IndexedDB and Web Locks for a durable log, in a secure context",
			entry: "webtessera/browser",
			tested: t.chromium ? "test suites in a real Chromium" : undefined,
		},
		{
			name: "Cloudflare Workers",
			needs: "workerd; storage on D1, a SQLite-backed Durable Object, or any SQLite reachable over fetch",
			entry: "webtessera/server",
			tested: t.workerd ? "test suites inside workerd" : undefined,
		},
		{
			name: "Other edge runtimes",
			needs: "ES2022, WebCrypto and, to serve or fetch logs, the Fetch API",
			entry: "webtessera/server",
			tested: undefined,
		},
	];
	return {
		id: "runtimes",
		nav: "Runtimes",
		title: "Runs wherever modern JavaScript runs",
		lead: html`ES2022 modules with type declarations, no Node built-ins, and ${count(d.pkg.dependencies.length, "audited runtime dependency", "audited runtime dependencies")}: ${d.pkg.dependencies.map((p, i) => html`${i === 0 ? "" : " and "}<code>${p}</code>`)}. A check marks a claim that CI tests on every change.`,
		body: html`<ul class="cards runtimes">${cards.map(
			(c) => html`<li class="card runtime${c.tested === undefined ? "" : " tested"}">
<h3>${c.name}</h3>
<p>${c.needs}</p>
<p class="runtime-entry"><code>${c.entry}</code></p>
<p class="tested-line">${c.tested === undefined ? "Expected to work; not tested in CI." : html`<span class="visually-hidden">Tested in CI: </span>${c.tested}`}</p>
</li>`,
		)}</ul>
<div class="tooling">
${ciBoard(d)}
${contributing(d)}
</div>`,
	};
}
