// Copyright 2024 The Tessera authors. All Rights Reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from tessera/internal/parse/parse.go @ 4a6d9f9

// Module parse contains internal methods for parsing data structures quickly,
// if unsafely. This is a bit of a utility package which is an anti-pattern, but
// this code is critical enough that it should be reused, tested, and benchmarked
// rather than copied around willy nilly.
// If a better home becomes available, feel free to move the contents elsewhere.

import { fromBase64, fromUTF8, splitN, toUTF8 } from "../gostd/bytes.ts";
import { parseUint, quote } from "../gostd/strconv.ts";

const newline = toUTF8("\n");

/**
 * ParsedCheckpoint is what CheckpointUnsafe returns.
 *
 * Port note: Go returns the three values positionally. See
 * docs/decisions/0031-multi-value-returns.md.
 */
export interface ParsedCheckpoint {
	/** origin is the checkpoint's origin line. */
	readonly origin: string;
	/** size is the size of the tree the checkpoint commits to. */
	readonly size: bigint;
	/** hash is the root hash of that tree. */
	readonly hash: Uint8Array;
}

// CheckpointUnsafe parses a checkpoint without performing any signature verification.
// This is intended to be as fast as possible, but sacrifices safety because it skips verifying
// the note signature.
//
// Parsing a checkpoint like this is only acceptable in the same binary as the
// log implementation that generated it and thus we can safely assume it's a well formed and
// validly signed checkpoint. Anyone copying similar logic into client code will get hurt.
//
// Port note: Go's `string(b)` keeps every byte of b, valid UTF-8 or not, and `%q` then
// escapes an invalid byte as `\xNN`. fromUTF8 decodes each invalid sequence to U+FFFD
// instead, which quote writes as the character U+FFFD itself, as Go quotes a genuine
// U+FFFD, so for a checkpoint that is not valid UTF-8 the returned origin, and the quoted
// text in these error messages, differ from Go's. A JavaScript string cannot hold the raw
// bytes Go's does; only malformed checkpoints are affected. See the `invalid-utf8-text`
// entry of docs/decisions/0216-differential-divergence-allow-list.md.
export function checkpointUnsafe(rawCp: Uint8Array): ParsedCheckpoint {
	const parts = splitN(rawCp, newline, 4);
	if (parts.length !== 4) {
		throw new Error(`invalid checkpoint: ${quote(fromUTF8(rawCp))}`);
	}
	const origin = fromUTF8(parts[0] as Uint8Array);
	const sizeStr = fromUTF8(parts[1] as Uint8Array);
	const hashStr = fromUTF8(parts[2] as Uint8Array);
	let size: bigint;
	try {
		size = parseUint(sizeStr, 10, 64);
	} catch (err) {
		throw new Error(`failed to turn checkpoint size of ${quote(sizeStr)} into uint64: ${messageOf(err)}`);
	}
	let hash: Uint8Array;
	try {
		hash = fromBase64(hashStr);
	} catch (err) {
		throw new Error(`failed to decode hash: ${messageOf(err)}`);
	}
	return { origin, size, hash };
}

// messageOf renders a caught value the way Go's `%v` renders an error.
//
// Port note: upstream formats both of these with `%v`, not `%w`, so the underlying
// error is deliberately not wrapped and `cause` is deliberately not set — an
// `errorIs` walk must not find it, just as `errors.Is` would not.
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
