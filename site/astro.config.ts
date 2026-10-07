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

// The site is static: every page is generated from the repository while it builds. The public
// URL comes from SITE_URL (CI passes the one actions/configure-pages reports, so a custom
// domain is picked up), else the repository's GitHub Pages URL; the base path follows from it.
// Trailing slashes and directory output make the served URL, the canonical URL and the sitemap
// URL of every page the same on GitHub Pages.

import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { codeTheme, codeTransformers } from "./src/lib/code.ts";
import { siteUrl } from "./src/lib/url.ts";

const url = new URL(siteUrl());

export default defineConfig({
	site: url.origin,
	base: url.pathname,
	trailingSlash: "always",
	// Lossless compression, which keeps the space a line break makes between an element and the
	// text after it; Astro 7's default ("jsx") drops it, which glues words in prose templates.
	compressHTML: true,
	build: { format: "directory" },
	integrations: [sitemap({ filter: (page) => !/\/(og|404)\//.test(new URL(page).pathname) })],
	markdown: {
		// Code is set in Dracula, on its own dark surface in both colour schemes (lib/code.ts).
		shikiConfig: { theme: codeTheme, transformers: codeTransformers },
	},
	devToolbar: { enabled: false },
	vite: {
		build: { assetsInlineLimit: 0 },
	},
});
