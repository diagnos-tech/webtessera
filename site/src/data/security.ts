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

// The security record: the hardening beyond Tessera that CHANGELOG.md's "### Security"
// list describes (each item's heading and the ADRs it cites), and the decision records
// that came out of the security reviews: those written as the second review's fixes, whose
// author line says so, and the earlier ones that record what a review required.

import type { Repo } from "./repo.ts";

/** Hardening is one item of the changelog's security list. */
export interface Hardening {
	readonly title: string;
	readonly adrs: readonly string[];
}

/** Adr is a decision record, by number and file. */
export interface Adr {
	readonly number: string;
	readonly file: string;
	readonly title: string;
}

/** Security is what the security section shows. */
export interface Security {
	readonly hardening: readonly Hardening[];
	/** reviewed are the ADRs that record a security review's requirements; fixes those written as its fixes. */
	readonly reviewed: readonly Adr[];
	readonly fixes: readonly Adr[];
	/** adrFiles maps an ADR number to its file in docs/decisions. */
	readonly adrFiles: Readonly<Record<string, string>>;
}

/** loadSecurity reads CHANGELOG.md's security list and the ADRs that mention a security review. */
export function loadSecurity(repo: Repo): Security {
	const changelog = repo.textOr("CHANGELOG.md") ?? "";
	const section = /^### Security\n([\s\S]*?)(?=^### |^## |(?![\s\S]))/m.exec(changelog)?.[1] ?? "";
	const hardening = [...section.matchAll(/^- \*\*([^*]+?)\*\*:?([\s\S]*?)(?=^- |(?![\s\S]))/gm)].map((m) => ({
		title: (m[1] ?? "").replace(/:$/, ""),
		adrs: [...new Set([...(m[2] ?? "").matchAll(/ADR-(\d{4})/g)].map((a) => a[1] ?? ""))],
	}));
	const reviewed: Adr[] = [];
	const fixes: Adr[] = [];
	const files = repo.list("docs/decisions", "file").filter((f) => /^\d{4}-.+\.md$/.test(f));
	const adrFiles = Object.fromEntries(files.map((f) => [f.slice(0, 4), f]));
	for (const file of files) {
		const text = repo.text(`docs/decisions/${file}`);
		if (!/security[- ]review/i.test(text)) {
			continue;
		}
		const adr = {
			number: file.slice(0, 4),
			file,
			title: /^# ADR-\d{4}: (.+)$/m.exec(text)?.[1]?.trim() ?? file,
		};
		(/^- \*\*Author:\*\*.*security-review fixes/im.test(text) ? fixes : reviewed).push(adr);
	}
	return { hardening, reviewed, fixes, adrFiles };
}
