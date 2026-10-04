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

// Smoke test of the built site (dist/), in a real Chromium: the page loads without
// console errors or layout shifts, carries its SEO metadata, reads completely without
// JavaScript, fits a 320 px screen, its install switcher works with and without script,
// and the live demo appends an entry, verifies its inclusion proof, rejects a tampered one
// and fills a tile. Run `bun run build` first; `bun run ci` does both.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Page } from "playwright";
import { siteConfig } from "../src/config.ts";
import { launch, serve, siteDir } from "./browser.ts";

const repoRoot = join(siteDir, "..");
const site = siteConfig(repoRoot, process.env.SITE_URL);
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
const sections = [
	"quick-start",
	"concepts",
	"demo",
	"storage",
	"serve",
	"examples",
	"compatibility",
	"security",
	"api",
	"runtimes",
];
// The examples the page must list: every directory of examples/ with a package.json.
const exampleDirs = readdirSync(join(repoRoot, "examples")).filter((d) =>
	existsSync(join(repoRoot, "examples", d, "package.json")),
);

let failures = 0;

function check(ok: boolean, what: string, detail = ""): void {
	if (!ok) {
		failures++;
	}
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${what}${detail === "" ? "" : `: ${detail}`}\n`);
}

function heading(text: string): void {
	process.stdout.write(`\n${text}\n`);
}

/** watch collects console errors, uncaught exceptions and failed requests. */
function watch(page: Page): string[] {
	const problems: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") {
			problems.push(`console: ${m.text()}`);
		}
	});
	page.on("pageerror", (e) => problems.push(`exception: ${e.message}`));
	page.on("response", (r) => {
		if (r.status() >= 400) {
			problems.push(`HTTP ${r.status()} ${r.url()}`);
		}
	});
	page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()}`));
	return problems;
}

async function seo(page: Page, url: string): Promise<void> {
	heading("SEO and metadata");
	const meta = (sel: string) => page.locator(sel).first().getAttribute("content");
	const title = await page.title();
	check(title.length > 10 && title.length <= 65 && title.includes("webtessera"), "title", title);
	const description = (await meta('meta[name="description"]')) ?? "";
	check(description.length >= 70 && description.length <= 170, "meta description", `${description.length} chars`);
	check((await page.locator('link[rel="canonical"]').getAttribute("href")) === site.url, "canonical URL", site.url);
	check((await page.locator("html").getAttribute("lang")) === "en", 'html lang="en"');
	check((await meta('meta[property="og:title"]')) === title, "og:title");
	const image = (await meta('meta[property="og:image"]')) ?? "";
	check(image === new URL("og.png", site.url).href, "og:image is absolute", image);
	check(
		(await meta('meta[property="og:image:width"]')) === "1200" &&
			(await meta('meta[property="og:image:height"]')) === "630",
		"og:image is 1200x630",
	);
	check((await meta('meta[name="twitter:card"]')) === "summary_large_image", "twitter:card");
	check((await page.locator('meta[name="theme-color"]').count()) === 2, "theme-color for light and dark");
	const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}") as {
		"@graph"?: {
			"@type": string;
			version?: string;
			codeRepository?: string;
			license?: string;
			programmingLanguage?: { name?: string };
			isBasedOn?: { codeRepository?: string };
		}[];
	};
	const code = ld["@graph"]?.find((n) => n["@type"] === "SoftwareSourceCode");
	check(
		code?.version === pkg.version &&
			code.codeRepository === site.repo &&
			code.license !== undefined &&
			code.programmingLanguage?.name === "TypeScript",
		"JSON-LD SoftwareSourceCode",
		`version ${code?.version}`,
	);
	check(code?.isBasedOn?.codeRepository === site.tessera, "JSON-LD isBasedOn Tessera", code?.isBasedOn?.codeRepository);
	check(ld["@graph"]?.some((n) => n["@type"] === "WebSite") === true, "JSON-LD WebSite");
	check((await page.locator("h1").count()) === 1, "exactly one h1");
	check((await page.locator("img:not([alt])").count()) === 0, "every image has alt text");
	const levels = await page
		.locator("main h1, main h2, main h3, main h4")
		.evaluateAll((els) => els.map((e) => Number(e.tagName.slice(1))));
	const skipped = levels.findIndex((l, i) => i > 0 && l > (levels[i - 1] ?? 1) + 1);
	check(skipped < 0, "heading levels are not skipped", skipped < 0 ? `${levels.length} headings` : `at #${skipped}`);
	for (const path of ["robots.txt", "sitemap.xml", "og.png", "favicon.svg", "favicon.png", "apple-touch-icon.png"]) {
		const r = await page.request.get(new URL(path, url).href);
		check(r.ok(), `serves ${path}`, `${r.status()} ${r.headers()["content-type"] ?? ""}`);
	}
	const sitemap = await (await page.request.get(new URL("sitemap.xml", url).href)).text();
	check(sitemap.includes(`<loc>${site.url}</loc>`), "sitemap lists the canonical URL");
}

async function content(page: Page, label: string): Promise<void> {
	heading(`Content (${label})`);
	for (const id of sections) {
		check((await page.locator(`section#${id} h2`).count()) === 1, `section #${id}`);
	}
	const navTargets = await page
		.locator(".site-nav a")
		.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).hash));
	check(
		navTargets.join(" ") === sections.map((id) => `#${id}`).join(" "),
		"navigation links every section",
		navTargets.join(" "),
	);
	check(
		(await page.locator("pre.shiki").count()) >= 4,
		"highlighted code samples",
		`${await page.locator("pre.shiki").count()}`,
	);
	check(
		(await page.locator(".hero .receipt .note-body .ln").first().textContent()) === "c2sp.org/tlog-proof@v1",
		"hero receipt is a tlog-proof",
	);
	check(
		(await page.locator('.hero .receipt [data-label="origin"]').textContent()) === site.origin,
		"hero receipt's checkpoint origin line",
	);
	check(
		(await page.locator("#quick-start pre.shiki").first().textContent())?.includes("openServerLog") === true,
		"the quick start opens with the safe API",
	);
	check((await page.locator("#api details.pkg").count()) >= 10, "package map lists entry points");
	check((await page.locator(".port-grid i").count()) > 100, "porting map mosaic");
	const listed = await page
		.locator("#examples .example h3 a")
		.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
	check(
		listed.length === exampleDirs.length &&
			exampleDirs.every((dir) => listed.some((h) => h.endsWith(`/examples/${dir}`))),
		"every example is listed, with a link to its folder",
		`${listed.length} of ${exampleDirs.length}`,
	);
	const commands = await page.locator(".hero .install .pm-pane").evaluateAll((els) =>
		els.map((e) => ({
			text: e.textContent?.replace(/^\$\s*/, "").trim() ?? "",
			shown: (e as HTMLElement).offsetParent !== null,
		})),
	);
	check(
		["npm", "bun", "pnpm", "yarn"].every((m) => commands.some((c) => c.text.startsWith(`${m} `))),
		"install commands for npm, bun, pnpm and yarn",
		commands.map((c) => c.text).join(" | "),
	);
	check(commands.filter((c) => c.shown).length === 1, "exactly one install command is on show");
}

async function installSwitcher(page: Page): Promise<void> {
	heading("Install switcher");
	await page.locator(".hero .pm-tabs label", { hasText: "pnpm" }).click();
	const shown = async (scope: string) =>
		page
			.locator(`${scope} .pm-pane`)
			.evaluateAll((els) =>
				els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.textContent?.trim() ?? ""),
			);
	const hero = await shown(".hero");
	check(hero.length === 1 && hero[0]?.includes("pnpm add") === true, "choosing pnpm shows its command", hero.join(""));
	const start = await shown("#quick-start");
	check(start[0]?.includes("pnpm add") === true, "the quick start's switcher follows", start.join(""));
	await page.locator(".hero .pm-tabs label", { hasText: "npm" }).first().click();
}

async function layoutShift(page: Page): Promise<void> {
	heading("Layout stability");
	const cls = await page.evaluate(
		() =>
			new Promise<number>((resolve) => {
				let total = 0;
				new PerformanceObserver((list) => {
					for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
						if (!e.hadRecentInput) {
							total += e.value;
						}
					}
				}).observe({ type: "layout-shift", buffered: true });
				setTimeout(() => resolve(total), 1500);
			}),
	);
	check(cls < 0.05, "cumulative layout shift on load", cls.toFixed(4));
}

async function demo(page: Page): Promise<void> {
	heading("Live demo");
	await page.locator("#demo").scrollIntoViewIfNeeded();
	await page.waitForSelector('[data-demo][data-live="true"]', { timeout: 20_000 });
	check(true, "the log starts in the tab");
	const sizeLine = page.locator("[data-demo-note] .ln").nth(1);
	const before = Number(await sizeLine.textContent());
	const text = `smoke test ${Date.now()}`;
	await page.fill("#demo-entry", text);
	await page.click('[data-demo-form] button[type="submit"]');
	await page.waitForFunction(
		(n) => Number(document.querySelectorAll("[data-demo-note] .ln")[1]?.textContent) === n + 1,
		before,
		{ timeout: 20_000 },
	);
	check(true, "appending publishes a checkpoint one entry larger", `${before} -> ${before + 1}`);
	check(
		(await page.locator("[data-demo-entries] li .tx").first().textContent()) === text,
		"the entry is read back from its bundle",
	);
	await page.waitForSelector("[data-demo-proof] .verdict-line.ok", { timeout: 10_000 });
	const verdict = (await page.locator("[data-demo-proof] .verdict-line").textContent()) ?? "";
	check(
		verdict.includes(`Entry ${before} is in the tree of ${before + 1}`),
		"its inclusion proof verifies",
		verdict.trim(),
	);
	await page.check("[data-demo-tamper]");
	await page.waitForSelector("[data-demo-proof] .verdict-line.bad", { timeout: 10_000 });
	check(
		true,
		"a tampered entry's proof is rejected",
		((await page.locator("[data-demo-proof] code").first().textContent()) ?? "").slice(0, 80),
	);
	await page.uncheck("[data-demo-tamper]");
	await page.waitForSelector("[data-demo-proof] .verdict-line.ok", { timeout: 10_000 });
	await page.click("[data-demo-fill]");
	await page.waitForSelector('[data-demo-tiles] .tile[data-level="1"]', { timeout: 30_000 });
	const files = await page.locator("[data-demo-files] code").allTextContents();
	check(
		files.includes("tile/0/000") && files.includes("tile/1/000.p/1"),
		"filling the tile creates tile/0/000 and tile/1/000.p/1",
		files.join(" "),
	);
}

async function noScript(url: string): Promise<void> {
	heading("Without JavaScript");
	const browser = await launch();
	const page = await browser.newPage({ javaScriptEnabled: false });
	await page.goto(url);
	await content(page, "no JavaScript");
	check(await page.locator(".demo-form").isHidden(), "demo controls are hidden");
	check(await page.locator("button[data-copy]").first().isHidden(), "copy buttons are hidden");
	check(
		(await page.locator("[data-demo-proof] .verdict-line.ok").count()) === 1,
		"the build-time proof is shown, verified",
	);
	await browser.close();
}

async function narrow(page: Page, url: string): Promise<void> {
	heading("Small screens");
	for (const width of [320, 375]) {
		await page.setViewportSize({ width, height: 800 });
		await page.goto(url);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		check(overflow <= 0, `no horizontal scrolling at ${width} px`, overflow > 0 ? `${overflow} px too wide` : "");
	}
}

function sizes(): void {
	heading("Page weight (dist/)");
	const dist = join(siteDir, "dist");
	const files = ["index.html", ...readdirSync(join(dist, "assets")).map((f) => `assets/${f}`)];
	for (const f of files) {
		const data = readFileSync(join(dist, f));
		const gz = gzipSync(data, { level: 9 }).length;
		process.stdout.write(
			`  ${f.padEnd(28)} ${(statSync(join(dist, f)).size / 1024).toFixed(1).padStart(7)} KiB  ${(gz / 1024).toFixed(1).padStart(6)} KiB gzip\n`,
		);
	}
}

const served = await serve();
const browser = await launch();
try {
	process.stdout.write(`Smoke-testing ${served.url} (canonical ${site.url})\n`);
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const problems = watch(page);
	await page.goto(served.url);
	await layoutShift(page);
	await seo(page, served.url);
	await content(page, "JavaScript on");
	await installSwitcher(page);
	await demo(page);
	await narrow(page, served.url);
	heading("Console");
	check(problems.length === 0, "no console errors, exceptions or failed requests", problems.join("; "));
	await noScript(served.url);
	sizes();
} finally {
	await browser.close();
	await served.close();
}

process.stdout.write(failures === 0 ? "\nAll smoke checks passed.\n" : `\n${failures} smoke check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
