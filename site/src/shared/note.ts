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
// followed by a blank line and one "— <name> <signature>" line per signature. The
// annotations (origin, tree size, root hash) are CSS-generated, so copying the note
// copies exactly the note.

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

/** renderNoteBody renders the lines of a signed checkpoint note, without its frame. */
export function renderNoteBody(view: NoteView): SafeHtml {
	const lines = view.text.replace(/\n$/, "").split("\n");
	return html`${lines.map(
		(line, i) => html`<span class="ln" data-label="${checkpointLabels[i] ?? "extension"}"><span>${line}</span></span>`,
	)}<span class="ln gap" aria-hidden="true"></span>${view.sigs.map(
		(s) =>
			html`<span class="ln sig" data-label="signature"><span>— ${s.name} <span class="sig-b64">${s.base64}</span></span></span>`,
	)}`;
}

/** renderNote renders a signed checkpoint note in its card. */
export function renderNote(view: NoteView, caption: string, bodyId?: string): SafeHtml {
	return html`<figure class="note">
<figcaption class="note-head"><span class="note-path"><span class="verb">GET</span> /checkpoint</span><span class="note-meta">${caption}</span></figcaption>
<div class="note-body" translate="no"${bodyId === undefined ? "" : html` id="${bodyId}"`}>${renderNoteBody(view)}</div>
</figure>`;
}
