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

// The demo's log: a webtessera appender on the memory driver, with a key generated in
// the tab. Everything the page shows is read back through the log's reader, the way a
// client reads a log: the checkpoint is verified with webtessera/client, entries come
// from entry bundles, and proofs are built from tiles.

import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";
import { type FetchedCheckpoint, fetchCheckpoint, getEntryBundle } from "webtessera/client";
import { generateKey, newSigner, newVerifier } from "webtessera/note";
import { newMemoryDriver } from "webtessera/storage/memory";
import { type Inclusion, proveInclusion, readTiles } from "../shared/inspect.ts";
import type { ListedEntry } from "../shared/panels.ts";
import type { TileView } from "../shared/tiles.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

type Started = Awaited<ReturnType<typeof newAppender>>;

/** Snapshot is what the page draws of the log at one checkpoint. */
export interface Snapshot {
	readonly checkpoint: FetchedCheckpoint;
	readonly tiles: readonly TileView[];
	readonly latest: readonly ListedEntry[];
}

/** DemoLog is a log running in this tab. */
export class DemoLog {
	readonly origin: string;
	readonly #started: Started;
	readonly #awaiter: ReturnType<typeof newPublicationAwaiter>;
	readonly #verifier: ReturnType<typeof newVerifier>;

	private constructor(origin: string, started: Started, verifier: ReturnType<typeof newVerifier>, signal: AbortSignal) {
		this.origin = origin;
		this.#started = started;
		this.#verifier = verifier;
		this.#awaiter = newPublicationAwaiter((s) => started.reader.readCheckpoint(s), 50, signal);
	}

	/** open starts a new, empty log whose checkpoints carry the given origin. */
	static async open(origin: string, signal: AbortSignal): Promise<DemoLog> {
		const { skey, vkey } = generateKey(undefined, origin);
		const opts = newAppendOptions()
			.withCheckpointSigner(newSigner(skey))
			// A demo wants its entries published at once; the defaults suit a busy log.
			.withBatching(256, 25)
			.withCheckpointInterval(100);
		const started = await newAppender(newMemoryDriver(), opts, signal);
		return new DemoLog(origin, started, newVerifier(vkey), signal);
	}

	/** append adds entries and resolves to their indices once a checkpoint commits to all of them. */
	async append(texts: readonly string[]): Promise<bigint[]> {
		const { appender } = this.#started;
		const done = await Promise.all(texts.map((t) => this.#awaiter.await(appender.add(newEntry(enc.encode(t))))));
		return done.map(([{ index }]) => index);
	}

	/** checkpoint fetches the latest checkpoint and verifies its signature. */
	checkpoint(): Promise<FetchedCheckpoint> {
		return fetchCheckpoint((s) => this.#started.reader.readCheckpoint(s), this.#verifier, this.origin);
	}

	/** entries reads entries [from, to) back from the log's entry bundles. */
	async entries(from: bigint, to: bigint, size: bigint): Promise<ListedEntry[]> {
		const out: ListedEntry[] = [];
		const read = (i: bigint, p: number, s?: AbortSignal) => this.#started.reader.readEntryBundle(i, p, s);
		for (let b = from / 256n; b * 256n < to; b++) {
			const bundle = await getEntryBundle(read, b, size);
			bundle.entries.forEach((e, j) => {
				const index = b * 256n + BigInt(j);
				if (index >= from && index < to) {
					out.push({ index, text: dec.decode(e) });
				}
			});
		}
		return out;
	}

	/** snapshot reads everything the page draws at the latest checkpoint. */
	async snapshot(latest: number): Promise<Snapshot> {
		const checkpoint = await this.checkpoint();
		const size = checkpoint.checkpoint.size;
		const from = size > BigInt(latest) ? size - BigInt(latest) : 0n;
		return {
			checkpoint,
			tiles: await readTiles(this.#started.reader, size),
			latest: await this.entries(from, size, size),
		};
	}

	/** prove builds entry index's inclusion proof and verifies it, optionally against altered data. */
	async prove(cp: FetchedCheckpoint, index: bigint, tamper: boolean): Promise<Inclusion> {
		const size = cp.checkpoint.size;
		const [entry] = await this.entries(index, index + 1n, size);
		const text = entry?.text ?? "";
		const data = tamper ? `${text} (altered)` : text;
		return proveInclusion(this.#started.reader, size, cp.checkpoint.hash, index, enc.encode(data), data);
	}
}
