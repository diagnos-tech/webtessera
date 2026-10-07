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

// The compatibility evidence docs/compatibility.md describes, counted from the repository:
// the differential corpora's records (fixtures/data/differential_*.json), which backends
// run the golden suite in which runtime (the test files that call it), the backends the Go
// interop harness drives (scripts/interop/backends.mjs) and the test-parity allow-list
// (scripts/test-parity-allowlist.json). Nothing here is a number typed by hand.

import type { Repo } from "./repo.ts";

/** Corpus is one differential corpus: Go's verdicts on generated inputs, replayed by the tests. */
export interface Corpus {
	readonly file: string;
	readonly records: number;
	/** description is the corpus file's own description of what Go recorded. */
	readonly description: string;
}

/** GoldenRow is one backend (or key custody) and the runtimes its golden suite runs in. */
export interface GoldenRow {
	readonly backend: string;
	readonly runtimes: readonly string[];
}

/** Evidence is what the compatibility section counts. */
export interface Evidence {
	readonly corpora: readonly Corpus[];
	readonly differentialRecords: number;
	/** everyCodePoint is true when a corpus records a property of every Unicode code point. */
	readonly everyCodePoint: boolean;
	/** differentialRuntimes are the runtimes the corpora are replayed in. */
	readonly differentialRuntimes: readonly string[];
	/** golden lists the storage backends of the golden suite; webCrypto the runtimes that replay Go's signatures through WebCrypto keys. */
	readonly golden: readonly GoldenRow[];
	readonly webCrypto: readonly string[];
	/** interop names the backends the Go interop harness runs, both ways. */
	readonly interop: readonly string[];
	/** parity summarises the test-parity allow-list: its entries and the distinct ADRs they cite. */
	readonly parity: { readonly entries: number; readonly adrs: number };
}

/** runtimeOf classifies a test file by the suffix that routes it to a vitest configuration. */
export function runtimeOf(file: string): string {
	if (file.endsWith("_browser_test.ts")) return "Chromium";
	if (file.endsWith("_workers_test.ts")) return "workerd";
	if (file.endsWith("_services_test.ts")) return "live server";
	return "Node.js";
}

/** runtimeOrder is the order runtimes are listed in. */
export const runtimeOrder = ["Node.js", "Chromium", "workerd", "live server"];

// backends finds a storage backend in a golden test file: by its directory or by the
// adapter it calls. The order is the order of the table.
const backends: readonly [string, (file: string, text: string) => boolean][] = [
	["memory", (f, t) => f.includes("/storage/memory/") || /\bMemoryObjectStore\b/.test(t)],
	["IndexedDB", (f) => f.includes("/storage/indexeddb/")],
	["node:sqlite", (_f, t) => /["']node:sqlite["']/.test(t)],
	["libSQL", (_f, t) => /\bfromLibsql\b/.test(t)],
	["rqlite", (_f, t) => /\bfromRqlite\b/.test(t)],
	["sqlite-wasm", (_f, t) => /\bfromSqliteWasm\b/.test(t)],
	["Cloudflare D1", (_f, t) => /\bfromD1\b/.test(t)],
	["Durable Object SQL", (_f, t) => /Durable Object/.test(t)],
];

function sortRuntimes(list: Iterable<string>): string[] {
	return [...new Set(list)].sort((a, b) => runtimeOrder.indexOf(a) - runtimeOrder.indexOf(b));
}

/** countRecords counts a corpus's records: the rows of every table its `columns` header describes. */
function countRecords(raw: Record<string, unknown>): number {
	const columns = (raw.columns ?? {}) as Record<string, unknown>;
	let n = 0;
	for (const [key, cols] of Object.entries(columns)) {
		const rows = raw[key];
		if (Array.isArray(cols) && Array.isArray(rows)) {
			n += rows.length;
		}
	}
	return n;
}

/** loadEvidence reads the corpora, the golden and interop test wiring, and the parity allow-list. */
export function loadEvidence(repo: Repo): Evidence {
	const corpora: Corpus[] = [];
	let everyCodePoint = false;
	for (const file of repo.list("fixtures/data", "file").filter((f) => /^differential_.+\.json$/.test(f))) {
		const raw = repo.json<Record<string, unknown>>(`fixtures/data/${file}`);
		corpora.push({ file, records: countRecords(raw), description: String(raw.description ?? "") });
		everyCodePoint ||= /every code point/i.test(String(raw.description ?? ""));
	}

	const tests = repo.walk("src", /_test\.ts$/);
	const differentialRuntimes = sortRuntimes(
		tests.filter((f) => /differential\w*_test\.ts$/.test(f)).map((f) => runtimeOf(f)),
	);

	const golden = new Map<string, Set<string>>();
	const webCrypto = new Set<string>();
	for (const f of tests) {
		const text = repo.text(f);
		if (/\bdescribeGoldenCompatibility\(/.test(text)) {
			for (const [name, probe] of backends) {
				if (probe(f, text)) {
					golden.set(name, (golden.get(name) ?? new Set()).add(runtimeOf(f)));
				}
			}
		}
		if (/\bdescribeWebCryptoGolden\(/.test(text)) {
			webCrypto.add(runtimeOf(f));
		}
	}

	const interopSource = repo.textOr("scripts/interop/backends.mjs") ?? "";
	const interop = [...interopSource.matchAll(/\{\s*name:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");

	const allow = repo.exists("scripts/test-parity-allowlist.json")
		? repo.json<{ entries?: Record<string, { adrs?: string[] }> }>("scripts/test-parity-allowlist.json")
		: {};
	const entries = Object.values(allow.entries ?? {});

	return {
		corpora,
		differentialRecords: corpora.reduce((n, c) => n + c.records, 0),
		everyCodePoint,
		differentialRuntimes,
		golden: backends
			.map(([backend]) => ({ backend, runtimes: sortRuntimes(golden.get(backend) ?? []) }))
			.filter((r) => r.runtimes.length > 0),
		webCrypto: sortRuntimes(webCrypto),
		interop,
		parity: { entries: entries.length, adrs: new Set(entries.flatMap((e) => e.adrs ?? [])).size },
	};
}
