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

// The demo's panels, rendered the same way by the build (from the log it creates) and
// by the live demo (from the log in the visitor's tab), so that the page does not jump
// when the live log takes over.

import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { fragment } from "./bytes.ts";
import { html, type SafeHtml } from "./html.ts";
import type { Inclusion } from "./inspect.ts";
import { renderProof } from "./proof.ts";
import { renderTile, type TileView } from "./tiles.ts";

const enc = new TextEncoder();

/** leafHash is the start of an entry's RFC 6962 leaf hash, as the entry list shows it. */
export function leafHash(text: string): string {
	return fragment(DefaultHasher.hashLeaf(enc.encode(text)), 8);
}

/** ListedEntry is an entry shown in the entry list. */
export interface ListedEntry {
	readonly index: bigint;
	/** text is the entry as the log holds it. */
	readonly text: string;
	/** claimed, if set, is what the visitor changed the entry to: the list shows it as tampering. */
	readonly claimed?: string;
}

/** ListOptions says how the entry list is drawn. */
export interface ListOptions {
	readonly selected?: bigint | undefined;
	/** live makes each entry a field the visitor can edit; without it the list is plain text. */
	readonly live?: boolean;
}

/**
 * renderEntries lists entries, newest first, each with its index, its contents and the start of
 * its leaf hash. Entries that do not follow one another are set apart.
 */
export function renderEntries(entries: readonly ListedEntry[], opts: ListOptions = {}): SafeHtml {
	const rows: SafeHtml[] = [];
	let above: bigint | undefined;
	for (const e of [...entries].sort((a, b) => (a.index < b.index ? 1 : a.index > b.index ? -1 : 0))) {
		if (above !== undefined && above - e.index > 1n) {
			rows.push(html`<li class="gap" aria-hidden="true"></li>`);
		}
		above = e.index;
		const text = e.claimed ?? e.text;
		const cls = `entry${e.index === opts.selected ? " sel" : ""}${e.claimed === undefined ? "" : " bad"}`;
		const body =
			opts.live === true
				? html`<input class="tx" data-entry="${e.index}" value="${text}" aria-label="Entry ${e.index}" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false" translate="no" />`
				: html`<span class="tx" translate="no">${text}</span>`;
		const undo =
			opts.live === true
				? html`<button type="button" class="undo" data-restore="${e.index}" aria-label="Undo the change to entry ${e.index}"${e.claimed === undefined ? html` hidden` : ""}>Undo</button>`
				: "";
		rows.push(
			html`<li class="${cls}" data-index="${e.index}"><span class="ix">${e.index}</span>${body}<code class="lh" title="Leaf hash of entry ${e.index}">${leafHash(text)}</code>${undo}</li>`,
		);
	}
	return html`${rows}`;
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

/** renderInclusion renders a proof's verdict and its audit path; `tampered` says the visitor changed the entry. */
export function renderInclusion(p: Inclusion, tampered: boolean): SafeHtml {
	const n = p.proof.length;
	const verdict =
		p.error === undefined
			? html`<p class="verdict-line ok"><strong>Verified.</strong> Entry ${p.index} is in the tree of ${p.size} ${p.size === 1n ? "entry" : "entries"}: ${n} ${n === 1 ? "hash recomputes" : "hashes recompute"} the root of the signed checkpoint.</p>`
			: html`<p class="verdict-line bad"><strong>${tampered ? "Tampering detected." : "Rejected."}</strong> ${tampered ? html`Entry ${p.index} was changed, so its leaf hash changed, and the root recomputed from its proof is no longer the root the checkpoint signs: ` : ""}<code>verifyInclusion</code> threw <code title="${p.error.replace(/\s+/g, " ")}">${p.errorName ?? "Error"}</code>.</p>`;
	return html`${verdict}${renderProof(p)}`;
}
