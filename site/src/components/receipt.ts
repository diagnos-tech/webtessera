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

// Renders a receipt the way it travels: a C2SP tlog-proof, line by line. The header line,
// the optional extra data, the entry's index and its inclusion proof come first; after a
// blank line, the signed checkpoint the proof is relative to. As in the signed-note card,
// the annotations are CSS-generated, so copying the receipt copies exactly the receipt.

import { html, type SafeHtml } from "../shared/html.ts";

// checkpointLabels names the body lines of a tlog checkpoint (C2SP tlog-checkpoint).
const checkpointLabels = ["origin", "tree size", "root hash"];

/** receiptLines labels each line of a tlog-proof. */
function receiptLines(text: string): { line: string; label: string }[] {
	const lines = text.replace(/\n$/, "").split("\n");
	const out: { line: string; label: string }[] = [];
	let part: "proof" | "checkpoint" | "signatures" = "proof";
	let hashes = 0;
	let body = 0;
	lines.forEach((line, i) => {
		if (line === "") {
			part = part === "proof" ? "checkpoint" : "signatures";
			out.push({ line, label: "" });
			return;
		}
		if (part === "proof") {
			const label =
				i === 0
					? "format"
					: line.startsWith("extra ")
						? "extra data"
						: line.startsWith("index ")
							? "entry index"
							: hashes++ === 0
								? "proof"
								: "";
			out.push({ line, label });
		} else if (part === "checkpoint") {
			out.push({ line, label: checkpointLabels[body++] ?? "extension" });
		} else {
			out.push({ line, label: line.startsWith("— ") ? "signature" : "" });
		}
	});
	return out;
}

/** renderReceipt renders a tlog-proof receipt in the signed-note card style. */
export function renderReceipt(text: string, path: string, meta: string): SafeHtml {
	const body = receiptLines(text).map(({ line, label }) => {
		if (line === "") {
			return html`<span class="ln gap" aria-hidden="true"></span>`;
		}
		if (label === "signature") {
			const [, name = "", sig = ""] = /^— (\S+) (\S+)$/.exec(line) ?? [];
			return html`<span class="ln sig" data-label="signature"><span>— ${name} <span class="sig-b64">${sig}</span></span></span>`;
		}
		const cls = label === "proof" || label === "" ? "ln proof-hash" : "ln";
		return html`<span class="${cls}" data-label="${label}"><span>${line}</span></span>`;
	});
	return html`<figure class="note receipt">
<figcaption class="note-head"><span class="note-path"><span class="verb">tlog-proof</span> ${path}</span><span class="note-meta">${meta}</span></figcaption>
<div class="note-body" translate="no">${body}</div>
</figure>`;
}
