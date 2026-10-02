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

// A tiny, typed HTML templating helper shared by the build-time renderer and the live
// demo. Interpolated values are escaped unless they are already SafeHtml, so markup can
// only enter a template on purpose.

/** SafeHtml is markup that was escaped by html`` or explicitly trusted with raw(). */
export class SafeHtml {
	readonly value: string;

	constructor(value: string) {
		this.value = value;
	}

	toString(): string {
		return this.value;
	}
}

/** Interpolation is anything html`` accepts between its literal parts. */
export type Interpolation = SafeHtml | string | number | bigint | boolean | null | undefined | readonly Interpolation[];

const entities: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** escapeHtml escapes text for use in element content and quoted attribute values. */
export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => entities[c] ?? c);
}

function render(value: Interpolation): string {
	if (value === null || value === undefined || value === false) {
		return "";
	}
	if (value instanceof SafeHtml) {
		return value.value;
	}
	if (Array.isArray(value)) {
		return value.map(render).join("");
	}
	return escapeHtml(String(value));
}

/** html renders a template literal, escaping every interpolated value that is not SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: readonly Interpolation[]): SafeHtml {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		out += render(values[i]) + (strings[i + 1] ?? "");
	}
	return new SafeHtml(out);
}

/** raw trusts markup as it is. Only use it for markup produced by code, never for input. */
export function raw(markup: string): SafeHtml {
	return new SafeHtml(markup);
}

/** inlineCode renders `backticked` spans of plain text as <code>, escaping the rest. */
export function inlineCode(text: string): SafeHtml {
	return raw(
		text
			.split(/(`[^`]+`)/)
			.map((part) =>
				part.startsWith("`") && part.endsWith("`") ? html`<code>${part.slice(1, -1)}</code>` : html`${part}`,
			)
			.join(""),
	);
}
