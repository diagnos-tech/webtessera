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

// The safe API's two entry points, webtessera/server and webtessera/browser, as the
// repository states them: where each runs and what key it holds (README.md's safe API
// table), what it refuses to do (the "What it will not let you do" list of its module
// comment), which bundler conditions resolve webtessera/server to the module that fails a
// browser build (package.json's exports map), and the reasons a receipt can fail
// (ReceiptError in src/safe/receipt.ts).

import type { EntryPoint } from "./entrypoints.ts";
import { loadSafeTable } from "./readme.ts";
import type { Repo } from "./repo.ts";

/** Refusal is one mistake an entry point will not let its caller make. */
export interface Refusal {
	readonly title: string;
	readonly text: string;
}

/** SafeEntry is one entry point of the safe API. */
export interface SafeEntry {
	readonly specifier: string;
	readonly runsIn: string;
	readonly holds: string;
	readonly refuses: readonly Refusal[];
	/** functions are the functions the entry point exports. */
	readonly functions: readonly string[];
	/** guardConditions are the export conditions under which the entry point resolves to a guard module. */
	readonly guardConditions: readonly string[];
	/** serverConditions are the conditions listed explicitly to resolve to the real module. */
	readonly serverConditions: readonly string[];
	readonly source: string;
}

/** SafeApi is what the page shows of the safe API. */
export interface SafeApi {
	readonly entries: readonly SafeEntry[];
	/** receiptReasons are the values of ReceiptError's `reason`: the checks a receipt can fail. */
	readonly receiptReasons: readonly string[];
}

/**
 * refusals reads the bullets under "# What it will not let you do" in a module's doc
 * comment. Each bullet is "Title: explanation"; continuation lines are joined.
 */
export function refusals(source: string): Refusal[] {
	const doc = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? "";
	const text = doc.replace(/^\s*\* ?/gm, "");
	const section = /^# What it will not let you do\n([\s\S]*?)(?=^# |^@|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
	const items: string[] = [];
	for (const line of section.split("\n")) {
		const bullet = /^\s*- (.*)$/.exec(line);
		if (bullet !== null) {
			items.push(bullet[1] ?? "");
		} else if (line.trim() !== "" && items.length > 0) {
			items[items.length - 1] += ` ${line.trim()}`;
		} else if (line.trim() === "" && items.length > 0) {
			break;
		}
	}
	return items.map((item) => {
		const i = item.indexOf(": ");
		return i < 0
			? { title: item.trim(), text: "" }
			: { title: item.slice(0, i).trim(), text: item.slice(i + 2).trim() };
	});
}

type Conditions = Record<string, string>;

/** loadSafeApi reads the safe API's entry points. */
export function loadSafeApi(repo: Repo, entryPoints: readonly EntryPoint[]): SafeApi {
	const exportsMap = repo.json<{ exports?: Record<string, string | Conditions> }>("package.json").exports ?? {};
	const rows = loadSafeTable(repo);
	const entries = rows
		.map((row): SafeEntry | undefined => {
			const ep = entryPoints.find((e) => e.specifier === row.specifier);
			if (ep === undefined) {
				return undefined;
			}
			const target = exportsMap[`./${row.specifier.split("/").slice(1).join("/")}`];
			const conditions = typeof target === "object" ? Object.entries(target) : [];
			const real = typeof target === "object" ? (target.default ?? "") : (target ?? "");
			return {
				specifier: row.specifier,
				runsIn: row.runsIn,
				holds: row.holds,
				refuses: refusals(repo.text(ep.source)),
				functions: ep.names.filter((n) => n.kind === "function").map((n) => n.name),
				guardConditions: conditions.filter(([k, v]) => k !== "default" && v !== real).map(([k]) => k),
				serverConditions: conditions.filter(([k, v]) => k !== "default" && v === real).map(([k]) => k),
				source: ep.source,
			};
		})
		.filter((e): e is SafeEntry => e !== undefined);
	const receipt = repo.textOr("src/safe/receipt.ts") ?? "";
	const union = /readonly reason:\s*([^;]+);/.exec(receipt)?.[1] ?? "";
	return { entries, receiptReasons: [...union.matchAll(/"([\w-]+)"/g)].map((m) => m[1] ?? "") };
}
