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

// The landing page is index.html with its content generated from the repository at
// build time (src/plugin.ts). SITE_URL overrides the public URL, which defaults to the
// repository's GitHub Pages URL; the base path follows from it.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { siteConfig } from "./src/config.ts";
import { sitePlugins } from "./src/plugin.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const site = siteConfig(repoRoot, process.env.SITE_URL);

export default defineConfig({
	base: site.base,
	plugins: sitePlugins(repoRoot.replace(/\/$/, ""), site),
	build: {
		target: "es2022",
		modulePreload: { polyfill: false },
		assetsInlineLimit: 0,
		reportCompressedSize: true,
	},
	preview: { port: 4173 },
});
