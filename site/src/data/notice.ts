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

// LICENSE and NOTICE: the licence the package is under, and the projects whose code it
// translates, with the copyright lines their licences require the footer to carry.

import type { Repo } from "./repo.ts";

/** Attribution is one translated upstream project, as NOTICE lists it. */
export interface Attribution {
	readonly name: string;
	readonly url: string;
	readonly copyright: string;
	readonly license: string;
	/** testOnly is true for test material that the published package does not contain. */
	readonly testOnly: boolean;
}

/** Licensing is what the footer says about licences. */
export interface Licensing {
	/** title is the first line of LICENSE, e.g. "Apache License, Version 2.0". */
	readonly title: string;
	/** holder is the copyright line of NOTICE. */
	readonly holder: string;
	readonly attributions: readonly Attribution[];
}

// sectionLicense maps a NOTICE section heading to the licence it covers.
const sectionLicense: readonly [RegExp, string][] = [
	[/^Apache-2\.0/, "Apache-2.0"],
	[/^BSD-3-Clause/, "BSD-3-Clause"],
	[/^ISC/, "ISC"],
];

/** loadLicensing reads LICENSE and NOTICE. */
export function loadLicensing(repo: Repo): Licensing {
	const license = repo.text("LICENSE");
	const title = license
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.slice(0, 2)
		.join(", ");
	const notice = repo.text("NOTICE");
	const holder = /^Copyright .+$/m.exec(notice)?.[0] ?? "";
	const attributions: Attribution[] = [];
	// Sections are introduced by a heading between two rules of dashes.
	const parts = notice.split(/^-{20,}\n/m);
	for (let i = 1; i + 1 < parts.length; i += 2) {
		const heading = (parts[i] ?? "").trim();
		const lic = sectionLicense.find(([re]) => re.test(heading))?.[1];
		if (lic === undefined) {
			continue;
		}
		for (const block of (parts[i + 1] ?? "").split(/\n\s*\n/)) {
			const lines = block.trim().split("\n");
			// A heading too long for one line ends in " -" and puts the URL on the next.
			const head = lines[0]?.endsWith(" -") ? `${lines[0]} ${lines[1] ?? ""}` : (lines[0] ?? "");
			const copyright = lines.find((l) => l.startsWith("Copyright "));
			if (copyright === undefined) {
				continue;
			}
			const m = /^(.+?) - (https?:\/\/\S+)/.exec(head);
			attributions.push({
				name: (m?.[1] ?? head).trim(),
				url: m?.[2] ?? "",
				copyright: copyright
					.replace(/^Copyright\s+/, "")
					.replace(/;\s*Copyright\s+/g, ", ")
					.trim(),
				license: lic,
				testOnly: /\bTest material only\b/i.test(block),
			});
		}
	}
	return { title, holder, attributions };
}
