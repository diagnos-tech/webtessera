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

// Where the site lives and what it links to. The public URL defaults to the GitHub
// Pages URL of the repository named in package.json; set SITE_URL to publish elsewhere
// (a fork, a custom domain), and the base path, canonical URL, sitemap and social
// cards follow.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** SiteConfig is the site's address and its outbound links. */
export interface SiteConfig {
	/** url is the absolute public URL of the page, ending in a slash. */
	readonly url: string;
	/** base is the URL's path, as Vite's `base` wants it. */
	readonly base: string;
	/** origin is the log origin for the page's demonstration logs: host and path, no scheme. */
	readonly origin: string;
	readonly repo: string;
	readonly blob: string;
	readonly tree: string;
	readonly npm: string;
	readonly packages: string;
	readonly tessera: string;
}

/** siteConfig derives the configuration from the repository root's package.json and SITE_URL. */
export function siteConfig(repoRoot: string, siteUrl: string | undefined): SiteConfig {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
		name: string;
		repository?: { url?: string };
	};
	const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(pkg.repository?.url ?? "");
	if (m === null) {
		throw new Error("package.json has no GitHub repository URL");
	}
	const [, owner = "", name = ""] = m;
	const url = new URL(siteUrl !== undefined && siteUrl !== "" ? siteUrl : `https://${owner}.github.io/${name}/`);
	if (!url.pathname.endsWith("/")) {
		url.pathname += "/";
	}
	const repo = `https://github.com/${owner}/${name}`;
	return {
		url: url.href,
		base: url.pathname,
		origin: `${url.host}${url.pathname.replace(/\/$/, "")}`,
		repo,
		blob: `${repo}/blob/main/`,
		tree: `${repo}/tree/main/`,
		npm: `https://www.npmjs.com/package/${pkg.name}`,
		packages: `${repo}/packages`,
		tessera: "https://github.com/transparency-dev/tessera",
	};
}
