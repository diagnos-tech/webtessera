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

// The security posture: what fails closed, how each entry point keeps to its environment,
// how keys are held, how receipts are checked, and the security reviews, then the hardening
// beyond Tessera that CHANGELOG.md lists, each item with its decision records. It states
// what the code does, never how an attack on it would work.

import type { SectionSpec } from "../components/section.ts";
import { list } from "../components/words.ts";
import type { SiteData } from "../data/index.ts";
import type { Adr } from "../data/security.ts";
import { html, type SafeHtml } from "../shared/html.ts";

function adrLink(d: SiteData, n: string): SafeHtml {
	const file = d.security.adrFiles[n];
	return file === undefined
		? html`<span class="adr">ADR-${n}</span>`
		: html`<a class="adr" href="${d.site.blob}docs/decisions/${file}">ADR-${n}</a>`;
}

function adrList(d: SiteData, adrs: readonly Adr[]): SafeHtml {
	return html`${adrs.map((a, i) => html`${i === 0 ? "" : i === adrs.length - 1 ? " and " : ", "}${adrLink(d, a.number)}`)}`;
}

/** security is the security-posture section. */
export function security(d: SiteData): SectionSpec {
	const server = d.safe.entries.find((e) => e.specifier.endsWith("/server"));
	const guard = [...(server?.guardConditions ?? [])].sort();
	const { reviewed, fixes, hardening } = d.security;
	const posture: readonly [string, SafeHtml][] = [
		[
			"Locks fail closed",
			html`SQLite stores take fenced leases wherever another process or connection could open the database, and keep locks in memory only for a private database or a declared single writer. An IndexedDB log will not open without Web Locks unless you promise a single writer.`,
		],
		[
			"Each entry point knows where it runs",
			html`<code>webtessera/server</code> ${guard.length > 0 ? html`fails the build of a bundle made under the ${list(guard.map((c) => `“${c}”`))} condition${guard.length === 1 ? "" : "s"}, and ` : ""}throws at import in a browser. <code>webtessera/browser</code> never takes a private-key string.`,
		],
		[
			"Keys that cannot be exported",
			html`Log keys are non-extractable WebCrypto Ed25519 keys wherever the runtime supports them; elsewhere the key reports that it is held by <code>@noble/curves</code>, or is refused with <code>fallback: "error"</code>. No property, <code>toString</code>, JSON or error message shows key material.`,
		],
		[
			"Receipts verified before you see them",
			html`<code>append()</code> returns a receipt only after checking it against the log’s key and the entry, and <code>verifyReceipt</code> repeats every check offline: the leaf hash, the log’s signature and origin, the witness policy and the inclusion proof.`,
		],
	];
	return {
		id: "security",
		nav: "Security",
		title: "Safe defaults, reviewed",
		lead: html`The defaults are chosen so that the obvious call is the safe one, and a divergence from Tessera that changes a verification outcome is treated as a security bug. To report one, follow the <a href="${d.site.blob}SECURITY.md">security policy</a>: privately, through GitHub Security Advisories.`,
		body: html`<ul class="cards posture">${posture.map(([title, text]) => html`<li class="card"><h3>${title}</h3><p>${text}</p></li>`)}
${
	reviewed.length + fixes.length === 0
		? ""
		: html`<li class="card reviews"><h3>Two security reviews</h3><p>${reviewed.length > 0 ? html`Their requirements are recorded in ${adrList(d, reviewed)}. ` : ""}${fixes.length > 0 ? html`The second review’s fixes are ${adrList(d, fixes)}.` : ""}</p></li>`
}</ul>
${
	hardening.length === 0
		? ""
		: html`<div class="hardening">
<h3>Hardening beyond Tessera</h3>
<p>Input validation and fail-closed behaviour that upstream lacks, none of which changes the bytes of a valid log. Each item is described in <a href="${d.site.blob}CHANGELOG.md">CHANGELOG.md</a> and decided in its records.</p>
<ul class="harden-list">${hardening.map(
				(h) =>
					html`<li><span class="harden-title">${h.title}</span><span class="harden-adrs">${h.adrs.map((a, i) => html`${i === 0 ? "" : " "}${adrLink(d, a)}`)}</span></li>`,
			)}</ul>
</div>`
}`,
	};
}
