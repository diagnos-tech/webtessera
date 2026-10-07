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

// Renders a receipt the way it travels: a C2SP tlog-proof, line by line, for a <pre>. The
// header line, the optional extra data and the entry's index come first, then the inclusion
// proof's hashes, set in the colour of proof material; after a blank line, the signed
// checkpoint the proof is relative to. Copying the figure copies exactly the receipt.

import { html, type SafeHtml } from "../shared/html.ts";

/** renderReceipt renders the lines of a tlog-proof receipt. */
export function renderReceipt(text: string): SafeHtml {
	let part: "proof" | "checkpoint" = "proof";
	const lines = text
		.replace(/\n$/, "")
		.split("\n")
		.map((line, i) => {
			if (line === "") {
				part = "checkpoint";
				return html`<span class="ln" aria-hidden="true"></span>`;
			}
			if (line.startsWith("— ")) {
				return html`<span class="ln sig">${line}</span>`;
			}
			const hash = part === "proof" && i > 0 && !/^(extra|index) /.test(line);
			return html`<span class="${hash ? "ln proof-hash" : "ln"}">${line}</span>`;
		});
	return html`${lines}`;
}
