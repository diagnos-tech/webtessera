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

// fixtures/data/: the golden fixtures, recorded by running the real Tessera
// (fixtures/gen) and asserted byte for byte by the test suite.

import type { Repo } from "./repo.ts";

/** Fixture is one golden fixture file. */
export interface Fixture {
	readonly file: string;
	readonly description: string;
	readonly upstream: string;
}

/** Fixtures summarises fixtures/data. */
export interface Fixtures {
	readonly files: readonly Fixture[];
	/** commits are the upstream commits the fixtures were generated at (normally one). */
	readonly commits: readonly string[];
	/** logSizes are the sizes of the complete logs recorded from Tessera's POSIX driver. */
	readonly logSizes: readonly number[];
	readonly bytes: number;
}

interface RawFixture {
	description?: string;
	upstream?: string;
	commit?: string;
	size?: number | string;
}

/** loadFixtures reads the header of every fixture file. */
export function loadFixtures(repo: Repo): Fixtures {
	const names = repo.list("fixtures/data", "file").filter((f) => f.endsWith(".json"));
	const commits = new Set<string>();
	const logSizes: number[] = [];
	let bytes = 0;
	const files = names.map((file): Fixture => {
		const text = repo.text(`fixtures/data/${file}`);
		bytes += text.length;
		const raw = JSON.parse(text) as RawFixture;
		if (raw.commit !== undefined) {
			commits.add(raw.commit);
		}
		if (/^log_\d+\.json$/.test(file) && raw.size !== undefined) {
			logSizes.push(Number(raw.size));
		}
		return { file, description: raw.description ?? "", upstream: raw.upstream ?? "" };
	});
	return { files, commits: [...commits], logSizes: logSizes.sort((a, b) => a - b), bytes };
}
