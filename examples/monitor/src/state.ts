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
// Where the monitor keeps what it must not forget: the last checkpoint it proved consistent,
// and the evidence of every fork it saw. Forgetting the checkpoint would let a log that forked
// while the monitor was down start afresh unnoticed, so it is written durably.

import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** StateStore keeps the monitor's state between runs. */
export interface StateStore {
	/** load returns the last checkpoint saved, or undefined on the first run. */
	load(): Promise<Uint8Array | undefined>;
	/** save replaces the saved checkpoint; it must be durable when it resolves. */
	save(checkpoint: Uint8Array): Promise<void>;
	/** keepEvidence stores proof of a log's misbehaviour, and returns where it went. */
	keepEvidence(name: string, evidence: string): Promise<string>;
}

/**
 * newFileStateStore keeps the state in a directory, through node:fs, which Node, Bun and Deno
 * all provide: `checkpoint` holds the last verified checkpoint, `evidence/` one file per fork.
 */
export function newFileStateStore(dir: string): StateStore {
	const checkpoint = join(dir, "checkpoint");
	return {
		load: () =>
			readFile(checkpoint).catch((err: { code?: string }) => {
				if (err.code === "ENOENT") {
					return undefined;
				}
				throw err;
			}),
		save: async (data) => {
			await mkdir(dir, { recursive: true });
			// Write a temporary file, flush it to disk, then rename it over the old one: a crash
			// at any point leaves either the old checkpoint or the new one, never half of one.
			const tmp = `${checkpoint}.tmp`;
			const f = await open(tmp, "w");
			try {
				await f.writeFile(data);
				await f.sync();
			} finally {
				await f.close();
			}
			await rename(tmp, checkpoint);
		},
		keepEvidence: async (name, evidence) => {
			const path = join(dir, "evidence", name);
			await mkdir(join(dir, "evidence"), { recursive: true });
			await writeFile(path, evidence);
			return path;
		},
	};
}

/** newMemoryStateStore keeps the state in memory: for tests. */
export function newMemoryStateStore(): StateStore & { readonly evidence: Map<string, string> } {
	let saved: Uint8Array | undefined;
	const evidence = new Map<string, string>();
	return {
		evidence,
		load: async () => saved,
		save: async (data) => {
			saved = data.slice();
		},
		keepEvidence: async (name, text) => {
			evidence.set(name, text);
			return `memory:${name}`;
		},
	};
}
