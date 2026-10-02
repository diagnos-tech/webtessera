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

// Read access to the repository the site is generated from. Every extractor in this
// directory reads through a Repo, so the page reflects the checkout it was built from.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Repo reads files relative to the repository root. */
export class Repo {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	/** path returns the absolute path of a repository-relative path. */
	path(rel: string): string {
		return join(this.root, rel);
	}

	exists(rel: string): boolean {
		return existsSync(this.path(rel));
	}

	text(rel: string): string {
		return readFileSync(this.path(rel), "utf8");
	}

	/** textOr returns a file's text, or undefined if it does not exist. */
	textOr(rel: string): string | undefined {
		return this.exists(rel) ? this.text(rel) : undefined;
	}

	json<T>(rel: string): T {
		return JSON.parse(this.text(rel)) as T;
	}

	/** list returns the names in a directory, sorted, filtered by kind. */
	list(rel: string, kind: "file" | "dir"): string[] {
		if (!this.exists(rel)) {
			return [];
		}
		return readdirSync(this.path(rel))
			.filter((name) => {
				const st = statSync(join(this.path(rel), name));
				return kind === "dir" ? st.isDirectory() : st.isFile();
			})
			.sort();
	}

	/** walk returns every file under a directory whose name matches, as repository-relative paths. */
	walk(rel: string, match: RegExp): string[] {
		const out: string[] = [];
		for (const dir of this.list(rel, "dir")) {
			if (dir !== "node_modules" && dir !== "dist" && !dir.startsWith(".")) {
				out.push(...this.walk(`${rel}/${dir}`, match));
			}
		}
		for (const f of this.list(rel, "file")) {
			if (match.test(f)) {
				out.push(`${rel}/${f}`);
			}
		}
		return out;
	}
}
