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

// The last step of `bun run build`: makes the decision records that the shipped declarations
// cite reachable from an editor's hover.
//
//     node scripts/link-decisions.mjs [dist]
//
// The sources cite ADRs by their path in this repository (`docs/decisions/0003-….md`, as
// PORTING.md §3.4 asks), which is right for someone reading the code here and a dead end for
// someone reading a hover in their own project, where docs/ does not exist. This rewrites
// each such path in dist/**/*.d.ts into its URL on GitHub. It changes comments only, and only
// in declarations; running it twice changes nothing more. Zero dependencies; needs Node >= 20.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "https://github.com/diagnos-tech/webtessera";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(process.argv[2] ?? join(repoRoot, "dist"));

// A path not already part of a URL or of a longer path: `docs/decisions/0003-x.md`; a bare
// number, `docs/decisions/0004`, which some comments use and which is resolved to its file
// here; or the directory itself, `docs/decisions/`.
const decision = /(?<![\w/.:-])docs\/decisions\/(\d{4}-[a-z0-9-]+\.md)/g;
const numbered = /(?<![\w/.:-])docs\/decisions\/(\d{4})(?![\w-])/g;
const directory = /(?<![\w/.:-])docs\/decisions\/(?![\w-])/g;

const files = new Map(
	readdirSync(join(repoRoot, "docs", "decisions"))
		.filter((f) => /^\d{4}-.*\.md$/.test(f))
		.map((f) => [f.slice(0, 4), f]),
);

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...walk(full));
		} else if (entry.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

let changed = 0;
for (const file of walk(dist)) {
	const before = readFileSync(file, "utf8");
	const after = before
		.replace(decision, `${repository}/blob/main/docs/decisions/$1`)
		.replace(numbered, (path, n) => (files.has(n) ? `${repository}/blob/main/docs/decisions/${files.get(n)}` : path))
		.replace(directory, `${repository}/tree/main/docs/decisions/`);
	if (after !== before) {
		writeFileSync(file, after);
		changed++;
	}
}
process.stdout.write(`link-decisions: linked the decision records cited in ${changed} declaration files\n`);
