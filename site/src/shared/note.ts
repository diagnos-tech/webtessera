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

// Renders a checkpoint the way it travels: as a C2SP signed note, its body lines
// followed by a blank line and one "— <name> <signature>" line per signature, one span
// per line inside the <pre> that holds it. A line may carry its name (origin, tree size,
// root hash, signature) in a span that a selection skips (styles/base.css), so that
// copying the note copies exactly the note.

import { html, type SafeHtml } from "./html.ts";

/** NoteSignature is the part of a note signature the renderer shows. */
export interface NoteSignature {
	readonly name: string;
	readonly base64: string;
}

/** NoteView is a signed note to render. */
export interface NoteView {
	/** text is the note body, ending in a newline. */
	readonly text: string;
	readonly sigs: readonly NoteSignature[];
}

// checkpointLabels names the body lines of a tlog checkpoint (C2SP tlog-checkpoint).
const checkpointLabels = ["origin", "tree size", "root hash"];

/**
 * renderNoteBody renders the lines of a signed checkpoint note, for a <pre class="note">. With
 * `labels`, each line starts with its name, for a <pre class="note labelled">.
 */
export function renderNoteBody(view: NoteView, labels = false): SafeHtml {
	const lines = view.text.replace(/\n$/, "").split("\n");
	const label = (name: string) => (labels ? html`<span class="lbl">${name} </span>` : "");
	return html`${lines.map((line, i) => {
		const name = checkpointLabels[i] ?? "extension";
		return html`<span class="ln" data-label="${name}">${label(name)}<span class="v">${line}</span></span>`;
	})}<span class="ln gap" aria-hidden="true"></span>${view.sigs.map(
		(s) =>
			html`<span class="ln sig" data-label="signature">${label("signature")}<span class="v">— ${s.name} <span class="sig-b64">${s.base64}</span></span></span>`,
	)}`;
}
