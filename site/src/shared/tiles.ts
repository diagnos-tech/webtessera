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

// Renders a tlog-tiles hash tile as a 16 × 16 mosaic: one cell per hash, toned by the
// hash itself, and an empty cell for each hash of a partial tile that is still to come.

import { fragment, shade } from "./bytes.ts";
import { html, type SafeHtml } from "./html.ts";

/** TileWidth is the number of hashes in a full tile (C2SP tlog-tiles). */
export const TileWidth = 256;

/** TileView is a hash tile to render. */
export interface TileView {
	/** path is the tile's tlog-tiles path, e.g. tile/0/000.p/19. */
	readonly path: string;
	readonly level: number;
	readonly index: bigint;
	/** hashes are the tile's hashes, in order; fewer than TileWidth for a partial tile. */
	readonly hashes: readonly Uint8Array[];
}

/** renderTile renders a tile as a mosaic under its path; hit marks one cell. */
export function renderTile(t: TileView, hit?: bigint): SafeHtml {
	const first = t.index * BigInt(TileWidth);
	const what = t.level === 0 ? "entry" : "subtree";
	const cells = t.hashes.map((h, i) => {
		const n = first + BigInt(i);
		const cls = `c s${shade(h)}${n === hit ? " hit" : ""}`;
		return html`<i class="${cls}" data-i="${n}" title="${what} ${n}: ${fragment(h)}"></i>`;
	});
	const empty = Array.from({ length: TileWidth - t.hashes.length }, () => html`<i class="c e"></i>`);
	const label = `${t.path}: ${t.hashes.length} of ${TileWidth} hashes at tile level ${t.level}`;
	return html`<figure class="fig tile" data-level="${t.level}">
<figcaption><code>${t.path}</code><span>${t.hashes.length} of ${TileWidth}</span></figcaption>
<div class="tile-grid" role="img" aria-label="${label}">${cells}${empty}</div>
</figure>`;
}
