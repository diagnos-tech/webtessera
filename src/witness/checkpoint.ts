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

// This file has no upstream counterpart. See docs/decisions/0171-witness-server.md.

import { fromBase64, toBase64 } from "../internal/gostd/bytes.ts";
import { ErrMalformedRequest } from "./errors.ts";

// hashSize is the size of a checkpoint's root hash: tlog-checkpoint logs use SHA-256.
const hashSize = 32;

/** CheckpointBody is the part of a checkpoint a witness reasons about. */
export interface CheckpointBody {
	readonly origin: string;
	readonly size: bigint;
	readonly hash: Uint8Array;
}

/**
 * parseCheckpointBody parses the text of a verified checkpoint note strictly, as
 * https://c2sp.org/tlog-checkpoint defines it: a non-empty origin line; the tree size "with
 * no leading zeroes (unless the tree is empty)"; and the root hash, which this requires to be
 * the canonical base64 of exactly 32 bytes.
 *
 * `formats/log`'s Checkpoint.unmarshal, the port of the Go parser, is deliberately more
 * lenient (it accepts leading zeroes and a hash of any length), which is right for a client
 * reading its own log but not for a witness: a root hash of another length is not a tree
 * head any proof can be checked against, and two spellings of one size are two
 * checkpoints. The size line is matched against a bounded pattern before it is converted,
 * so its length cannot make the conversion expensive.
 */
export function parseCheckpointBody(text: string): CheckpointBody {
	// Three newline-terminated lines make at least four parts.
	const [origin, sizeLine, hashLine, rest] = text.split("\n");
	if (origin === undefined || sizeLine === undefined || hashLine === undefined || rest === undefined) {
		throw malformed("a checkpoint needs an origin, a size and a root hash line");
	}
	if (origin === "") {
		throw malformed("empty origin line");
	}
	if (!/^(0|[1-9][0-9]{0,19})$/.test(sizeLine)) {
		throw malformed("tree size is not a decimal number without leading zeroes");
	}
	const size = BigInt(sizeLine);
	if (size > 0xffffffffffffffffn) {
		throw malformed("tree size exceeds 2^64-1");
	}
	let hash: Uint8Array;
	try {
		hash = fromBase64(hashLine);
	} catch {
		throw malformed("root hash is not base64");
	}
	if (hash.length !== hashSize || toBase64(hash) !== hashLine) {
		throw malformed("root hash is not the canonical base64 of a 32-byte hash");
	}
	return { origin, size, hash };
}

function malformed(message: string): Error {
	return new Error(`${ErrMalformedRequest.message}: invalid checkpoint: ${message}`, { cause: ErrMalformedRequest });
}
