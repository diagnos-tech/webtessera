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

// docs/PORTING-MAP.md: one row per upstream Go file with its porting status, and the
// pinned upstream commit (scripts/upstream.json).

import type { Repo } from "./repo.ts";

/** PortingRow is one Go file and what became of it. */
export interface PortingRow {
	readonly go: string;
	readonly ts: string;
	readonly status: string;
}

/** PortingMap summarises docs/PORTING-MAP.md. */
export interface PortingMap {
	/** upstream is the repository the port follows, and commit its pinned commit. */
	readonly upstream: string;
	readonly commit: string;
	/** files is the number of upstream Go files the map says it covers, or its row count. */
	readonly files: number;
	/** tessera holds the rows for Tessera's own files; dependencies those for its Go dependencies. */
	readonly tessera: readonly PortingRow[];
	readonly dependencies: readonly PortingRow[];
}

/** statusOrder is the order statuses are listed in, best first. */
export const statusOrder = ["done", "in progress", "not started", "pending ADR", "not ported"];

function rowsOf(markdown: string): PortingRow[] {
	const rows: PortingRow[] = [];
	for (const line of markdown.split("\n")) {
		const m = /^\s*\| (`[^|]+`|—) \| (`[^|]+`|—) \| ([a-zA-Z ]+?) \|/.exec(line);
		if (m === null || m[1] === "—") {
			continue;
		}
		rows.push({ go: (m[1] ?? "").replace(/`/g, ""), ts: (m[2] ?? "").replace(/`/g, ""), status: m[3] ?? "" });
	}
	return rows;
}

/** loadPortingMap parses docs/PORTING-MAP.md and scripts/upstream.json. */
export function loadPortingMap(repo: Repo): PortingMap {
	const md = repo.text("docs/PORTING-MAP.md");
	const upstream = repo.json<{ repository: string; commit: string }>("scripts/upstream.json");
	const start = md.indexOf("## The upstream Go files");
	const beyond = md.indexOf("## Beyond the upstream files");
	const fixtures = md.indexOf("## Golden fixtures");
	if (start < 0 || beyond < start) {
		throw new Error("docs/PORTING-MAP.md: cannot find the upstream table");
	}
	const tessera = rowsOf(md.slice(start, beyond));
	const stated = /(\d+) `\.go` files/.exec(md.slice(0, start))?.[1];
	return {
		upstream: upstream.repository,
		commit: upstream.commit,
		files: stated === undefined ? tessera.length : Number(stated),
		tessera,
		dependencies: rowsOf(md.slice(beyond, fixtures < 0 ? undefined : fixtures)),
	};
}

/** countByStatus counts rows per status, in statusOrder, leaving out absent statuses. */
export function countByStatus(rows: readonly PortingRow[]): { status: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const r of rows) {
		counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
	}
	const known = statusOrder.filter((s) => counts.has(s));
	const other = [...counts.keys()].filter((s) => !statusOrder.includes(s)).sort();
	return [...known, ...other].map((status) => ({ status, count: counts.get(status) ?? 0 }));
}
