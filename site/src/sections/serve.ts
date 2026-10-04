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

// Serving, witnessing, mirroring and monitoring: the parts of a transparency ecosystem
// around a log. A role is shown only when its entry point exists, and lists the functions
// named here that the entry point really exports (their doc comment's first sentence is
// the chip's tooltip).

import type { SectionSpec } from "../components/section.ts";
import type { SiteData } from "../data/index.ts";
import { html, inlineCode, type SafeHtml } from "../shared/html.ts";

interface Role {
	readonly name: string;
	readonly specifiers: readonly string[];
	readonly text: string;
	/** functions are the exports worth naming on the card, if the entry points export them. */
	readonly functions: readonly string[];
	readonly spec?: readonly [string, string];
}

const roles: readonly Role[] = [
	{
		name: "Serve",
		specifiers: ["webtessera/http"],
		text: "Serve the tlog-tiles read API (checkpoint, tiles, entry bundles) from any `LogReader`, with the content types and cache headers the spec gives and only canonical paths. It is a plain function from `Request` to `Response`: Deno, Bun, Workers and service workers run it as it is, and `toNodeListener` adapts it to `node:http`.",
		functions: ["newLogHandler", "combineHandlers", "toNodeListener", "readEntryBody", "addResponse"],
		spec: ["C2SP tlog-tiles", "https://c2sp.org/tlog-tiles"],
	},
	{
		name: "Witness",
		specifiers: ["webtessera/witness"],
		text: "Run a tlog-witness: check that each checkpoint a log submits is consistent with the last one you cosigned, then cosign it. Its state lives in any `ObjectStore`, so it runs wherever a log does, for a fixed list of logs or an open-ended set.",
		functions: ["newWitnessServer", "newSignerForCosignatureV1", "vKeyToCosignatureV1"],
		spec: ["C2SP tlog-witness", "https://c2sp.org/tlog-witness"],
	},
	{
		name: "Mirror",
		specifiers: ["webtessera/mirror"],
		text: "Copy a log into storage you control, checkpoint last. `newVerifiedMirror` checks the log’s signature, that the checkpoint extends what was mirrored before, and every tile and bundle, before it writes anything. Targets: any `ObjectStore`, or any bucket that speaks the S3 API (AWS S3, Cloudflare R2, MinIO, …), signed with SigV4 over `fetch`, no SDK.",
		functions: ["newVerifiedMirror", "Mirror", "newS3Sink"],
	},
	{
		name: "Monitor",
		specifiers: ["webtessera/client", "webtessera/fsck"],
		text: "Follow any tlog-tiles log, whoever wrote it: verify each checkpoint, prove it consistent with the last, build and check inclusion proofs, stream entries, and audit a whole log with `fsck`.",
		functions: ["newLogStateTracker", "fetchCheckpoint", "newProofBuilder", "entryBundles", "newFsck"],
	},
];

function roleCard(r: Role, d: SiteData): SafeHtml {
	const eps = r.specifiers.map((s) => d.entryPoints.find((e) => e.specifier === s)).filter((e) => e !== undefined);
	const names = eps.flatMap((e) => e.names);
	const shown = r.functions
		.map((f) => names.find((n) => n.name === f))
		.filter((n) => n !== undefined && (n.kind === "function" || n.kind === "class"));
	return html`<li class="card role">
<h3>${r.name}</h3>
<p class="card-import">${eps.map((e, i) => html`${i === 0 ? "" : " "}<code>${e.specifier}</code>`)}</p>
<p>${inlineCode(r.text)}${r.spec === undefined ? "" : html` <a class="spec" href="${r.spec[1]}">${r.spec[0]}</a>`}</p>
${
	shown.length === 0
		? ""
		: html`<p class="api-mini"><span>Start with</span> ${shown.map((n, i) => html`${i === 0 ? "" : " "}<code title="${n?.summary ?? ""}">${n?.name}</code>`)}</p>`
}
</li>`;
}

/** serve is the section on serving, witnessing, mirroring and monitoring logs. */
export function serve(d: SiteData): SectionSpec {
	const has = new Set(d.entryPoints.map((e) => e.specifier));
	const shown = roles.filter((r) => has.has(r.specifiers[0] ?? ""));
	return {
		id: "serve",
		nav: "Serve",
		title: "Serve it, witness it, mirror it, watch it",
		lead: "A log is one part of the picture: logs are served, cosigned, copied and checked. Tessera leaves serving and witnessing to the programs built on it, and its mirror is an experimental command; here each one is a library, and each runs wherever the log does.",
		body: html`<ul class="cards roles">${shown.map((r) => roleCard(r, d))}</ul>`,
	};
}
