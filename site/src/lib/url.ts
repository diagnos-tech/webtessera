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

// Where the site lives and what it links to. The public URL defaults to the GitHub Pages URL
// of the repository named in package.json; SITE_URL overrides it (CI passes the URL that
// actions/configure-pages reports, so a custom domain is picked up), and the base path,
// canonical URLs, sitemap and social cards follow. Links into the repository point at the
// commit the site was built from, so that they show the files the site was generated from.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** repoRoot finds the repository root: the nearest directory, from `from` up, whose package.json is the library's. */
export function repoRoot(from = process.cwd()): string {
	for (let dir = from; ; dir = dirname(dir)) {
		const pkg = join(dir, "package.json");
		if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "webtessera") {
			return dir;
		}
		if (dirname(dir) === dir) {
			throw new Error(`no webtessera package.json above ${from}`);
		}
	}
}

/** githubRepo reads the GitHub owner and name from the repository field of package.json. */
function githubRepo(root: string): { owner: string; name: string } {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		repository?: { url?: string } | string;
	};
	const url = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "");
	const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
	if (m === null) {
		throw new Error("package.json has no GitHub repository URL");
	}
	return { owner: m[1] ?? "", name: m[2] ?? "" };
}

/** siteUrl is the public URL of the site, ending in a slash: SITE_URL if set, else the repository's GitHub Pages URL. */
export function siteUrl(root = repoRoot(), env = process.env.SITE_URL): string {
	const { owner, name } = githubRepo(root);
	const url = new URL(env !== undefined && env !== "" ? env : `https://${owner}.github.io/${name}/`);
	if (!url.pathname.endsWith("/")) {
		url.pathname += "/";
	}
	return url.href;
}

/** headCommit returns the commit the checkout is at, or "main" outside a git checkout. */
function headCommit(root: string): string {
	try {
		const out = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		return /^[0-9a-f]{40}$/.test(out) ? out : "main";
	} catch {
		return "main";
	}
}

/** headDate returns the committer date (YYYY-MM-DD) of HEAD, or undefined outside a git checkout. */
function headDate(root: string): string | undefined {
	try {
		const out = execFileSync("git", ["log", "-1", "--format=%cs"], { cwd: root, encoding: "utf8" }).trim();
		return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : undefined;
	} catch {
		return undefined;
	}
}

/** SiteConfig is the site's address, and the addresses it links to. */
export interface SiteConfig {
	/** url is the absolute public URL of the site's home page, ending in a slash. */
	readonly url: string;
	/** base is the URL's path, e.g. /webtessera/. */
	readonly base: string;
	/** origin is the log origin of the page's demonstration logs: host and path, no scheme. */
	readonly origin: string;
	readonly repo: string;
	readonly npm: string;
	readonly tessera: string;
	/** commit is the commit the site was built from (or "main"), and date its committer date. */
	readonly commit: string;
	readonly date: string | undefined;
}

/** siteConfig derives the configuration from the repository at root and SITE_URL. */
export function siteConfig(root = repoRoot()): SiteConfig {
	const url = new URL(siteUrl(root));
	const { owner, name } = githubRepo(root);
	return {
		url: url.href,
		base: url.pathname,
		origin: `${url.host}${url.pathname.replace(/\/$/, "")}`,
		repo: `https://github.com/${owner}/${name}`,
		npm: "https://www.npmjs.com/package/webtessera",
		tessera: "https://github.com/transparency-dev/tessera",
		commit: headCommit(root),
		date: headDate(root),
	};
}

/**
 * github returns the GitHub URL of a repository path at the build's commit: a tree URL for a
 * directory, a blob URL for anything else. `line` adds a line anchor ("L10-L20").
 */
export function github(site: SiteConfig, root: string, path: string, line = ""): string {
	const clean = path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
	const dir = clean === "" || (existsSync(join(root, clean)) && statSync(join(root, clean)).isDirectory());
	return `${site.repo}/${dir ? "tree" : "blob"}/${site.commit}/${clean}${line === "" ? "" : `#${line}`}`;
}

/** href prefixes a site path with the base path: href("docs/") is "/webtessera/docs/". */
export function href(path = "", base: string = import.meta.env.BASE_URL): string {
	return `${base.replace(/\/?$/, "/")}${path.replace(/^\/+/, "")}`;
}
