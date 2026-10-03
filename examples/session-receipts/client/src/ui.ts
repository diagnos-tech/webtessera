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
// DOM helpers for the page; nothing here knows about logs.

import type { Interaction } from "../../shared/interaction.ts";

/** element returns the element with the given id, which index.html must provide. */
export function element<T extends HTMLElement>(id: string, type: new () => T): T {
	const el = document.getElementById(id);
	if (!(el instanceof type)) {
		throw new Error(`index.html has no <${type.name}> with id "${id}"`);
	}
	return el;
}

/** interactionRow renders one recorded interaction and the verdict on its receipt. */
export function interactionRow(
	index: bigint,
	i: Interaction,
	verdict: { ok: boolean; text: string },
): HTMLTableRowElement {
	const tr = document.createElement("tr");
	const cells = [index.toString(), new Date(i.at).toLocaleTimeString(), `${i.method} ${i.path}`, String(i.status)];
	for (const text of [...cells, verdict.text]) {
		const td = document.createElement("td");
		td.textContent = text;
		tr.append(td);
	}
	tr.lastElementChild?.classList.add(verdict.ok ? "ok" : "error");
	return tr;
}
