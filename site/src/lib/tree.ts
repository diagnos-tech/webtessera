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

// A Merkle tree of eight entries, hashed with webtessera's RFC 6962 hasher while the site
// builds, drawn as SVG with the inclusion proof of one entry marked: the path from the entry
// to the root, and the three sibling hashes that make up the proof (styles: docs/concepts).

import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { fragment } from "../shared/bytes.ts";
import { html, type SafeHtml } from "../shared/html.ts";

const width = 640;
/** treeLeaves is the number of entries the figure's tree holds. */
export const treeLeaves = 8;
const leaves = treeLeaves;
const levels = Math.log2(leaves) + 1;

function levelY(level: number): number {
	return 206 - level * 60;
}

function nodeX(level: number, index: number): number {
	const span = (width / leaves) * 2 ** level;
	return (index + 0.5) * span;
}

/** merkleTree renders the tree with entry `target`'s inclusion proof highlighted. */
export function merkleTree(target: number): SafeHtml {
	const enc = new TextEncoder();
	const hashes: Uint8Array[][] = [
		Array.from({ length: leaves }, (_, i) => DefaultHasher.hashLeaf(enc.encode(`entry ${i}`))),
	];
	for (let l = 1; l < levels; l++) {
		const below = hashes[l - 1] ?? [];
		hashes.push(
			Array.from({ length: below.length / 2 }, (_, i) =>
				DefaultHasher.hashChildren(below[2 * i] ?? new Uint8Array(), below[2 * i + 1] ?? new Uint8Array()),
			),
		);
	}
	const onPath = (l: number, i: number) => i === target >> l;
	const isProof = (l: number, i: number) => l < levels - 1 && i === ((target >> l) ^ 1);
	const edges: SafeHtml[] = [];
	const nodes: SafeHtml[] = [];
	for (let l = 0; l < levels; l++) {
		const row = hashes[l] ?? [];
		row.forEach((h, i) => {
			const x = nodeX(l, i);
			const y = levelY(l);
			const cls = onPath(l, i) ? "path" : isProof(l, i) ? "proof" : "dim";
			if (l > 0) {
				for (const c of [2 * i, 2 * i + 1]) {
					const hot = onPath(l - 1, c) && onPath(l, i);
					edges.push(
						html`<line class="${hot ? "edge hot" : "edge"}" x1="${nodeX(l - 1, c)}" y1="${levelY(l - 1) - 14}" x2="${x}" y2="${y + 14}"/>`,
					);
				}
			}
			const w = l === 0 ? 58 : 74;
			const label = cls === "dim" ? "" : fragment(h, 3);
			nodes.push(
				html`<g class="n ${cls}"><rect x="${x - w / 2}" y="${y - 14}" width="${w}" height="28" rx="2"/>${
					label === "" ? "" : html`<text x="${x}" y="${y + 4.5}">${label}</text>`
				}</g>`,
			);
			if (l === 0) {
				nodes.push(html`<text class="idx${i === target ? " on" : ""}" x="${x}" y="${y + 34}">${i}</text>`);
			}
		});
	}
	const rootX = nodeX(levels - 1, 0);
	return html`<svg class="tree" viewBox="0 0 ${width} 250" role="img" aria-labelledby="tree-title tree-desc">
<title id="tree-title">A Merkle tree of eight entries, with the inclusion proof of entry ${target}</title>
<desc id="tree-desc">Entry ${target} is proven by three sibling hashes: entry ${target ^ 1}, the pair ${(target ^ 2) & ~1} and ${((target ^ 2) & ~1) + 1}, and the half of the tree holding entries ${target < 4 ? "4 to 7" : "0 to 3"}. Hashing them in order with the entry recomputes the root.</desc>
${edges}${nodes}
<text class="cap" x="${rootX + 46}" y="${levelY(levels - 1) + 4.5}">the root a checkpoint signs</text>
</svg>`;
}
