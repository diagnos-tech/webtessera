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

// Renders the committed image assets in public/: the 1200x630 social card (og.png) and
// the PNG icons (favicon.png, apple-touch-icon.png), by screenshotting HTML in Chromium.
// The card shows the same real receipt and tile as the page's hero, built with the site's
// own stylesheet and renderers, so it changes only when they do. Run it with `bun run og`
// after changing the design, and commit the result.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logo } from "../src/components/icons.ts";
import { renderReceipt } from "../src/components/receipt.ts";
import { siteConfig } from "../src/config.ts";
import { loadSiteData } from "../src/data/index.ts";
import { html, raw } from "../src/shared/html.ts";
import { renderTile } from "../src/shared/tiles.ts";
import { launch, siteDir } from "./browser.ts";

const repoRoot = join(siteDir, "..");
const styles = ["tokens", "base", "layout", "components", "sections"]
	.map((f) => readFileSync(join(siteDir, "src/styles", `${f}.css`), "utf8"))
	.join("\n");

// The card's own layout, on top of the site's stylesheet.
const card = `
body { width: 1200px; height: 630px; overflow: hidden; }
.og { position: relative; isolation: isolate; display: grid; grid-template-columns: 560px 1fr; gap: 44px;
  align-items: center; height: 630px; padding: 0 56px; }
.og::before { content: ""; position: absolute; inset: 0; z-index: -1;
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 32px 32px; mask-image: radial-gradient(ellipse 70% 80% at 80% 45%, #000 30%, transparent 75%); }
.og .brand { font-size: 30px; gap: 14px; }
.og h1 { margin: 30px 0 22px; font-size: 56px; line-height: 1.04; font-weight: 760; letter-spacing: -0.035em; }
.og .sub { margin: 0; color: var(--ink-2); font-size: 23px; line-height: 1.45; }
.og .badge { display: inline-flex; margin-top: 30px; padding: 6px 14px; border: 1px solid var(--line-2); border-radius: 999px;
  background: var(--surface); color: var(--ink-2); font: 500 17px/1.5 var(--mono); }
.og .art { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 16px 18px; align-items: end; }
.og .receipt { grid-column: 1 / -1; }
.og .note-head { font-size: 13px; }
.og .note-body { padding: 12px 16px 14px; font-size: 13px; line-height: 1.6; }
.og .note-body .ln::after { display: none; }
.og .tile { max-width: 128px; }
.og .tile figcaption { display: none; }
.og .ok { margin: 0 0 6px; color: var(--ink); font: 650 18px/1.4 var(--sans); }
.og .ok code { display: block; margin-bottom: 6px; padding: 0; background: none; color: var(--ink-2); font-size: 14px; font-weight: 500; }
`;

const site = siteConfig(repoRoot, process.env.SITE_URL);
const data = await loadSiteData(repoRoot, site);
const { receipt } = data;
const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${raw(styles + card)}</style></head>
<body><div class="og">
<div>
<p class="brand">${logo(40)}<span class="brand-name">${data.pkg.name}</span></p>
<h1>Transparency logs for browsers, servers and the edge</h1>
<p class="sub">A faithful TypeScript port of Tessera: signed receipts that verify offline, byte for byte with Go.</p>
<p class="badge">Open source · ${data.pkg.license} · ${data.install.command}</p>
</div>
<div class="art">${renderReceipt(receipt.text, "receipt", "returned by log.append()")}${receipt.tile === undefined ? "" : renderTile(receipt.tile, receipt.index)}<p class="ok"><code>verifyReceipt(text, { vkey, data })</code>✓ Entry ${receipt.index} is in the tree of ${receipt.size}</p></div>
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
