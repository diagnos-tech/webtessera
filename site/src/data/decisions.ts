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

// docs/decisions/: the architecture decision records, one per divergence from Go.

import type { Repo } from "./repo.ts";

/** Decisions summarises the ADRs. */
export interface Decisions {
	readonly total: number;
	/** byStatus counts ADRs by the first word of their Status line (accepted, proposed, …). */
	readonly byStatus: readonly { status: string; count: number }[];
}

/** loadDecisions counts the ADRs in docs/decisions, leaving out the template. */
export function loadDecisions(repo: Repo): Decisions {
	const files = repo.list("docs/decisions", "file").filter((f) => /^\d{4}-.+\.md$/.test(f) && !f.startsWith("0000-"));
	const counts = new Map<string, number>();
	for (const f of files) {
		const status = /^- \*\*Status:\*\*\s*([a-zA-Z]+)/m.exec(repo.text(`docs/decisions/${f}`))?.[1]?.toLowerCase();
		const key = status ?? "unknown";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return {
		total: files.length,
		byStatus: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([status, count]) => ({ status, count })),
	};
}
