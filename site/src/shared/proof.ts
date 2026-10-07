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
// which yields them in the same bottom-up order) and lists the audit path: the recomputed
// root at the top, one sibling per level, the leaf at the bottom.

import { fragment, toBase64 } from "./bytes.ts";
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

/**
 * renderProof lists an audit path from the recomputed root down to the entry: the root, then
 * the proof's hashes, each the root of the subtree it stands for, then the entry's leaf hash.
 * Under the path it sets the recomputed root beside the root the checkpoint signs, both as a
 * checkpoint writes a root hash, so that a reader sees them agree or differ.
 */
export function renderProof(v: ProofView): SafeHtml {
	const computed = v.spine[v.spine.length - 1] ?? new Uint8Array(32);
	const ok = fragment(computed, 32) === fragment(v.root, 32);
	const rows: SafeHtml[] = [
		html`<li class="row top"><span class="k">root</span><code class="${ok ? "ok" : "bad"}">${fragment(computed)}</code><span class="verdict ${ok ? "ok" : "bad"}">${ok ? "= the root the checkpoint signs" : "≠ the root the checkpoint signs"}</span></li>`,
	];
	for (let k = v.steps.length - 1; k >= 0; k--) {
		const s = v.steps[k];
		if (s !== undefined) {
			rows.push(
				html`<li class="row sib" data-lo="${s.lo}" data-hi="${s.hi}"><span class="k">${range(s.lo, s.hi)}</span><code>${fragment(v.proof[k] ?? new Uint8Array(32))}</code></li>`,
			);
		}
	}
	rows.push(
		html`<li class="row leaf"><span class="k">entry ${v.index}</span><code>${fragment(v.spine[0] ?? computed)}</code><span class="data" translate="no">${v.entry}</span></li>`,
	);
	return html`<ol class="proof" aria-label="Audit path for entry ${v.index} in a tree of ${v.size}">${rows}</ol><dl class="roots ${ok ? "ok" : "bad"}"><div class="computed"><dt>Recomputed root</dt><dd><code translate="no">${toBase64(computed)}</code></dd></div><div class="signed"><dt>Signed root</dt><dd><code translate="no">${toBase64(v.root)}</code></dd></div></dl>`;
}
