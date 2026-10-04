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

// The Vite plugins that make the site: one renders the page from the repository into
// index.html and emits sitemap.xml and robots.txt; the other inlines the stylesheet
// into the HTML, so that the first paint needs no second request.

import type { Plugin } from "vite";
import { createHighlight } from "./components/code.ts";
import type { SiteConfig } from "./config.ts";
import { loadSiteData, type SiteData } from "./data/index.ts";
import { type Page, renderPage } from "./render.ts";

interface Rendered {
	readonly data: SiteData;
	readonly page: Page;
}

// watched are the repository paths the page is generated from; editing one in dev reloads.
const watched = [
	"README.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"package.json",
	"NOTICE",
	"LICENSE",
	"docs",
	"examples",
	"fixtures/data",
	"scripts/upstream.json",
	"scripts/test-parity-allowlist.json",
	"scripts/interop",
	"src",
	".github",
];

function report(data: SiteData, info: (msg: string) => void, warn: (msg: string) => void): void {
	if (data.reserved.length > 0) {
		info(`not listing entry points without a source yet: ${data.reserved.join(", ")}`);
	}
	if (data.drift.length > 0) {
		warn(`README.md differs from the tested source for ${data.drift.join(", ")}; the page shows the source`);
	}
}

/** sitePlugins returns the plugins that generate the page from the repository at repoRoot. */
export function sitePlugins(repoRoot: string, site: SiteConfig): Plugin[] {
	let rendered: Promise<Rendered> | undefined;
	const render = (): Promise<Rendered> => {
		rendered ??= (async () => {
			const [data, hl] = await Promise.all([loadSiteData(repoRoot, site), createHighlight()]);
			return { data, page: renderPage(data, hl) };
		})();
		return rendered;
	};

	const content: Plugin = {
		name: "webtessera-site:content",
		transformIndexHtml: {
			order: "pre",
			async handler(html) {
				const { page } = await render();
				return html.replace("<!--site:head-->", page.head).replace("<!--site:body-->", page.body);
			},
		},
		async buildStart() {
			const { data } = await render();
			report(
				data,
				(msg) => this.info(msg),
				(msg) => this.warn(msg),
			);
		},
		async generateBundle() {
			const { data } = await render();
			const lastmod = data.lastModified === undefined ? "" : `<lastmod>${data.lastModified}</lastmod>`;
			this.emitFile({
				type: "asset",
				fileName: "sitemap.xml",
				source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${site.url}</loc>${lastmod}</url>\n</urlset>\n`,
			});
			this.emitFile({
				type: "asset",
				fileName: "robots.txt",
				source: `User-agent: *\nAllow: /\n\nSitemap: ${new URL("sitemap.xml", site.url).href}\n`,
			});
		},
		configureServer(server) {
			server.watcher.add(watched.map((p) => `${repoRoot}/${p}`));
			server.watcher.on("change", (file) => {
				if (file.startsWith(repoRoot) && !file.includes("/site/") && !file.includes("/node_modules/")) {
					rendered = undefined;
					server.ws.send({ type: "full-reload" });
				}
			});
		},
	};

	const inlineCss: Plugin = {
		name: "webtessera-site:inline-css",
		apply: "build",
		transformIndexHtml: {
			order: "post",
			handler(html, ctx) {
				const bundle = ctx.bundle;
				if (bundle === undefined) {
					return html;
				}
				return html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (tag, href: string) => {
					const name = Object.keys(bundle).find((f) => href.endsWith(`/${f}`));
					const asset = name === undefined ? undefined : bundle[name];
					if (name === undefined || asset === undefined || asset.type !== "asset") {
						return tag;
					}
					delete bundle[name];
					return `<style>${String(asset.source)}</style>`;
				});
			},
		},
	};

	return [content, inlineCss];
}
