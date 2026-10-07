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

// getSiteData runs the extractors of src/data once per build, however many pages ask: the
// build renders every page in one process, and the logs the site shows are created once.

import { loadSiteData, type SiteData } from "../data/index.ts";
import { repoRoot, siteConfig } from "./url.ts";

let data: Promise<SiteData> | undefined;

/** getSiteData returns the repository's data, read on the first call. */
export function getSiteData(): Promise<SiteData> {
	data ??= (async () => {
		const root = repoRoot();
		const d = await loadSiteData(root, siteConfig(root));
		if (d.reserved.length > 0) {
			process.stderr.write(`site: not listing entry points without a source yet: ${d.reserved.join(", ")}\n`);
		}
		if (d.drift.length > 0) {
			process.stderr.write(
				`site: README.md differs from the tested source for ${d.drift.join(", ")}; the site shows the source\n`,
			);
		}
		return d;
	})();
	return data;
}
