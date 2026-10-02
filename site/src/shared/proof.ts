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

// Explains an inclusion proof. The proof's hashes come from webtessera's client; this
// module only works out which subtree each hash stands for (RFC 6962 §2.1.1's PATH,
// which yields them in the same bottom-up order) and draws the audit path: the leaf
// at the bottom, one sibling per level, the recomputed root at the top.

import { fragment } from "./bytes.ts";
import { html, type SafeHtml } from "./html.ts";

/** PathStep is one sibling on an audit path: the subtree [lo, hi) on one side of the path. */
export interface PathStep {
	readonly side: "left" | "right";
	readonly lo: bigint;
	readonly hi: bigint;
}

/** largestPowerOfTwoBelow returns the largest power of two strictly less than n (n > 1). */
function largestPowerOfTwoBelow(n: bigint): bigint {
	let k = 1n;
	while (k << 1n < n) {
		k <<= 1n;
	}
	return k;
}

/** inclusionPath returns the subtrees whose hashes prove leaf m of a tree of size n, bottom up. */
export function inclusionPath(m: bigint, n: bigint): PathStep[] {
	const steps: PathStep[] = [];
	let lo = 0n;
	let size = n;
	let index = m;
	// Walk down from the root, then reverse: PATH lists the deepest sibling first.
	while (size > 1n) {
		const k = largestPowerOfTwoBelow(size);
		if (index < k) {
			steps.push({ side: "right", lo: lo + k, hi: lo + size });
			size = k;
		} else {
			steps.push({ side: "left", lo, hi: lo + k });
			lo += k;
			index -= k;
			size -= k;
		}
	}
	return steps.reverse();
}

/** computeSpine folds a leaf hash with its siblings: spine[0] is the leaf, the last is the root. */
export function computeSpine(
	leafHash: Uint8Array,
	steps: readonly PathStep[],
	proof: readonly Uint8Array[],
	hashChildren: (l: Uint8Array, r: Uint8Array) => Uint8Array,
): Uint8Array[] {
	const spine = [leafHash];
	let cur = leafHash;
	steps.forEach((s, i) => {
		const sib = proof[i] ?? new Uint8Array(32);
		cur = s.side === "left" ? hashChildren(sib, cur) : hashChildren(cur, sib);
		spine.push(cur);
	});
	return spine;
}

/** ProofView is a verified (or failed) inclusion proof to draw. */
export interface ProofView {
	readonly index: bigint;
	readonly size: bigint;
	readonly entry: string;
	readonly steps: readonly PathStep[];
	readonly proof: readonly Uint8Array[];
	readonly spine: readonly Uint8Array[];
	readonly root: Uint8Array;
}

function range(lo: bigint, hi: bigint): string {
	return hi - lo === 1n ? `entry ${lo}` : `entries ${lo}–${hi - 1n}`;
}

/** renderProof draws the audit path from the recomputed root down to the leaf. */
export function renderProof(v: ProofView): SafeHtml {
	const computed = v.spine[v.spine.length - 1] ?? new Uint8Array(32);
	const ok = fragment(computed, 32) === fragment(v.root, 32);
	const rows: SafeHtml[] = [];
	rows.push(html`<li class="row top">
<span class="node${ok ? " ok" : " bad"}"><span class="k">root</span> <code>${fragment(computed)}</code></span>
<span class="verdict ${ok ? "ok" : "bad"}">${ok ? "= checkpoint root" : `≠ checkpoint root ${fragment(v.root)}`}</span>
</li>`);
	for (let k = v.steps.length - 1; k >= 0; k--) {
		const s = v.steps[k];
		const node = v.spine[k];
		if (s === undefined || node === undefined) {
			continue;
		}
		const sib = v.proof[k] ?? new Uint8Array(32);
		const isLeaf = k === 0;
		rows.push(html`<li class="row ${s.side}" data-lo="${s.lo}" data-hi="${s.hi}">
<span class="sib" tabindex="0"><span class="k">${range(s.lo, s.hi)}</span> <code>${fragment(sib)}</code></span>
<span class="node${isLeaf ? " leaf" : ""}"><span class="k">${isLeaf ? `entry ${v.index}` : "path"}</span> <code>${fragment(node)}</code></span>
</li>`);
	}
	if (v.steps.length === 0) {
		rows.push(
			html`<li class="row"><span class="node leaf"><span class="k">entry ${v.index}</span> <code>${fragment(v.spine[0] ?? computed)}</code></span></li>`,
		);
	}
	rows.push(html`<li class="row base"><span class="data" translate="no">${v.entry}</span></li>`);
	return html`<ol class="proof" aria-label="Audit path for entry ${v.index} in a tree of ${v.size}">${rows}</ol>`;
}
