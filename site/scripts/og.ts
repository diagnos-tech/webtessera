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

// Renders the committed image assets in public/: the 1200x630 social card (og.png) and
// the PNG icons (favicon.png, apple-touch-icon.png), by screenshotting HTML in Chromium.
// The card shows the same real checkpoint and tile as the page, built with the site's own
// stylesheet and renderers, so it changes only when they do. Run it with `bun run og` after
// changing the design, and commit the result.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logo } from "../src/components/icons.ts";
import { siteConfig } from "../src/config.ts";
import { loadSiteData } from "../src/data/index.ts";
import { html, raw } from "../src/shared/html.ts";
import { renderNote } from "../src/shared/note.ts";
import { renderTile } from "../src/shared/tiles.ts";
import { launch, siteDir } from "./browser.ts";

const repoRoot = join(siteDir, "..");
const styles = ["tokens", "base", "layout", "components", "sections"]
	.map((f) => readFileSync(join(siteDir, "src/styles", `${f}.css`), "utf8"))
	.join("\n");

// The card's own layout, on top of the site's stylesheet.
const card = `
body { width: 1200px; height: 630px; overflow: hidden; }
.og { position: relative; isolation: isolate; display: grid; grid-template-columns: 580px 1fr; gap: 48px;
  align-items: center; height: 630px; padding: 0 60px; }
.og::before { content: ""; position: absolute; inset: 0; z-index: -1;
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 32px 32px; mask-image: radial-gradient(ellipse 70% 80% at 80% 45%, #000 30%, transparent 75%); }
.og .brand { font-size: 30px; gap: 14px; }
.og h1 { margin: 32px 0 22px; font-size: 56px; line-height: 1.04; font-weight: 760; letter-spacing: -0.035em; }
.og .sub { margin: 0; color: var(--ink-2); font-size: 23px; line-height: 1.45; }
.og .install { margin-top: 34px; max-width: 400px; box-shadow: none; padding: 10px 18px; }
.og .install-cmd { font-size: 20px; }
.og .art { display: grid; gap: 18px; justify-items: start; }
.og .note { width: 100%; }
.og .note-body { font-size: 15px; }
.og .note-body .ln::after { display: none; }
.og .tile { max-width: 170px; }
`;

const site = siteConfig(repoRoot, process.env.SITE_URL);
const data = await loadSiteData(repoRoot, site);
const tile = data.sample.tiles[0];
const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${raw(styles + card)}</style></head>
<body><div class="og">
<div>
<p class="brand">${logo(40)}<span class="brand-name">${data.pkg.name}</span></p>
<h1>Transparency logs for browsers, servers and the edge</h1>
<p class="sub">A faithful TypeScript port of Tessera, byte-for-byte compatible with it. Open source, Apache-2.0.</p>
<div class="install"><code class="install-cmd"><span class="prompt">$</span> ${data.install.command}</code></div>
</div>
<div class="art">${renderNote(data.sample.note, "signed by webtessera")}${tile === undefined ? "" : renderTile(tile)}</div>
</div></body></html>`;

const browser = await launch();
try {
	const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: "light" });
	await og.setContent(page.value);
	writeFileSync(join(siteDir, "public/og.png"), await og.screenshot({ type: "png" }));

	const svg = readFileSync(join(siteDir, "public/favicon.svg"), "utf8");
	const src = `data:image/svg+xml;base64,${btoa(svg)}`;
	for (const [file, size, pad, bg] of [
		["favicon.png", 32, 0, "transparent"],
		["apple-touch-icon.png", 180, 24, "#fafaf7"],
	] as const) {
		const icon = await browser.newPage({ viewport: { width: size, height: size }, colorScheme: "light" });
		await icon.setContent(
			`<body style="margin:0;background:${bg}"><img src="${src}" style="display:block;width:${size - 2 * pad}px;height:${size - 2 * pad}px;margin:${pad}px"></body>`,
		);
		writeFileSync(
			join(siteDir, "public", file),
			await icon.screenshot({ type: "png", omitBackground: bg === "transparent" }),
		);
	}
	process.stdout.write("wrote public/og.png, public/favicon.png and public/apple-touch-icon.png\n");
} finally {
	await browser.close();
}
