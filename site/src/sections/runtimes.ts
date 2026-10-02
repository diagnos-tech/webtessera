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

// Runtime support: what each runtime needs, and the CI check that backs the claim,
// read from the workflows and vitest configurations.

import type { SectionSpec } from "../components/section.ts";
import { count } from "../components/words.ts";
import type { SiteData } from "../data/index.ts";
import { html } from "../shared/html.ts";

interface RuntimeCard {
	readonly name: string;
	readonly needs: string;
	readonly tested: string | undefined;
}

/** runtimes is the runtime-support section. */
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
			tested: node.length > 0 ? node.join("; ") : undefined,
		},
		{ name: "Deno", needs: "Deno 2", tested: smoke("deno") },
		{ name: "Bun", needs: "Bun 1", tested: smoke("bun") },
		{
			name: "Browsers",
			needs: "current browsers; IndexedDB and Web Locks for the IndexedDB driver",
			tested: t.chromium ? "test suites in a real Chromium" : undefined,
		},
		{
			name: "Workers",
			needs: "Cloudflare Workers and other runtimes built on workerd",
			tested: t.workerd ? "test suites inside workerd" : undefined,
		},
		{
			name: "Other edge runtimes",
			needs: "ES2022 and, to serve or fetch logs, the Fetch API",
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
<p class="tested-line">${c.tested === undefined ? "Expected to work; not tested in CI." : html`<span class="visually-hidden">Tested in CI: </span>${c.tested}`}</p>
</li>`,
		)}</ul>`,
	};
}
