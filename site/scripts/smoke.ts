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

// Smoke test of the built site (dist/), in a real Chromium, served as GitHub Pages serves it.
// Every page in the sitemap, and every page a link reaches, must render without console errors,
// failed or third-party requests, with its own title, description, canonical URL, social image
// and valid structured data, one h1 and headings in order, and no horizontal scrolling on a
// phone. Every internal link and #fragment must resolve, and every link into this repository
// must name a file that exists. The home page must keep to its length budget (a hero, the live
// demo and one section of code), the pages must show the facts the build derives from the
// repository, the home page must read without JavaScript, and the live demo must run: append
// an entry, verify it, detect a changed entry, and start over. Run `bun run build` first;
// `bun run ci` does both.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type Browser, chromium, type Page } from "playwright";
import { siteConfig } from "../src/lib/url.ts";
import { distDir, serve } from "./serve.ts";

const root = join(distDir, "..", "..");
const site = siteConfig(root);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	license: string;
	exports: Record<string, unknown>;
};

/**
 * The home page's length budget: a hero, the live demo and one section of code, and nothing
 * else. Words are prose outside the demo and the code; heights are of the whole page.
 */
const budget = { words: 350, h2: 2, code: 3, codeLines: 12, tables: 0, nav: 4, js: 2048, h1440: 4500, h390: 7000 };

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

// What the repository says the site must show.
const fixtureCount = readdirSync(join(root, "fixtures/data")).filter(
	(f) => f.endsWith(".json") && !f.startsWith("differential_"),
).length;
const exampleDirs = readdirSync(join(root, "examples")).filter((d) =>
	existsSync(join(root, "examples", d, "package.json")),
);
const guideSlugs = readdirSync(join(root, "docs/guides"))
	.filter((f) => f.endsWith(".md") && f !== "README.md")
	.map((f) => f.replace(/\.md$/, ""));
const specifiers = Object.entries(pkg.exports)
	.filter(([, v]) => {
		const target = typeof v === "string" ? v : ((v as Record<string, string>).default ?? "");
		return (
			target.endsWith(".js") && existsSync(join(root, target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")))
		);
	})
	.map(([k]) => (k === "." ? "webtessera" : `webtessera/${k.slice(2)}`));
const { loadTestMatrix } = await import("../src/data/ci.ts");
const { Repo } = await import("../src/data/repo.ts");
const ciJobs = loadTestMatrix(new Repo(root)).jobs.flatMap((g) => g.jobs);

/** PageReport is what one visit to a page found. */
interface PageReport {
	readonly path: string;
	readonly title: string;
	readonly links: readonly string[];
	readonly ids: readonly string[];
}

/** watch collects console errors, exceptions, failed requests and requests to other origins. */
function watch(page: Page, origin: string): string[] {
	const problems: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error" && !(m.text().includes("404") && page.url().endsWith("/404/"))) {
			problems.push(`console: ${m.text()}`);
		}
	});
	page.on("pageerror", (e) => problems.push(`exception: ${e.message}`));
	page.on("request", (r) => {
		if (!r.url().startsWith(origin) && !r.url().startsWith("data:")) {
			problems.push(`third-party request: ${r.url()}`);
		}
	});
	page.on("response", (r) => {
		if (r.status() >= 400 && !(r.request().resourceType() === "document" && r.url().endsWith("/404/"))) {
			problems.push(`HTTP ${r.status()} ${r.url()}`);
		}
	});
	page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()}`));
	return problems;
}

/** local maps a URL of the published site to the same page on the local server. */
function local(url: string, served: string): string {
	return url.startsWith(site.url) ? served + url.slice(site.url.length) : url;
}

/** visit loads a page and checks what every page must have. */
async function visit(browser: Browser, served: string, path: string): Promise<PageReport> {
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	const problems = watch(page, new URL(served).origin);
	const response = await page.goto(served + path, { waitUntil: "networkidle" });
	const where = `/${path}`;
	// Every check of the page is gathered, and the page is reported on one line.
	const issues: string[] = [];
	const need = (ok: boolean, what: string, detail = "") => {
		if (!ok) {
			issues.push(detail === "" ? what : `${what} (${detail})`);
		}
	};
	need(response?.status() === (path === "404/" ? 404 : 200), `renders`, String(response?.status()));
	const head = await page.evaluate(() => {
		const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content") ?? "";
		const levels = [...document.querySelectorAll("main h1, main h2, main h3, main h4")].map((h) =>
			Number(h.tagName[1]),
		);
		return {
			title: document.title,
			lang: document.documentElement.lang,
			description: meta('meta[name="description"]'),
			canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "",
			ogUrl: meta('meta[property="og:url"]'),
			ogImage: meta('meta[property="og:image"]'),
			themes: document.querySelectorAll('meta[name="theme-color"]').length,
			h1: document.querySelectorAll("h1").length,
			skipped: levels.findIndex((l, i) => i > 0 && l > (levels[i - 1] ?? 1) + 1),
			unlabelled: document.querySelectorAll("img:not([alt]), svg[role='img']:not([aria-label]):not([aria-labelledby])")
				.length,
			ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? ""),
			links: [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => a.href),
			ids: [...document.querySelectorAll("[id]")].map((e) => e.id),
			overflow: document.documentElement.scrollWidth - window.innerWidth,
		};
	});
	const canonical = new URL(path, site.url).href;
	need(head.lang === "en" && head.themes === 2, `has lang="en" and both theme colours`);
	need(head.title.length > 0 && (path === "" || head.title.endsWith(" | webtessera")), `title`, head.title);
	need(
		head.description.length >= 70 && head.description.length <= 160,
		`description`,
		`${head.description.length} characters`,
	);
	need(head.canonical === canonical && head.ogUrl === canonical, `canonical and og:url`, head.canonical);
	const image = head.ogImage.startsWith(site.url) ? join(distDir, head.ogImage.slice(site.url.length)) : "";
	need(image !== "" && existsSync(image), `og:image exists`, head.ogImage);
	need(head.h1 === 1 && head.skipped < 0, `has one h1 and no skipped heading level`);
	need(head.unlabelled === 0, `images and diagrams are labelled`);
	need(head.overflow <= 0, `has no horizontal scroll at 390 px`, head.overflow > 0 ? `${head.overflow} px` : "");
	let ld: { "@graph"?: Record<string, unknown>[] } = {};
	try {
		ld = JSON.parse(head.ld[0] ?? "{}") as typeof ld;
	} catch (e) {
		need(false, `JSON-LD parses`, String(e));
	}
	const types = (ld["@graph"] ?? []).map((n) => n["@type"]);
	if (path.startsWith("docs/") || path.startsWith("examples/")) {
		need(types.includes("TechArticle") && types.includes("BreadcrumbList"), `JSON-LD`, types.join(", "));
	}
	need(problems.length === 0, `has no console errors or failed or third-party requests`, problems.join("; "));
	check(issues.length === 0, where, issues.join("; ") || head.title);
	await page.close();
	return { path, title: head.title, links: head.links, ids: head.ids };
}

/** sitemapPaths reads the sitemap index and its sitemaps, as paths under the base. */
async function sitemapPaths(served: string): Promise<string[]> {
	const index = await (await fetch(`${served}sitemap-index.xml`)).text();
	const paths: string[] = [];
	for (const loc of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
		const xml = await (await fetch(local(loc[1] ?? "", served))).text();
		for (const page of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
			paths.push((page[1] ?? "").slice(site.url.length));
		}
	}
	return paths;
}

/** crawl visits every page of the sitemap and every page a link reaches, and checks the links. */
async function crawl(browser: Browser, served: string): Promise<Map<string, PageReport>> {
	heading("Every page");
	const fromSitemap = await sitemapPaths(served);
	check(fromSitemap.includes("") && !fromSitemap.includes("404/"), "the sitemap lists the home page, not the 404 page");
	const queue = [...fromSitemap, "404/"];
	const seen = new Map<string, PageReport>();
	const repoLinks = new Set<string>();
	const unslashed = new Set<string>();
	while (queue.length > 0) {
		const path = queue.shift() ?? "";
		if (seen.has(path)) {
			continue;
		}
		const report = await visit(browser, served, path);
		seen.set(path, report);
		for (const link of report.links) {
			const url = new URL(link);
			if (link.startsWith(served)) {
				const target = url.pathname.slice(new URL(served).pathname.length);
				if (!/\.(png|svg|xml|txt|woff2)$/.test(target)) {
					if (target !== "" && !target.endsWith("/")) {
						unslashed.add(`/${target} (from /${path})`);
					}
					if (!seen.has(target) && !queue.includes(target)) {
						queue.push(target);
					}
				}
			} else if (link.startsWith(`${site.repo}/blob/`) || link.startsWith(`${site.repo}/tree/`)) {
				repoLinks.add(url.pathname.split("/").slice(5).join("/"));
			}
		}
	}
	const titles = [...seen.values()].map((r) => r.title);
	check(new Set(titles).size === titles.length, "every page has its own title", `${titles.length} pages`);
	const notInSitemap = [...seen.keys()].filter((p) => p !== "404/" && !fromSitemap.includes(p));
	check(notInSitemap.length === 0, "the sitemap lists every page", notInSitemap.join(", "));

	heading("Links");
	let internal = 0;
	const broken: string[] = [];
	for (const report of seen.values()) {
		for (const link of report.links) {
			const url = new URL(link);
			if (!link.startsWith(served)) {
				continue;
			}
			internal++;
			const target = seen.get(url.pathname.slice(new URL(served).pathname.length));
			const id = decodeURIComponent(url.hash.slice(1));
			if (
				target === undefined ? !/\.(png|svg|xml|txt|woff2)$/.test(url.pathname) : id !== "" && !target.ids.includes(id)
			) {
				broken.push(`${url.pathname}${url.hash} (from /${report.path})`);
			}
		}
	}
	check(unslashed.size === 0, "every link to a page ends in a slash", [...unslashed].join(", "));
	check(broken.length === 0, "every internal link and #fragment resolves", broken.join(", ") || `${internal} links`);
	const missing = [...repoLinks].filter((p) => p !== "" && !existsSync(join(root, p.replace(/#.*$/, ""))));
	check(missing.length === 0, "every link into the repository names a file that exists", missing.join(", "));
	return seen;
}

/** facts checks that pages show what the repository says. */
async function facts(browser: Browser, served: string, pages: Map<string, PageReport>): Promise<void> {
	heading("Facts from the repository");
	const page = await browser.newPage();
	// The artefacts of the build's logs are the concepts page's figures.
	await page.goto(`${served}docs/concepts/`, { waitUntil: "networkidle" });
	const receipt = await page.locator("figure.receipt pre.note .ln").allTextContents();
	check(receipt[0] === "c2sp.org/tlog-proof@v1", "the receipt is a C2SP tlog-proof", receipt[0]);
	check(receipt.includes(site.origin), "the receipt's checkpoint names the site's origin", site.origin);
	const origin = await page.locator('pre.note.labelled [data-label="origin"] .v').first().textContent();
	check(origin === site.origin, "the concepts page's checkpoint names the site's origin", origin ?? "");
	check(
		(await page.locator("main .tile-grid .c[data-i]").count()) > 0 &&
			(await page.locator("main ol.proof .row.sib").count()) > 0,
		"the concepts page draws the build's tile and inclusion proof",
	);

	await page.goto(served, { waitUntil: "networkidle" });
	const text = (await page.locator("main").textContent()) ?? "";
	check(
		text.includes(`${fixtureCount} golden fixture files`),
		"the home page counts the golden fixtures",
		String(fixtureCount),
	);
	const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}") as {
		"@graph"?: { "@type": string; license?: string[]; version?: string; isBasedOn?: { codeRepository?: string } }[];
	};
	const code = ld["@graph"]?.find((n) => n["@type"] === "SoftwareSourceCode");
	const licences = pkg.license
		.split(/\s+AND\s+/)
		.map((id) => `https://spdx.org/licenses/${id.replace(/[()]/g, "")}.html`);
	check(
		JSON.stringify(code?.license) === JSON.stringify(licences),
		"JSON-LD licence is package.json's, Apache-2.0 first",
		code?.license?.join(" "),
	);
	check(code?.isBasedOn?.codeRepository === site.tessera, "JSON-LD isBasedOn Tessera");
	check(ld["@graph"]?.some((n) => n["@type"] === "WebSite") === true, "JSON-LD WebSite");

	await page.goto(`${served}compatibility/`);
	const compat = (await page.locator("main").textContent()) ?? "";
	check(
		compat.includes(`${fixtureCount} golden fixture files`),
		"the compatibility page counts the golden fixtures",
		String(fixtureCount),
	);
	const absent = ciJobs.filter((j) => !compat.includes(j));
	check(absent.length === 0, "the compatibility page lists every CI job", absent.join(", ") || `${ciJobs.length} jobs`);
	const examples = pages.get("examples/")?.links ?? [];
	const unlisted = exampleDirs.filter((d) => !examples.includes(`${served}examples/${d}/`));
	check(
		unlisted.length === 0 && exampleDirs.every((d) => pages.has(`examples/${d}/`)),
		"every example has a page",
		unlisted.join(", "),
	);
	const reference = pages.get("docs/reference/")?.links ?? [];
	const unreferenced = specifiers.filter(
		(s) => !reference.some((l) => l === `${served}docs/reference/${s === "webtessera" ? s : s.slice(11)}/`),
	);
	check(
		unreferenced.length === 0,
		"every entry point has a reference page",
		unreferenced.join(", ") || `${specifiers.length}`,
	);
	const unrendered = guideSlugs.filter((g) => !pages.has(`docs/${g}/`));
	check(unrendered.length === 0, "every guide has a page", unrendered.join(", ") || `${guideSlugs.length}`);
	const robots = await (await fetch(`${served}robots.txt`)).text();
	check(robots.includes(`Sitemap: ${site.url}sitemap-index.xml`), "robots.txt names the sitemap");
	await page.close();
}

/** home checks the home page's length budget, its scripts, its look in both schemes and its demo. */
async function home(browser: Browser, served: string): Promise<void> {
	heading("Home page budget");
	for (const [width, height, limit] of [
		[1440, 900, budget.h1440],
		[390, 844, budget.h390],
	] as const) {
		const page = await browser.newPage({ viewport: { width, height } });
		await page.goto(served, { waitUntil: "networkidle" });
		const m = await page.evaluate(() => {
			const main = document.querySelector("main")?.cloneNode(true) as HTMLElement;
			for (const n of main.querySelectorAll("pre, code, svg, [data-demo]")) {
				n.remove();
			}
			return {
				height: document.documentElement.scrollHeight,
				words: (main.textContent ?? "").split(/\s+/).filter(Boolean).length,
				h2: document.querySelectorAll("main h2").length,
				code: [...document.querySelectorAll("main figure.code pre")].map(
					(p) => (p.textContent ?? "").split("\n").length,
				),
				tables: document.querySelectorAll("main table").length,
				nav: document.querySelectorAll("header nav a").length,
			};
		});
		check(m.height <= limit, `height at ${width} px`, `${m.height} of ${limit}`);
		if (width === 1440) {
			check(m.words <= budget.words, "prose words", `${m.words} of ${budget.words}`);
			check(m.h2 <= budget.h2, "h2 sections", `${m.h2} of ${budget.h2}`);
			check(
				m.code.length <= budget.code && m.code.every((n) => n <= budget.codeLines),
				"code blocks",
				`${m.code.length} of ${budget.code}, lines ${m.code.join(", ")} of ${budget.codeLines} each`,
			);
			check(m.tables <= budget.tables, "tables", `${m.tables} of ${budget.tables}`);
			check(m.nav <= budget.nav, "navigation links", `${m.nav} of ${budget.nav}`);
		}
		await page.close();
	}

	// The demo's script is fetched when the demo nears the viewport. In a window that the demo is
	// far below, the page loads one small script; scrolling to the demo fetches the rest.
	const low = await browser.newPage({ viewport: { width: 1440, height: 480 } });
	const scripts: number[] = [];
	low.on("response", async (r) => {
		if (r.request().resourceType() === "script") {
			scripts.push(gzipSync(await r.body(), { level: 9 }).length);
		}
	});
	await low.goto(served, { waitUntil: "networkidle" });
	const eager = scripts.length;
	const js = scripts.reduce((a, b) => a + b, 0);
	check(eager === 1 && js <= budget.js, "JavaScript before the demo is near", `${eager} script, ${js} B gzipped`);
	await low.locator("[data-demo]").scrollIntoViewIfNeeded();
	await low.waitForSelector('[data-demo][data-live="true"]', { timeout: 20_000 });
	check(scripts.length > eager, "the demo's script is fetched when the demo is near", `${scripts.length - eager} more`);
	await low.close();

	heading("Look and behaviour");
	const dark = await browser.newPage({ colorScheme: "dark" });
	await dark.goto(served);
	const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
	check(bg === "rgb(15, 14, 23)", "dark scheme follows the system", bg);
	await dark.close();
	const still = await browser.newPage({ reducedMotion: "reduce" });
	await still.goto(served);
	const motion = await still.evaluate(
		() => getComputedStyle(document.querySelector(".note") as Element).transitionDuration,
	);
	check(motion === "0s", "no motion under prefers-reduced-motion", motion);
	await still.close();
	const narrow = await browser.newPage({ viewport: { width: 320, height: 700 } });
	await narrow.goto(served);
	const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	check(overflow <= 0, "no horizontal scroll at 320 px", overflow > 0 ? `${overflow} px` : "");
	await narrow.close();

	const shift = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await shift.goto(served);
	const cls = await shift.evaluate(
		() =>
			new Promise<number>((resolve) => {
				let total = 0;
				new PerformanceObserver((list) => {
					for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
						total += e.hadRecentInput ? 0 : e.value;
					}
				}).observe({ type: "layout-shift", buffered: true });
				setTimeout(() => resolve(total), 1500);
			}),
	);
	check(cls < 0.05, "cumulative layout shift on load", cls.toFixed(4));
	await shift.close();
}

/**
 * demo appends an entry and verifies its proof, changes an entry and sees the change detected,
 * undoes it from the keyboard and with the button, fills a tile and starts over.
 */
async function demo(browser: Browser, served: string): Promise<void> {
	heading("Live demo");
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const problems = watch(page, new URL(served).origin);
	await page.goto(served);
	await page.locator("[data-demo]").scrollIntoViewIfNeeded();
	await page.waitForSelector('[data-demo][data-live="true"]', { timeout: 20_000 });
	check(true, "the log starts in the tab");
	const status = (state: string) => `[data-demo-status][data-state="${state}"]`;
	const size = async () => Number(await page.locator('[data-demo-note] [data-label="tree size"] .v').textContent());
	const waitForSize = (n: number, timeout: number) =>
		page.waitForFunction(
			(want) => Number(document.querySelector('[data-demo-note] [data-label="tree size"] .v')?.textContent) === want,
			n,
			{ timeout },
		);
	const roots = async () => ({
		computed: await page.locator("[data-demo-proof] .roots .computed code").textContent(),
		signed: await page.locator("[data-demo-proof] .roots .signed code").textContent(),
		checkpoint: await page.locator('[data-demo-note] [data-label="root hash"] .v').textContent(),
	});

	// Append.
	const seeded = await size();
	const text = `smoke test ${Date.now()}`;
	await page.fill("#demo-entry", text);
	await page.click('[data-demo-form] button[type="submit"]');
	await waitForSize(seeded + 1, 20_000);
	check(true, "appending publishes a checkpoint one entry larger", `${seeded} -> ${seeded + 1}`);
	const newest = page.locator("[data-demo-entries] li").first();
	check((await newest.locator("input").inputValue()) === text, "the entry is read back from its bundle");
	const leaf = (await newest.locator(".lh").textContent()) ?? "";
	check(/^[0-9a-f]{16}$/.test(leaf), "the entry is listed with its leaf hash", leaf);
	await page.waitForSelector(status("ok"), { timeout: 10_000 });
	const verdict = (await page.locator("[data-demo-proof] .verdict-line").textContent()) ?? "";
	check(
		verdict.includes(`Entry ${seeded} is in the tree of ${seeded + 1}`),
		"its inclusion proof verifies",
		verdict.trim(),
	);
	const agreed = await roots();
	check(
		agreed.computed === agreed.signed && agreed.signed === agreed.checkpoint && (agreed.signed ?? "") !== "",
		"the root recomputed from the proof is the checkpoint's",
		agreed.signed ?? "",
	);

	// Change an entry: nothing changes in the log, and the verifier rejects the changed entry.
	const victim = seeded - 1;
	const field = page.locator(`[data-demo-entries] input[data-entry="${victim}"]`);
	const row = page.locator(`[data-demo-entries] li[data-index="${victim}"]`);
	const original = await field.inputValue();
	const originalLeaf = await row.locator(".lh").textContent();
	await field.focus();
	await page.keyboard.press("End");
	await page.keyboard.type("!");
	await page.waitForSelector(status("bad"), { timeout: 10_000 });
	const alarm = (await page.locator("[data-demo-status-title]").textContent()) ?? "";
	check(alarm === "Tampering detected", "changing an entry is detected", alarm);
	check(
		(await page.locator("[data-demo-proof] .verdict-line.bad").count()) === 1 &&
			(await page.locator(`[data-demo-tiles] .c.bad[data-i="${victim}"]`).count()) === 1,
		"the changed entry's proof is rejected, and its cell is marked in the tile",
	);
	check((await row.locator(".lh").textContent()) !== originalLeaf, "the changed entry's leaf hash changes");
	const differed = await roots();
	check(
		differed.computed !== differed.signed && differed.signed === agreed.signed,
		"the recomputed root differs from the signed root, which did not move",
	);
	check((await size()) === seeded + 1, "the log itself did not change", String(await size()));

	// Undo, from the keyboard and with the button.
	await page.keyboard.press("Escape");
	await page.waitForSelector(status("ok"), { timeout: 10_000 });
	check(
		(await field.inputValue()) === original && (await row.locator(".lh").textContent()) === originalLeaf,
		"Escape puts the entry back, and it verifies again",
	);
	await field.fill(`${original} (altered)`);
	await page.waitForSelector(status("bad"), { timeout: 10_000 });
	await page.click(`[data-demo-entries] [data-restore="${victim}"]`);
	await page.waitForSelector(status("ok"), { timeout: 10_000 });
	check((await field.inputValue()) === original, "the Undo button puts the entry back");

	// Fill the tile.
	await page.click("[data-demo-fill]");
	await page.waitForSelector('[data-demo-tiles] .tile[data-level="1"]', { timeout: 30_000 });
	const tiles = await page.locator("[data-demo-tiles] figcaption code").allTextContents();
	check(
		tiles.includes("tile/0/000") && tiles.includes("tile/1/000.p/1"),
		"filling the tile makes tile/0/000 and tile/1/000.p/1",
		tiles.join(" "),
	);

	// Start over.
	await page.waitForSelector("[data-demo-reset]:not(:disabled)", { timeout: 10_000 });
	await page.click("[data-demo-reset]");
	await waitForSize(seeded, 20_000);
	await page.waitForSelector(status("ok"), { timeout: 10_000 });
	const fresh = await roots();
	check(
		fresh.signed === fresh.checkpoint && fresh.computed === fresh.signed,
		"Reset starts a new log with the page's entries",
		`${seeded} entries`,
	);
	check(problems.length === 0, "the demo runs without console errors", problems.join("; "));
	await page.close();

	heading("Without JavaScript");
	const context = await browser.newContext({ javaScriptEnabled: false });
	const still = await context.newPage();
	await still.goto(served);
	check(
		(await still.locator("h1").isVisible()) &&
			(await still.locator("main figure.code pre").count()) >= 2 &&
			(await still.locator("main .onward a").count()) >= 3,
		"the home page reads: its headline, its code samples and its ways onward",
	);
	check(
		(await still.locator(".demo-form").isHidden()) && (await still.locator("[data-copy]").isHidden()),
		"the controls that need a script are hidden",
	);
	check(
		(await still.locator("[data-demo-entries] li .tx").count()) > 0 &&
			(await still.locator("[data-demo-entries] input").count()) === 0,
		"the build's entries are listed, as text",
	);
	check(
		(await still.locator('[data-demo-note] [data-label="origin"] .v').textContent()) === site.origin,
		"the build's checkpoint is shown, and names the site's origin",
	);
	check(
		(await still.locator("[data-demo-proof] .verdict-line.ok").count()) === 1,
		"the build's proof is shown, verified",
	);
	check((await still.locator("[data-demo-tiles] .tile-grid .c[data-i]").count()) > 0, "the tile is drawn");
	await context.close();
}

const served = await serve(site.base);
const browser = await chromium.launch(
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
try {
	process.stdout.write(`Smoke-testing ${served.url} (published at ${site.url})\n`);
	const pages = await crawl(browser, served.url);
	await facts(browser, served.url, pages);
	await home(browser, served.url);
	await demo(browser, served.url);
} finally {
	await browser.close();
	await served.close();
}

process.stdout.write(failures === 0 ? "\nAll smoke checks passed.\n" : `\n${failures} smoke check(s) failed.\n`);
process.exitCode = failures === 0 ? 0 : 1;
