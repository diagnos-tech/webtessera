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

// Which repository file has a page on the site, and where. A guide (docs/guides/<name>.md) is
// /docs/<name>/, an example (examples/<dir>/) is /examples/<dir>/, the guides' index is /docs/,
// and every other path goes to GitHub at the build's commit.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Resolve } from "./markdown.ts";
import { github, href, type SiteConfig } from "./url.ts";

/** resolver maps repository paths to the site's pages, or to GitHub. */
export function resolver(site: SiteConfig, root: string, base: string): Resolve {
	return (path, hash) => {
		const frag = hash === "" ? "" : `#${hash}`;
		const guide = /^docs\/guides\/([\w.-]+)\.md$/.exec(path)?.[1];
		if (guide !== undefined && guide !== "README") {
			return href(`docs/${guide}/`, base) + frag;
		}
		if (/^docs\/guides(\/README\.md)?$/.test(path)) {
			return href("docs/", base) + frag;
		}
		const example = /^examples\/([\w.-]+)(\/README\.md)?$/.exec(path)?.[1];
		if (example !== undefined && existsSync(join(root, "examples", example, "package.json"))) {
			return href(`examples/${example}/`, base) + frag;
		}
		if (path === "examples") {
			return href("examples/", base) + frag;
		}
		// These pages are generated from the repository rather than rendered from the file, so
		// a link to a section of the file still goes to the file.
		if (path === "docs/compatibility.md" && hash === "") {
			return href("compatibility/", base);
		}
		if (path === "SECURITY.md" && hash === "") {
			return href("security/", base);
		}
		return github(site, root, path) + frag;
	};
}

/** guideSlug is the page name of a guide file: docs/guides/safe-api.md is "safe-api". */
export function guideSlug(file: string): string {
	return file.replace(/^.*\//, "").replace(/\.md$/, "");
}
