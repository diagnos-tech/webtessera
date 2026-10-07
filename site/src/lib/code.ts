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

// How the site highlights code, in one place for the two paths that do it: the Markdown renderer
// (astro.config.ts) and the Code component (components/CodeSample.astro). Both use Shiki's
// Dracula theme with one colour changed.

import type { ShikiConfig } from "astro";

type Transformer = NonNullable<ShikiConfig["transformers"]>[number];

/** codeTheme is the Shiki theme of every code block. */
export const codeTheme = "dracula";

// Dracula sets comments in #6272A4, which is 3.0:1 on its background. The samples' comments are
// prose a reader needs, so they are lifted to the lightest tone of the same hue that still reads
// as secondary: 5.0:1 (--dr-comment in styles/tokens.css).
const dim = "#6272a4";
const lifted = "#8B97CF";

/** codeTransformers are the Shiki transformers of every code block. */
export const codeTransformers: Transformer[] = [
	{
		name: "webtessera:comment-contrast",
		tokens(lines) {
			for (const line of lines) {
				for (const token of line) {
					if (token.color?.toLowerCase() === dim) {
						token.color = lifted;
					}
				}
			}
		},
	},
];
