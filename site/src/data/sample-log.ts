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

// A real webtessera log, created while the site builds: its entries are the package's
// entry points, its checkpoint is signed by the library, and the page shows its
// checkpoint, tiles and an inclusion proof before any JavaScript runs. The signing key
// is derived from the origin, so the same commit always renders the same page; it is a
// demonstration key and signs nothing else.

import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";
import { parseCheckpoint } from "webtessera/formats/log";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { generateKey, newSigner, newVerifier } from "webtessera/note";
import { MemoryObjectStore, newMemoryDriver } from "webtessera/storage/memory";
import { type Inclusion, proveInclusion, readTiles } from "../shared/inspect.ts";
import type { NoteView } from "../shared/note.ts";
import type { TileView } from "../shared/tiles.ts";

/** StoredFile is one object of the log's store: a tlog-tiles resource. */
export interface StoredFile {
	readonly path: string;
	readonly size: number;
}

/** SampleLog is everything the page shows of the build-time log. */
export interface SampleLog {
	readonly origin: string;
	readonly vkey: string;
	readonly entries: readonly string[];
	readonly note: NoteView;
	readonly size: bigint;
	readonly tiles: readonly TileView[];
	readonly files: readonly StoredFile[];
	readonly inclusion: Inclusion;
}

const enc = new TextEncoder();

/**
 * sampleKey derives the page's demonstration key pair from the origin, so that the build is
 * reproducible. Never derive a real log's key like this: it is public, and signs nothing
 * but the logs this page builds.
 */
export function sampleKey(origin: string): { skey: string; vkey: string } {
	const seed = DefaultHasher.hashLeaf(enc.encode(`webtessera site sample log: ${origin}`));
	const rand = {
		read(p: Uint8Array): number {
			p.set(seed.subarray(0, p.length));
			return p.length;
		},
	};
	return generateKey(rand, origin);
}

/** buildSampleLog appends entries to a fresh in-memory log and reads it back as a client would. */
export async function buildSampleLog(origin: string, entries: readonly string[], prove: number): Promise<SampleLog> {
	const { skey, vkey } = sampleKey(origin);
	const verifier = newVerifier(vkey);
	const store = new MemoryObjectStore();
	const ac = new AbortController();
	const opts = newAppendOptions()
		.withCheckpointSigner(newSigner(skey))
		.withBatching(256, 5)
		.withCheckpointInterval(100);
	const { appender, reader, shutdown } = await newAppender(newMemoryDriver({ store }), opts, ac.signal);
	try {
		const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 10, ac.signal);
		const added = await Promise.all(entries.map((e) => awaiter.await(appender.add(newEntry(enc.encode(e))))));
		// The log assigns indices; list the entries in the order it did.
		const byIndex: string[] = [];
		added.forEach(([{ index }], i) => {
			byIndex[Number(index)] = entries[i] ?? "";
		});
		const { checkpoint, note } = parseCheckpoint(await reader.readCheckpoint(), origin, verifier);
		const files: StoredFile[] = [];
		for (const path of store.keys()) {
			if (!path.startsWith(".")) {
				files.push({ path, size: (await store.stat(path))?.size ?? 0 });
			}
		}
		const index = BigInt(Math.min(prove, byIndex.length - 1));
		const data = byIndex[Number(index)] ?? "";
		return {
			origin,
			vkey,
			entries: byIndex,
			note: { text: note.text, sigs: note.sigs ?? [] },
			size: checkpoint.size,
			tiles: await readTiles(reader, checkpoint.size),
			files,
			inclusion: await proveInclusion(reader, checkpoint.size, checkpoint.hash, index, enc.encode(data), data),
		};
	} finally {
		await shutdown();
		ac.abort();
	}
}
