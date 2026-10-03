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

// The end-to-end check that several drivers, each over a database handle of its own as
// separate processes or isolates would hold, can append to one log at once and leave a
// single consistent, verifiable log. Runtime-neutral and test-only.

import { expect } from "vitest";
import { newAppender, newAppendOptions } from "../../../append_lifecycle.ts";
import { newProofBuilder } from "../../../client/client.ts";
import { newEntry } from "../../../entry.ts";
import { newFsck } from "../../../fsck/fsck.ts";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { defaultMerkleLeafHasher } from "../../../lifecycle.ts";
import { parseCheckpoint } from "../../../vendor/formats/log/note.ts";
import { verifyInclusion } from "../../../vendor/merkle/proof/verify.ts";
import { DefaultHasher } from "../../../vendor/merkle/rfc6962/rfc6962.ts";
import { generateKey, newSigner, newVerifier } from "../../../vendor/note/note.ts";
import { newSqliteDriver } from "../sqlite.ts";
import type { StoreOptions, StoreTarget } from "./stores.ts";

const origin = "example.com/webtessera-sqlite-concurrent";

/**
 * appendConcurrently starts one appender per target that newTarget returns, all on the
 * same log, has each add perDriver entries at once, and then checks that every entry
 * got a distinct index, that the published checkpoint commits to exactly those entries,
 * that each one's inclusion proves out, and that fsck finds the whole log consistent.
 */
export async function appendConcurrently(
	newTarget: () => StoreTarget | Promise<StoreTarget>,
	drivers: number,
	perDriver: number,
	options: StoreOptions = {},
): Promise<void> {
	const { skey, vkey } = generateKey(undefined, origin);
	const opts = newAppendOptions()
		.withCheckpointSigner(newSigner(skey))
		.withBatching(16, 5)
		.withCheckpointInterval(100)
		.withCheckpointRepublishInterval(0);
	const ac = new AbortController();
	try {
		const logs = await Promise.all(
			Array.from({ length: drivers }, async () =>
				newAppender(await newSqliteDriver({ ...options, ...(await newTarget()) }), opts, ac.signal),
			),
		);
		const assigned = await Promise.all(
			logs.flatMap((log, d) =>
				Array.from({ length: perDriver }, async (_, i) => {
					const data = toUTF8(`driver ${d} entry ${i}`);
					return { data, index: (await log.appender.add(newEntry(data))()).index };
				}),
			),
		);
		await Promise.all(logs.map((log) => log.shutdown()));

		const total = drivers * perDriver;
		const byIndex = new Map<bigint, Uint8Array>();
		for (const { data, index } of assigned) {
			expect(byIndex.has(index), `index ${index} assigned twice`).toBe(false);
			expect(index < BigInt(total), `index ${index} out of range`).toBe(true);
			byIndex.set(index, data);
		}

		const reader = (logs[0] ?? expect.unreachable()).reader;
		const verifier = newVerifier(vkey);
		const { checkpoint } = parseCheckpoint(await reader.readCheckpoint(), origin, verifier);
		expect(checkpoint.size).toBe(BigInt(total));
		const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => reader.readTile(l, i, p, s));
		for (const [index, data] of byIndex) {
			const proof = await proofs.inclusionProof(index);
			verifyInclusion(DefaultHasher, index, checkpoint.size, DefaultHasher.hashLeaf(data), proof, checkpoint.hash);
		}
		await newFsck(origin, verifier, reader, defaultMerkleLeafHasher, { n: 4 }).check();
	} finally {
		ac.abort();
	}
}
