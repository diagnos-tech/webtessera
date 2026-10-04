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

// The SQLite engines the SQLite driver targets. The list is curated, in alphabetical
// order within each group so that no vendor comes first; whether the repository's own
// tests exercise an engine is not curated: it is read from the driver's test files, and
// each engine's default locking is read from README.md's engine table.

import type { EngineRow } from "./readme.ts";
import type { Repo } from "./repo.ts";

/** SqliteEngine is one SQLite engine the driver can keep a log in. */
export interface SqliteEngine {
	readonly name: string;
	readonly where: string;
	readonly group: "Embedded" | "Client and server" | "Serverless platforms";
	/** adapter is the function of webtessera/storage/sqlite that wraps the engine, if it exports it. */
	readonly adapter: string | undefined;
	/** tested is true when a test of the SQLite driver imports or names the engine. */
	readonly tested: boolean;
	/** locking is the README's statement of the engine's default locking, if it gives one. */
	readonly locking: string | undefined;
}

interface EngineSpec {
	readonly name: string;
	readonly where: string;
	readonly group: SqliteEngine["group"];
	readonly adapter: string;
	/** probe finds the engine in a test file: its module name or binding type. */
	readonly probe: RegExp;
}

const engines: readonly EngineSpec[] = [
	{
		name: "better-sqlite3",
		where: "Node.js",
		group: "Embedded",
		adapter: "fromSqliteSync",
		probe: /["']better-sqlite3["']/,
	},
	{ name: "bun:sqlite", where: "Bun", group: "Embedded", adapter: "fromSqliteSync", probe: /["']bun:sqlite["']/ },
	{
		name: "node:sqlite",
		where: "Node.js, Deno",
		group: "Embedded",
		adapter: "fromSqliteSync",
		probe: /["']node:sqlite["']/,
	},
	{
		name: "sqlite-wasm",
		where: "browsers and workers",
		group: "Embedded",
		adapter: "fromSqliteWasm",
		probe: /["']@sqlite\.org\/sqlite-wasm["']/,
	},
	{
		name: "libSQL / Turso",
		where: "any runtime with fetch",
		group: "Client and server",
		adapter: "fromLibsql",
		probe: /["']@libsql\/client/,
	},
	{
		name: "rqlite",
		where: "any runtime with fetch",
		group: "Client and server",
		adapter: "fromRqlite",
		probe: /\bfromRqlite\b/,
	},
	{
		name: "Cloudflare D1",
		where: "Cloudflare Workers",
		group: "Serverless platforms",
		adapter: "fromD1",
		probe: /\bfromD1\b/,
	},
	{
		name: "SQLite-backed Durable Objects",
		where: "Cloudflare Workers",
		group: "Serverless platforms",
		adapter: "fromDurableObjectStorage",
		probe: /\bfromDurableObjectStorage\b/,
	},
];

/** loadSqliteEngines lists the engines, with their adapters and whether the driver's tests exercise them. */
export function loadSqliteEngines(
	repo: Repo,
	exported: ReadonlySet<string>,
	table: readonly EngineRow[],
): SqliteEngine[] {
	// The driver's tests and the shared helpers (testing/) they run each engine through.
	const tests = repo
		.walk("src/storage/sqlite", /\.ts$/)
		.filter((f) => f.endsWith("_test.ts") || f.includes("/testing/"))
		.map((f) => repo.text(f))
		.join("\n");
	return engines.map(({ probe, adapter, ...e }) => ({
		...e,
		adapter: exported.has(adapter) ? adapter : undefined,
		tested: probe.test(tests),
		locking: table.find((r) => r.adapter === adapter)?.locking,
	}));
}
