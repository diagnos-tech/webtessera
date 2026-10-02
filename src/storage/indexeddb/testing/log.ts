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

// End-to-end helpers for the IndexedDB driver tests: append entries through a real
// appender, and check that what ended up in the database is a single, signed,
// verifiable log. They throw plain errors rather than using Vitest so that the test
// worker (lock_worker.ts) can use them too. Test-only.

import { type AppendOptions, newAppender, newAppendOptions } from "../../../append_lifecycle.ts";
import { getEntryBundle, newProofBuilder } from "../../../client/client.ts";
import { newEntry } from "../../../entry.ts";
import { bytesEqual } from "../../../internal/gostd/bytes.ts";
import type { LogReader } from "../../../lifecycle.ts";
import type { Driver } from "../../../log.ts";
import { parseCheckpoint } from "../../../vendor/formats/log/note.ts";
import { verifyInclusion } from "../../../vendor/merkle/proof/verify.ts";
import { DefaultHasher } from "../../../vendor/merkle/rfc6962/rfc6962.ts";
import { generateKey, newSigner, newVerifier } from "../../../vendor/note/note.ts";

/** testOrigin is the origin line of every checkpoint the tests sign. */
export const testOrigin = "example.com/webtessera-indexeddb-test";

/** newTestKey returns a fresh note signing key pair for testOrigin. */
export function newTestKey(): { skey: string; vkey: string } {
	return generateKey(undefined, testOrigin);
}

/**
 * testAppendOptions returns options for an appender that signs with skey and
 * integrates and publishes quickly, so that tests do not wait on default intervals.
 */
function testAppendOptions(skey: string): AppendOptions {
	return newAppendOptions().withCheckpointSigner(newSigner(skey)).withBatching(8, 10).withCheckpointInterval(100);
}

/**
 * appendEntries starts an appender on driver, adds entries concurrently, shuts the
 * appender down and returns the index each entry was assigned. Shutting down waits
 * until a published checkpoint commits to every one of them.
 */
export async function appendEntries(
	driver: Driver,
	skey: string,
	entries: readonly Uint8Array[],
): Promise<Map<bigint, Uint8Array>> {
	const ac = new AbortController();
	try {
		const { appender, shutdown } = await newAppender(driver, testAppendOptions(skey), ac.signal);
		const futures = entries.map((e) => appender.add(newEntry(e)));
		const assigned = new Map<bigint, Uint8Array>();
		for (const [i, future] of futures.entries()) {
			const { index } = await future();
			const entry = entries[i];
			if (entry === undefined || assigned.has(index)) {
				throw new Error(`index ${index} assigned twice`);
			}
			assigned.set(index, entry);
		}
		await shutdown();
		return assigned;
	} finally {
		ac.abort();
	}
}

/**
 * mergeAssignments combines the indices several appenders reported, failing if any
 * index was handed out more than once.
 */
export function mergeAssignments(...parts: ReadonlyMap<bigint, Uint8Array>[]): Map<bigint, Uint8Array> {
	const all = new Map<bigint, Uint8Array>();
	for (const part of parts) {
		for (const [index, entry] of part) {
			if (all.has(index)) {
				throw new Error(`index ${index} assigned to two entries`);
			}
			all.set(index, entry);
		}
	}
	return all;
}

/**
 * verifyLog checks that the log in driver has a latest checkpoint signed with the
 * key pair (skey, vkey) that commits to exactly the entries in want at their indices,
 * that each entry's inclusion proves out from the stored tiles, and that the entry
 * bundles hold the same entries.
 */
export async function verifyLog(
	driver: Driver,
	skey: string,
	vkey: string,
	want: ReadonlyMap<bigint, Uint8Array>,
): Promise<void> {
	const ac = new AbortController();
	try {
		const { reader } = await newAppender(driver, testAppendOptions(skey), ac.signal);
		await verifyReader(reader, vkey, want);
	} finally {
		ac.abort();
	}
}

async function verifyReader(reader: LogReader, vkey: string, want: ReadonlyMap<bigint, Uint8Array>): Promise<void> {
	const { checkpoint } = parseCheckpoint(await reader.readCheckpoint(), testOrigin, newVerifier(vkey));
	if (checkpoint.size !== BigInt(want.size)) {
		throw new Error(`checkpoint commits to ${checkpoint.size} entries, want ${want.size}`);
	}

	const pb = await newProofBuilder(checkpoint.size, (level, index, p, signal) =>
		reader.readTile(level, index, p, signal),
	);
	for (let i = 0n; i < checkpoint.size; i++) {
		const entry = want.get(i);
		if (entry === undefined) {
			throw new Error(`no entry was assigned index ${i}`);
		}
		const proof = await pb.inclusionProof(i);
		verifyInclusion(DefaultHasher, i, checkpoint.size, DefaultHasher.hashLeaf(entry), proof, checkpoint.hash);
	}

	for (let b = 0n; b * 256n < checkpoint.size; b++) {
		const bundle = await getEntryBundle(
			(index, p, signal) => reader.readEntryBundle(index, p, signal),
			b,
			checkpoint.size,
		);
		for (const [j, got] of bundle.entries.entries()) {
			const index = b * 256n + BigInt(j);
			const entry = want.get(index);
			if (entry === undefined || !bytesEqual(got, entry)) {
				throw new Error(`entry bundle ${b} holds the wrong entry at index ${index}`);
			}
		}
	}
}
