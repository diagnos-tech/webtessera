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

// CONTRIBUTING.md's command table: what each contributor command does, as the guide words
// it, and the package manager that runs them (package.json's packageManager).

import type { Repo } from "./repo.ts";
import { cells, plain } from "./tables.ts";

/** Command is one contributor command. */
export interface Command {
	readonly command: string;
	readonly does: string;
}

/** Contributing is what the page shows of the contributor workflow. */
export interface Contributing {
	/** packageManager is the tool and version package.json pins, e.g. bun@1.3.14. */
	readonly packageManager: string;
	readonly commands: readonly Command[];
}

/** loadContributing reads the commands CONTRIBUTING.md documents in its command table. */
export function loadContributing(repo: Repo): Contributing {
	const text = repo.textOr("CONTRIBUTING.md") ?? "";
	const commands = text
		.split("\n")
		.filter((l) => /^\| `[^`]+` \|/.test(l))
		.map(cells)
		.map(([command = "", does = ""]) => ({ command: command.replace(/`/g, ""), does: plain(does) }))
		.filter((c) => /^\w+ run /.test(c.command));
	const pm = repo.json<{ packageManager?: string }>("package.json").packageManager ?? "";
	return { packageManager: pm, commands };
}
