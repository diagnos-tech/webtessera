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

// This file has no upstream counterpart. It reads and writes the body of the C2SP
// tlog-witness add-checkpoint request (https://c2sp.org/tlog-witness); Tessera's own
// client writes the same body in src/internal/witness/witness.ts. See
// docs/decisions/0171-witness-server.md.

import { MaxUint64 } from "../internal/gostd/bits.ts";
import { concatBytes, fromBase64, fromUTF8, indexByte, toBase64, toUTF8 } from "../internal/gostd/bytes.ts";
import { ErrMalformedRequest, echo } from "./errors.ts";

/**
 * MaxConsistencyProofLines is the most proof lines a request may carry: "The client MUST
 * NOT send more than 63 consistency proof lines." A consistency proof between trees of
 * at most 2^64 leaves never needs more.
 */
export const MaxConsistencyProofLines = 63;

// hashSize is the size of a Merkle tree hash; tlog-witness logs use SHA-256 (RFC 6962).
const hashSize = 32;

/** AddCheckpointRequest is the content of an add-checkpoint request. */
export interface AddCheckpointRequest {
	/** oldSize is the size of the checkpoint the client believes the witness last cosigned. */
	readonly oldSize: bigint;
	/** proof is the consistency proof from oldSize to the checkpoint's size. */
	readonly proof: readonly Uint8Array[];
	/** checkpoint is the signed checkpoint note to cosign. */
	readonly checkpoint: Uint8Array;
}

/**
 * parseAddCheckpointRequest parses an add-checkpoint request body, throwing an error
 * caused by ErrMalformedRequest if it does not follow the grammar exactly:
 *
 *	The request body MUST be a sequence of
 *	  - an old size line,
 *	  - zero or more consistency proof lines,
 *	  - and an empty line,
 *	  - followed by a [checkpoint][].
 *
 *	Each line MUST terminate in a newline character (U+000A).
 *
 *	The old size line MUST consist of the string `old`, a single space (0x20),
 *	and the tree size of the previous checkpoint encoded as an ASCII decimal with no
 *	leading zeroes (unless the size is zero, in which case the encoding MUST be `0`).
 *
 *	Each consistency proof line MUST encode a single hash in base64.
 *
 * Proof lines must be canonical, padded standard base64 of exactly one 32-byte hash
 * ("decoders MUST reject non-canonical encodings", as the editor's draft of the spec puts
 * it). The checkpoint is returned as it was sent, for the caller to verify.
 */
export function parseAddCheckpointRequest(body: Uint8Array): AddCheckpointRequest {
	let rest = body;
	const nextLine = (what: string): string => {
		const i = indexByte(rest, 0x0a);
		if (i < 0) {
			throw malformed(`${what} is not terminated by a newline`);
		}
		const line = rest.subarray(0, i);
		rest = rest.subarray(i + 1);
		// Every line before the checkpoint is ASCII by grammar. A byte that is not decodes
		// to U+FFFD, which the patterns below then reject.
		return fromUTF8(line);
	};

	const oldLine = nextLine("the old size line");
	const m = /^old (0|[1-9][0-9]{0,19})$/.exec(oldLine);
	const oldSize = m?.[1] === undefined ? undefined : BigInt(m[1]);
	if (oldSize === undefined || oldSize > MaxUint64) {
		throw malformed(`invalid old size line ${echo(oldLine)}`);
	}

	const proof: Uint8Array[] = [];
	for (;;) {
		const line = nextLine("a consistency proof line");
		if (line === "") {
			break;
		}
		if (proof.length === MaxConsistencyProofLines) {
			throw malformed(`more than ${MaxConsistencyProofLines} consistency proof lines`);
		}
		proof.push(decodeHash(line));
	}

	if (rest.length === 0) {
		throw malformed("no checkpoint after the empty line");
	}
	return { oldSize, proof, checkpoint: rest };
}

/**
 * marshalAddCheckpointRequest encodes an add-checkpoint request body, for clients that
 * submit checkpoints to a witness without going through an appender's witness gateway.
 */
export function marshalAddCheckpointRequest(req: AddCheckpointRequest): Uint8Array {
	let head = `old ${req.oldSize}\n`;
	for (const p of req.proof) {
		head += `${toBase64(p)}\n`;
	}
	head += "\n";
	return concatBytes(toUTF8(head), req.checkpoint);
}

/** decodeHash decodes one proof line, which must be the canonical base64 of one hash. */
function decodeHash(line: string): Uint8Array {
	let h: Uint8Array;
	try {
		h = fromBase64(line);
	} catch {
		throw malformed(`consistency proof line ${echo(line)} is not base64`);
	}
	if (h.length !== hashSize || toBase64(h) !== line) {
		throw malformed(`consistency proof line ${echo(line)} is not the canonical base64 of a 32-byte hash`);
	}
	return h;
}

function malformed(message: string): Error {
	return new Error(`${ErrMalformedRequest.message}: ${message}`, { cause: ErrMalformedRequest });
}
