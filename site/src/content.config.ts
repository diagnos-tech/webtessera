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

// The repository Markdown the site renders: every guide in docs/guides, every example's
// README, and the sections of other documents that the compatibility and security pages show.
// Adding a guide or an example adds its page.

import { defineCollection } from "astro:content";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "astro/zod";
import { repoMarkdown, type Source } from "./lib/loader.ts";
import { describe } from "./lib/markdown.ts";
import { guideSlug } from "./lib/routes.ts";

// lead is the document's first paragraph, as HTML; the page shows it before its contents list.
const schema = z.object({ title: z.string(), description: z.string(), lead: z.string(), file: z.string() });

const guides = defineCollection({
	loader: repoMarkdown("guides", (root) =>
		readdirSync(join(root, "docs/guides"))
			.filter((f) => f.endsWith(".md") && f !== "README.md")
			.sort()
			.map((f): Source => ({ id: guideSlug(f), file: `docs/guides/${f}` })),
	),
	schema,
});

const examples = defineCollection({
	loader: repoMarkdown("examples", (root) =>
		readdirSync(join(root, "examples"))
			.filter((d) => existsSync(join(root, "examples", d, "package.json")))
			.filter((d) => existsSync(join(root, "examples", d, "README.md")))
			.sort()
			.map((d): Source => {
				const pkg = JSON.parse(readFileSync(join(root, "examples", d, "package.json"), "utf8")) as {
					description?: string;
				};
				return {
					id: d,
					file: `examples/${d}/README.md`,
					...(pkg.description === undefined ? {} : { description: describe(pkg.description) }),
				};
			}),
	),
	schema,
});

const excerpts = defineCollection({
	loader: repoMarkdown("excerpts", () => [
		{ id: "reporting", file: "SECURITY.md", section: "## Reporting a vulnerability" },
		{ id: "hardening", file: "CHANGELOG.md", section: "### Security", adrs: true },
		{ id: "compared", file: "docs/compatibility.md", section: "## What is compared" },
		{ id: "reproducing", file: "docs/compatibility.md", section: "## Reproducing locally" },
	]),
	schema,
});

export const collections = { guides, examples, excerpts };
