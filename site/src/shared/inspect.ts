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

// Reads a running log the way a client does, for the page to draw it: its tiles, and
// an inclusion proof built with webtessera's client and checked with its verifier. The
// build uses this on a log it creates in Node (the static page), the demo on the log
// it runs in the visitor's tab, so both show exactly the same thing.

import { partialTileSize, tilePath } from "webtessera/api/layout";
import { newProofBuilder } from "webtessera/client";
import { verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { splitHashes } from "./bytes.ts";
import { computeSpine, inclusionPath, type ProofView } from "./proof.ts";
import { type TileView, TileWidth } from "./tiles.ts";

/** TileReader is the part of a LogReader that reads hash tiles. */
export interface TileReader {
	readTile(level: bigint, index: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** readTiles reads every hash tile of a tree of the given size, lowest level first. */
export async function readTiles(reader: TileReader, size: bigint): Promise<TileView[]> {
	const tiles: TileView[] = [];
	const width = BigInt(TileWidth);
	for (let level = 0n; size >> (level * 8n) > 0n; level++) {
		const nodes = size >> (level * 8n);
		for (let index = 0n; index * width < nodes; index++) {
			const p = partialTileSize(level, index, size);
			const hashes = splitHashes(await reader.readTile(level, index, p));
			tiles.push({ path: tilePath(level, index, p), level: Number(level), index, hashes });
		}
	}
	return tiles;
}

/** Inclusion is an inclusion proof, explained, with the verifier's verdict. */
export interface Inclusion extends ProofView {
	/** error is the verifier's message if the proof did not verify, and errorName its class. */
	readonly error?: string;
	readonly errorName?: string;
}

/**
 * proveInclusion builds the inclusion proof of entry `index` in the tree of the given
 * size and root, and verifies it against `data`, the entry's contents.
 */
export async function proveInclusion(
	reader: TileReader,
	size: bigint,
	root: Uint8Array,
	index: bigint,
	data: Uint8Array,
	label: string,
): Promise<Inclusion> {
	const builder = await newProofBuilder(size, (l, i, p, s) => reader.readTile(l, i, p, s));
	const proof = await builder.inclusionProof(index);
	const leafHash = DefaultHasher.hashLeaf(data);
	const steps = inclusionPath(index, size);
	const spine = computeSpine(leafHash, steps, proof, (l, r) => DefaultHasher.hashChildren(l, r));
	const view: ProofView = { index, size, entry: label, steps, proof, spine, root };
	try {
		verifyInclusion(DefaultHasher, index, size, leafHash, proof, root);
		return view;
	} catch (err) {
		return err instanceof Error
			? { ...view, error: err.message, errorName: err.name }
			: { ...view, error: String(err), errorName: "Error" };
	}
}
