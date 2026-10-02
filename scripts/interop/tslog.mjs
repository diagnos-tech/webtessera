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

// The webtessera half of the harness, run from the built package: appending to a log in a store
// exactly as interop/produce appends with Go's POSIX driver, and verifying a log in a store with
// webtessera's own client and fsck, as interop/verify does with Tessera's.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";
import { EntryBundle } from "webtessera/api";
import { CheckpointPath, entriesPath, partialTileSize, tilePath } from "webtessera/api/layout";
import { fetchCheckpoint, getEntryBundle, newProofBuilder } from "webtessera/client";
import { parseCheckpoint } from "webtessera/formats/log";
import { newFsck } from "webtessera/fsck";
import { verifyConsistency, verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { newSigner, newVerifier } from "webtessera/note";
import { newObjectStoreDriver } from "webtessera/storage/objectstore";
import { entryData } from "./entries.mjs";
import { writeHistory } from "./files.mjs";
import { maxBatch, rng } from "./plan.mjs";

/** batchMaxAgeMs matches interop/produce's -batch_max_age default. */
const batchMaxAgeMs = 100;

/**
 * appendBatches appends the interop corpus to the log in store, which holds `from` entries, in
 * batches ending exactly at `ends`, recording the checkpoint published after each batch in the
 * history directory. The options are interop/produce's, so both writers leave the same files.
 *
 * Every batch is built first and then added synchronously, before any future is awaited: in a
 * single-threaded runtime that guarantees the queue sees the batch whole, flushing it by age (or
 * by filling up, for a batch of exactly maxBatch).
 */
export async function appendBatches(store, { skey, vkey, seed, from, ends, history }) {
	const v = newVerifier(vkey);
	const opts = newAppendOptions()
		.withCheckpointSigner(newSigner(skey))
		.withBatching(maxBatch, batchMaxAgeMs)
		.withCheckpointInterval(100)
		.withCheckpointRepublishInterval(0)
		.withGarbageCollectionInterval(0);
	const ac = new AbortController();
	try {
		const { appender, shutdown, reader } = await newAppender(newObjectStoreDriver({ store }), opts, ac.signal);
		const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 10, ac.signal);
		let cur = from;
		for (const end of ends) {
			const batch = [];
			for (let i = cur; i < end; i++) {
				batch.push(newEntry(entryData(seed, i)));
			}
			const futures = batch.map((e) => appender.add(e));
			const indices = await Promise.all(futures.map((f) => f()));
			for (const [k, idx] of indices.entries()) {
				if (idx.index !== cur + BigInt(k)) {
					throw new Error(`entry ${cur + BigInt(k)} was given index ${idx.index}`);
				}
			}
			const [, raw] = await awaiter.await(futures[futures.length - 1], ac.signal);
			const { checkpoint } = parseCheckpoint(raw, v.name(), v);
			if (checkpoint.size !== end) {
				throw new Error(`the checkpoint published after the batch ending at ${end} commits to ${checkpoint.size}`);
			}
			writeHistory(history, end, raw);
			cur = end;
		}
		await shutdown(ac.signal);
	} finally {
		ac.abort();
	}
}

/**
 * verifyStore checks the log in store with webtessera's client and fsck, mirroring
 * interop/verify: the checkpoint's signature and size; fsck of the whole tree; every entry
 * against the corpus, with each bundle holding exactly the entries the size implies; inclusion
 * proofs for a sample of entries; and consistency proofs from every checkpoint in historyDir.
 * It returns a one-line summary.
 */
export async function verifyStore(store, { vkey, seed, size, historyDir }) {
	const v = newVerifier(vkey);
	const f = storeFetcher(store);
	const { checkpoint: cp } = await fetchCheckpoint((s) => f.readCheckpoint(s), v, v.name());
	if (cp.size !== size) {
		throw new Error(`the checkpoint commits to ${cp.size} entries, want ${size}`);
	}

	await newFsck(v.name(), v, f, leafHashes, { n: 4 }).check();

	const readBundle = (i, p, s) => f.readEntryBundle(i, p, s);
	for (let b = 0n; b * 256n < size; b++) {
		const bundle = await getEntryBundle(readBundle, b, size);
		const width = partialTileSize(0n, b, size) || 256;
		if (bundle.entries.length !== width) {
			throw new Error(`bundle ${b} holds ${bundle.entries.length} entries, a tree of size ${size} implies ${width}`);
		}
		for (const [j, got] of bundle.entries.entries()) {
			const i = b * 256n + BigInt(j);
			if (!Buffer.from(got).equals(entryData(seed, i))) {
				throw new Error(`entry ${i} is not entry ${i} of the corpus`);
			}
		}
	}

	const pb = await newProofBuilder(size, (l, i, p, s) => f.readTile(l, i, p, s));
	const samples = sampleIndices(seed, size);
	for (const i of samples) {
		const bundle = await getEntryBundle(readBundle, i / 256n, size);
		const leaf = DefaultHasher.hashLeaf(bundle.entries[Number(i % 256n)]);
		verifyInclusion(DefaultHasher, i, size, leaf, await pb.inclusionProof(i), cp.hash);
	}

	const hist = readHistory(historyDir, v);
	for (const h of hist) {
		verifyConsistency(DefaultHasher, h.size, size, await pb.consistencyProof(h.size, size), h.hash, cp.hash);
	}
	return (
		`checkpoint signature, fsck, all ${size} entries, ${samples.length} inclusion proofs, ` +
		`${hist.length} consistency proofs from Go's checkpoints`
	);
}

/**
 * storeFetcher reads a log straight out of a store, the way a static HTTP server mapping
 * request paths to keys would serve it: a partial tile or bundle falls back to the full one, as
 * tlog-tiles clients must, once garbage collection has removed it.
 */
function storeFetcher(store) {
	const read = async (key) => {
		const d = await store.get(key);
		if (d === undefined) {
			throw new Error(`${key}: not found`);
		}
		return d;
	};
	const partialOrFull = async (pathFor, p) => {
		const partial = p > 0 ? await store.get(pathFor(p)) : undefined;
		return partial ?? read(pathFor(0));
	};
	return {
		readCheckpoint: () => read(CheckpointPath),
		readTile: (l, i, p) => partialOrFull((q) => tilePath(l, i, q), p),
		readEntryBundle: (i, p) => partialOrFull((q) => entriesPath(i, q), p),
	};
}

/** leafHashes parses an entry bundle and returns the Merkle leaf hash of each entry: cmd/fsck's bundle hasher. */
function leafHashes(raw) {
	const eb = new EntryBundle();
	eb.unmarshalText(raw);
	return eb.entries.map((e) => DefaultHasher.hashLeaf(e));
}

/** sampleIndices returns the entries either side of the bundle and tile boundaries the tree reaches, its last entries, and 64 seeded random ones. */
function sampleIndices(seed, size) {
	const r = new Set();
	for (const b of [0n, 256n, 512n, 65536n]) {
		for (const d of [-2n, -1n, 0n, 1n, 2n]) {
			r.add(b + d);
		}
	}
	for (const d of [1n, 2n, 3n]) {
		r.add(size - d);
	}
	const next = rng(seed ^ 0x5eedn);
	for (let k = 0; k < 64; k++) {
		r.add(next() % size);
	}
	return [...r].filter((i) => i >= 0n && i < size).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** readHistory reads and verifies every checkpoint.<size> file in dir, ordered by size. */
function readHistory(dir, v) {
	return readdirSync(dir)
		.filter((n) => n.startsWith("checkpoint."))
		.map((n) => {
			const { checkpoint } = parseCheckpoint(new Uint8Array(readFileSync(join(dir, n))), v.name(), v);
			if (`checkpoint.${checkpoint.size}` !== n) {
				throw new Error(`${join(dir, n)} commits to ${checkpoint.size} entries`);
			}
			return checkpoint;
		})
		.sort((a, b) => (a.size < b.size ? -1 : 1));
}
