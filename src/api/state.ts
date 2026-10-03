// Copyright 2024 Google LLC. All Rights Reserved.
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
//
// Ported from tessera/api/state.go @ 4a6d9f9

// Module api contains the tiles definitions from the [tlog-tiles API].
//
// [tlog-tiles API]: https://c2sp.org/tlog-tiles

import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, readUint16BE } from "../internal/gostd/bytes.ts";
import { EntryBundleWidth, TileWidth } from "./layout/tile.ts";

// sha256Size is `crypto/sha256.Size`, the length in bytes of a SHA-256 checksum.
const sha256Size = sha256.outputLen;

/**
 * HashTile represents a tile within the Merkle hash tree.
 * Leaf HashTiles will have a corresponding EntryBundle, where each
 * entry in the EntryBundle slice hashes to the value at the same
 * index in the Nodes slice.
 *
 * Port note: Go's `encoding.TextMarshaler` / `TextUnmarshaler` have no TypeScript
 * counterpart, so the methods are ported as ordinary methods with the same names and
 * the same in-place mutation on unmarshal. See
 * docs/decisions/0032-text-marshalling-as-methods.md.
 */
export class HashTile {
	/**
	 * nodes stores the leaf hash nodes in this tile.
	 * Note that only non-ephemeral nodes are stored.
	 */
	nodes: Uint8Array[];

	constructor(nodes: Uint8Array[] = []) {
		this.nodes = nodes;
	}

	/**
	 * marshalText implements encoding/TextMarshaller and writes out an HashTile
	 * instance as sequences of concatenated hashes as specified by the tlog-tiles spec.
	 *
	 * Port note: Go returns `([]byte, error)`, but the only error it can produce comes
	 * from `bytes.Buffer.Write`, which never fails. There is nothing to report here.
	 */
	marshalText(): Uint8Array {
		return concatBytes(...this.nodes);
	}

	/**
	 * unmarshalText implements encoding/TextUnmarshaler and reads HashTiles
	 * which are encoded using the tlog-tiles spec.
	 *
	 * Port note: hardening with no Go counterpart: a tile holding more than the
	 * tlog-tiles maximum of TileWidth (256) hashes is rejected, where Go accepts any
	 * multiple of 32 bytes. See docs/decisions/0194-tile-and-bundle-size-limits.md.
	 */
	unmarshalText(raw: Uint8Array): void {
		if (raw.length % sha256Size !== 0) {
			throw new Error(`${raw.length} is not a multiple of ${sha256Size}`);
		}
		if (raw.length > TileWidth * sha256Size) {
			throw new Error(`tile of ${raw.length / sha256Size} hashes exceeds the maximum of ${TileWidth}`);
		}
		const nodes: Uint8Array[] = [];
		for (let index = 0; index < raw.length; index += sha256Size) {
			const data = raw.subarray(index, index + sha256Size);
			nodes.push(data);
		}
		this.nodes = nodes;
	}
}

/**
 * EntryBundle represents a sequence of entries in the log.
 * These entries correspond to a leaf tile in the hash tree.
 */
export class EntryBundle {
	/** entries stores the leaf entries of the log, in order. */
	entries: Uint8Array[];

	constructor(entries: Uint8Array[] = []) {
		this.entries = entries;
	}

	/**
	 * unmarshalText implements encoding/TextUnmarshaler and reads EntryBundles
	 * which are encoded using the tlog-tiles spec.
	 *
	 * Port note: hardening with no Go counterpart: parsing stops with an error at a
	 * 257th entry, the tlog-tiles maximum being EntryBundleWidth (256), where Go reads
	 * any number of entries. See docs/decisions/0194-tile-and-bundle-size-limits.md.
	 */
	unmarshalText(raw: Uint8Array): void {
		// Port note: upstream pre-allocates capacity layout.EntryBundleWidth here. A
		// JavaScript array has no separate capacity, so the hint has no counterpart.
		const nodes: Uint8Array[] = [];
		for (let index = 0; index < raw.length; ) {
			if (nodes.length === EntryBundleWidth) {
				throw new Error(`entry bundle holds more than the maximum of ${EntryBundleWidth} entries`);
			}
			const dataIndex = index + 2;
			if (dataIndex > raw.length) {
				throw new Error(`dangling bytes at byte index ${index} in data of ${raw.length} bytes`);
			}
			const size = readUint16BE(raw, index);
			const dataEnd = dataIndex + size;
			if (dataEnd > raw.length) {
				throw new Error(`require ${size} bytes from byte index ${dataIndex}, but size is ${raw.length}`);
			}
			const data = raw.subarray(dataIndex, dataEnd);
			nodes.push(data);
			index = dataIndex + size;
		}
		this.entries = nodes;
	}
}
