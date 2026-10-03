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

// This file has no upstream counterpart. It is where the witness keeps what it has cosigned:
// one object per log, on any ObjectStore. See docs/decisions/0172-witness-state-on-objectstore.md.

import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, toUTF8 } from "../internal/gostd/bytes.ts";
import { checkpointUnsafe } from "../internal/parse/parse.ts";
import type { ObjectStore } from "../storage/objectstore/objectstore.ts";

/**
 * WitnessStore is the part of the ObjectStore contract the witness uses. Every ObjectStore
 * (memory, IndexedDB, Durable Object storage, SQLite) satisfies it.
 *
 * Its guarantees are what make the witness safe: `put` replaces an object atomically and
 * is durable when it resolves (the spec's "The witness MUST persist the new checkpoint
 * before responding"), and `lock` excludes every other holder that can reach the same data,
 * which is what makes reading the latest checkpoint, checking the request against it and
 * writing the new one a single atomic step, as the spec requires to rule out the rollback
 * race it describes.
 */
export type WitnessStore = Pick<ObjectStore, "get" | "put" | "lock">;

/** LatestState is what the witness knows about a log: the latest checkpoint it cosigned. */
export interface LatestState {
	/** size is the latest cosigned tree size, or 0 if the witness never cosigned one. */
	readonly size: bigint;
	/** hash is the latest cosigned root hash, or undefined if there is none. */
	readonly hash: Uint8Array | undefined;
	/** checkpoint is the stored cosigned checkpoint, or undefined if there is none. */
	readonly checkpoint: Uint8Array | undefined;
}

/**
 * originHash returns the lowercase hex SHA-256 of a log's origin, which is how the spec's
 * monitoring endpoint names a log: "The origin hash is the SHA-256 hash of the log's
 * origin, hex encoded, in lowercase."
 */
export function originHash(origin: string): string {
	return toHex(sha256(toUTF8(origin)));
}

/**
 * checkpointKey returns the key the latest cosigned checkpoint of a log is stored under:
 * `<keyPrefix><origin hash>/checkpoint`, the path the monitoring endpoint serves it at. A
 * store that is published as static files therefore serves the monitoring API as it is,
 * which is the delegation to a CDN the spec has in mind.
 */
export function checkpointKey(keyPrefix: string, origin: string): string {
	return `${keyPrefix}${originHash(origin)}/checkpoint`;
}

/**
 * readLatest reads the latest cosigned checkpoint stored under key.
 *
 * The stored checkpoint is parsed without verifying its signatures: it was verified before
 * it was written, and the store is inside the witness's trusted computing base. Not
 * re-verifying is also what lets a log rotate its key without the witness forgetting it.
 */
export async function readLatest(store: WitnessStore, key: string): Promise<LatestState> {
	const checkpoint = await store.get(key);
	if (checkpoint === undefined) {
		return { size: 0n, hash: undefined, checkpoint: undefined };
	}
	const { size, hash } = checkpointUnsafe(checkpoint);
	return { size, hash, checkpoint };
}
