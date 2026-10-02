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

// The document head: title and description, canonical URL, Open Graph and Twitter
// cards, structured data (schema.org SoftwareSourceCode and WebSite), icons and theme
// colours. Everything comes from package.json and the site configuration.

import type { SiteData } from "../data/index.ts";
import { html, raw, type SafeHtml } from "../shared/html.ts";

/** ogImage describes the social card committed in public/ (see scripts/og.ts). */
export const ogImage = { path: "og.png", width: 1200, height: 630 };

/** pageTitle is the document title. */
export function pageTitle(d: SiteData): string {
	return `${d.pkg.name} · Tessera transparency logs in TypeScript`;
}

/** jsonLd renders structured data, escaped so that no string can close the script element. */
function jsonLd(d: SiteData): SafeHtml {
	const { site, pkg } = d;
	const graph = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "SoftwareSourceCode",
				"@id": `${site.url}#software`,
				name: pkg.name,
				description: pkg.description,
				url: site.url,
				codeRepository: site.repo,
				programmingLanguage: { "@type": "ComputerLanguage", name: "TypeScript" },
				runtimePlatform: ["Node.js", "Deno", "Bun", "Web browsers", "Edge runtimes"],
				license: `https://spdx.org/licenses/${pkg.license}.html`,
				version: pkg.version,
				keywords: pkg.keywords.join(", "),
				isBasedOn: site.tessera,
				author: { "@type": "Organization", name: pkg.author },
				...(d.lastModified === undefined ? {} : { dateModified: d.lastModified }),
			},
			{
				"@type": "WebSite",
				"@id": `${site.url}#website`,
				name: pkg.name,
				url: site.url,
				description: pkg.description,
				inLanguage: "en",
				about: { "@id": `${site.url}#software` },
			},
		],
	};
	const json = JSON.stringify(graph).replace(/</g, "\\u003c");
	return raw(`<script type="application/ld+json">${json}</script>`);
}

/** renderHead renders everything the head needs besides charset, viewport, styles and scripts. */
export function renderHead(d: SiteData): SafeHtml {
	const { site, pkg } = d;
	const title = pageTitle(d);
	const image = new URL(ogImage.path, site.url).href;
	const alt = `${pkg.name}: a signed checkpoint and a tile of hashes, with the words “Transparency logs for browsers, servers and the edge”.`;
	return html`<title>${title}</title>
<meta name="description" content="${pkg.description}">
<link rel="canonical" href="${site.url}">
<meta name="robots" content="index, follow">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafaf7">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0c0f13">
<meta name="author" content="${pkg.author}">
<meta name="keywords" content="${pkg.keywords.join(", ")}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${pkg.name}">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="${site.url}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${pkg.description}">
<meta property="og:image" content="${image}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${ogImage.width}">
<meta property="og:image:height" content="${ogImage.height}">
<meta property="og:image:alt" content="${alt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${pkg.description}">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="${alt}">
${jsonLd(d)}`;
}
