// Copyright 2024 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/lifecycle.go @ 4a6d9f9

import { sha256 } from "@noble/hashes/sha2.js";
import { EntryBundle } from "./api/state.ts";
import type { AddFn } from "./append_lifecycle.ts";
import { DefaultHasher } from "./vendor/merkle/rfc6962/rfc6962.ts";

/**
 * LogReader provides read-only access to the log.
 *
 * Port note: every method's `ctx context.Context` moves to an optional trailing `signal`
 * parameter, per docs/decisions/0004-errors-context-and-concurrency.md.
 */
export interface LogReader {
	/**
	 * readCheckpoint returns the latest checkpoint available.
	 * If no checkpoint is available then ErrNotExist should be thrown.
	 */
	readCheckpoint(signal?: AbortSignal): Promise<Uint8Array>;

	/**
	 * readTile returns the raw marshalled tile at the given coordinates, if it exists.
	 * The expected usage for this method is to derive the parameters from a tree size
	 * that has been committed to by a checkpoint returned by this log. Whenever such a
	 * tree size is used, this method will behave as per the https://c2sp.org/tlog-tiles
	 * spec for the /tile/ path.
	 *
	 * If callers pass in parameters that are not implied by a published tree size, then
	 * implementations _may_ act differently from one another, but all will act in ways
	 * that are allowed by the spec. For example, if the only published tree size has been
	 * for size 2, then asking for a partial tile of 1 may lead to some implementations
	 * returning not found, some may return a tile with 1 leaf, and some may return a tile
	 * with more leaves.
	 */
	readTile(level: bigint, index: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array>;

	/**
	 * readEntryBundle returns the raw marshalled leaf bundle at the given coordinates, if
	 * it exists.
	 * The expected usage and corresponding behaviours are similar to readTile.
	 */
	readEntryBundle(index: bigint, p: number, signal?: AbortSignal): Promise<Uint8Array>;

	/**
	 * nextIndex returns the first as-yet unassigned index.
	 *
	 * In a quiescent log, this will be the same as the checkpoint size. In a log with entries actively
	 * being added, this number will be higher since it will take sequenced but not-yet-integrated/not-yet-published
	 * entries into account.
	 */
	nextIndex(signal?: AbortSignal): Promise<bigint>;

	/**
	 * integratedSize returns the current size of the integrated tree.
	 *
	 * This tree will have in place all the static resources the returned size implies, but
	 * there may not yet be a checkpoint for this size signed, witnessed, or published.
	 *
	 * It's ONLY safe to use this value for processes internal to the operation of the log (e.g.
	 * populating antispam data structures); it MUST NOT not be used as a substitute for
	 * reading the checkpoint when only data which has been publicly committed to by the
	 * log should be used. If in doubt, use readCheckpoint instead.
	 */
	integratedSize(signal?: AbortSignal): Promise<bigint>;
}

/**
 * Follower describes the contract of an entity which tracks the contents of the local log.
 *
 * Currently, this is only used by anti-spam.
 */
export interface Follower {
	/** name returns a human readable name for this follower. */
	name(): string;

	/**
	 * follow should be implemented so as to visit entries in the log in order, using the provided
	 * LogReader to access the entry bundles which contain them.
	 *
	 * Implementations should keep track of their progress such that they can pick-up where they left off
	 * if e.g. the binary is restarted.
	 */
	follow(reader: LogReader, signal?: AbortSignal): void;

	/**
	 * entriesProcessed reports the progress of the follower, returning the total number of log entries
	 * successfully seen/processed.
	 */
	entriesProcessed(signal?: AbortSignal): Promise<bigint>;
}

/**
 * Antispam describes the contract that an antispam implementation must meet in order to be used via the
 * WithAntispam option below.
 */
export interface Antispam {
	/**
	 * decorator must return a function which knows how to decorate an Appender's Add function in order
	 * to return an index previously assigned to an entry with the same identity hash, if one exists, or
	 * delegate to the next Add function in the chain otherwise.
	 */
	decorator(): (fn: AddFn) => AddFn;

	/**
	 * follower should return a structure which will populate the anti-spam index by tailing the contents
	 * of the log, using the provided function to turn entry bundles into identity hashes.
	 */
	follower(idHasher: (entryBundle: Uint8Array) => Uint8Array[]): Follower;
}

/** identityHash calculates the antispam identity hash for the provided (single) leaf entry data. */
export function identityHash(data: Uint8Array): Uint8Array {
	return sha256(data);
}

/**
 * defaultIDHasher returns a list of identity hashes corresponding to entries in the provided bundle.
 * Currently, these are simply SHA256 hashes of the raw byte of each entry.
 *
 * Port note: unexported in Go and untested there (lifecycle.go has no lifecycle_test.go
 * upstream). Exported here so lifecycle_test.ts can exercise it directly, the same reason
 * ADR-0044 exports ct_only.go's otherwise-unexported bundle parsers. Not re-exported from
 * any package barrel, so it stays off the published API surface.
 */
export function defaultIDHasher(bundle: Uint8Array): Uint8Array[] {
	const eb = new EntryBundle();
	try {
		eb.unmarshalText(bundle);
	} catch (err) {
		// Port note: Go formats this with %v, not %w — the underlying error is
		// deliberately not wrapped, matching src/internal/parse/parse.ts's `messageOf`
		// helper, which exists for exactly this reason.
		throw new Error(`unmarshal: ${messageOf(err)}`);
	}
	return eb.entries.map((e) => identityHash(e));
}

/**
 * defaultMerkleLeafHasher parses a C2SP tlog-tile bundle and returns the Merkle leaf hashes of each entry it contains.
 *
 * Port note: see defaultIDHasher above — exported for the same reason.
 */
export function defaultMerkleLeafHasher(bundle: Uint8Array): Uint8Array[] {
	const eb = new EntryBundle();
	try {
		eb.unmarshalText(bundle);
	} catch (err) {
		throw new Error(`unmarshal: ${messageOf(err)}`);
	}
	return eb.entries.map((e) => DefaultHasher.hashLeaf(e));
}

// messageOf renders a caught value the way Go's `%v` renders an error.
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
