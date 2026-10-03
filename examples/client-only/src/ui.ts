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

/** element returns the element with the given id, which index.html must provide. */
export function element<T extends HTMLElement>(id: string, type: new () => T): T {
	const el = document.getElementById(id);
	if (!(el instanceof type)) {
		throw new Error(`index.html has no <${type.name}> with id "${id}"`);
	}
	return el;
}

/** listItem renders one event of the list, at its index in the log. */
export function listItem(index: bigint, text: string, note: string): HTMLLIElement {
	const li = document.createElement("li");
	li.value = Number(index) + 1;
	const small = document.createElement("span");
	small.className = "ok";
	small.textContent = ` ${note}`;
	li.append(text, small);
	return li;
}

/** toBase64 renders a hash the way receipts do. */
export function toBase64(b: Uint8Array): string {
	return btoa(String.fromCharCode(...b));
}
