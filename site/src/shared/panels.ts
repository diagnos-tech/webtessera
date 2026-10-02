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

// The demo's panels, rendered the same way by the build (from the log it creates) and
// by the live demo (from the log in the visitor's tab), so that the page does not jump
// when the live log takes over.

import { formatBytes } from "./bytes.ts";
import { html, type SafeHtml } from "./html.ts";
import type { Inclusion } from "./inspect.ts";
import { renderProof } from "./proof.ts";
import { renderTile, type TileView } from "./tiles.ts";

/** ListedEntry is an entry shown in the entry list. */
export interface ListedEntry {
	readonly index: bigint;
	readonly text: string;
}

/** renderEntries lists entries, newest first, each with a button to prove it. */
export function renderEntries(entries: readonly ListedEntry[], selected: bigint | undefined): SafeHtml {
	return html`${[...entries]
		.reverse()
		.map(
			(e) =>
				html`<li${e.index === selected ? html` class="sel"` : ""}><span class="ix">${e.index}</span><span class="tx" translate="no">${e.text}</span><button type="button" class="link-btn js-only" data-prove="${e.index}" aria-label="Prove entry ${e.index}">prove</button></li>`,
		)}`;
}

/** renderFiles lists the objects in the log's store: the tlog-tiles resources. */
export function renderFiles(files: readonly { path: string; size: number }[]): SafeHtml {
	return html`${files.map((f) => html`<li><code>${f.path}</code><span>${formatBytes(f.size)}</span></li>`)}`;
}

/** renderTiles renders the tiles of a log, highest level first, at most `max` per level. */
export function renderTiles(tiles: readonly TileView[], hit?: bigint, max = 3): SafeHtml {
	const levels = [...new Set(tiles.map((t) => t.level))].sort((a, b) => b - a);
	return html`${levels.map((level) => {
		const row = tiles.filter((t) => t.level === level);
		const hidden = row.length - max;
		return html`<div class="tile-row" data-level="${level}">${row.slice(-max).map((t) => renderTile(t, level === 0 ? hit : undefined))}${
			hidden > 0 ? html`<p class="tile-more">+ ${hidden} full tile${hidden === 1 ? "" : "s"} at level ${level}</p>` : ""
		}</div>`;
	})}`;
}

/** renderInclusion renders a proof's verdict and its audit path. */
export function renderInclusion(p: Inclusion, tampered: boolean): SafeHtml {
	const n = p.proof.length;
	const verdict =
		p.error === undefined
			? html`<p class="verdict-line ok"><strong>Verified.</strong> Entry ${p.index} is in the tree of ${p.size} ${p.size === 1n ? "entry" : "entries"}: ${n} ${n === 1 ? "hash recomputes" : "hashes recompute"} the root of the signed checkpoint.</p>`
			: html`<p class="verdict-line bad"><strong>Rejected.</strong> ${tampered ? "The entry was altered, so its leaf hash changed and the recomputed root no longer matches the checkpoint: " : ""}<code>verifyInclusion</code> threw <code title="${p.error.replace(/\s+/g, " ")}">${p.errorName ?? "Error"}</code>.</p>`;
	return html`${verdict}${renderProof(p)}`;
}
