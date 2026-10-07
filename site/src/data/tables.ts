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

// Markdown tables, as the repository's documents write them: the safe API's environment
// table, the package map and the guides' index are all read through requireTable.

/** cells splits a Markdown table row into its trimmed cells. */
export function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) => c.trim());
}

/** headingLevel returns the level of a Markdown heading line, or 0 for any other line. */
function headingLevel(line: string): number {
	return /^(#{1,6}) /.exec(line)?.[1]?.length ?? 0;
}

/**
 * markdownTable returns the rows (header excluded) of the first table under the heading
 * line `heading` (for example "## Storage drivers"), as raw Markdown cells. It stops at the
 * next heading of the same or a higher level, and returns [] if the heading or the table
 * is missing; requireTable turns that into a build error.
 */
export function markdownTable(markdown: string, heading: string): string[][] {
	const lines = markdown.split("\n");
	const start = lines.findIndex((l) => l.trim() === heading);
	if (start < 0) {
		return [];
	}
	const level = headingLevel(heading);
	const rows: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const h = headingLevel(line);
		if (h > 0 && h <= level) {
			break;
		}
		if (line.trimStart().startsWith("|")) {
			rows.push(line);
		} else if (rows.length > 0) {
			break;
		}
	}
	// The first row is the header, the second its separator.
	return rows.slice(2).map(cells);
}

/**
 * requireTable returns the rows of the first table under `heading` in a repository file, and
 * fails the build if there are none: a renamed heading or a moved table must be followed by
 * the extractor that reads it, not leave part of the site silently empty.
 */
export function requireTable(markdown: string, file: string, heading: string): string[][] {
	const rows = markdownTable(markdown, heading);
	if (rows.length === 0) {
		throw new Error(
			`${file} has no table under "${heading}", which the site reads; update site/src/data to where the table now is`,
		);
	}
	return rows;
}

/** codeSpans returns the `code` spans of a Markdown cell, in order. */
export function codeSpans(cell: string): string[] {
	return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

/** plain turns a Markdown cell into plain text: links keep their labels, code loses its backticks. */
export function plain(cell: string): string {
	return cell
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.trim();
}
