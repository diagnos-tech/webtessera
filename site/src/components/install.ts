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

// The install command, one tab per package manager README.md lists. The tabs are radio
// buttons, so they work without JavaScript and with the keyboard (arrow keys move between
// them); the page's script only keeps every switcher on the page on the same choice.

import type { PackageManager } from "../data/readme.ts";
import { html, type SafeHtml } from "../shared/html.ts";
import { copyButton } from "./code.ts";

/** installSwitcher renders the package-manager tabs and their commands; group names the radio group. */
export function installSwitcher(managers: readonly PackageManager[], group: string): SafeHtml {
	return html`<div class="install" data-install role="group" aria-label="Install with a package manager">
${managers.map(
	(m, i) =>
		html`<input class="pm-radio" type="radio" name="${group}" id="${group}-${m.name}" value="${m.name}"${i === 0 ? html` checked` : ""}>`,
)}
<div class="pm-tabs">${managers.map((m) => html`<label for="${group}-${m.name}">${m.name}</label>`)}</div>
<div class="pm-panes">${managers.map(
		(m) =>
			html`<code class="install-cmd pm-pane" data-pm="${m.name}"><span class="prompt" aria-hidden="true">$</span> <span data-copy-text>${m.command}</span></code>`,
	)}${copyButton("Copy the install command")}</div>
</div>`;
}
