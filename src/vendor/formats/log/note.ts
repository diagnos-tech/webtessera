// Copyright 2021 Google LLC. All Rights Reserved.
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
// Ported from github.com/transparency-dev/formats/log/note.go
// @ v0.0.0-20251017110053-404c0d5b696c

import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import { quote } from "../../../internal/gostd/strconv.ts";
import { type Note, open, type Verifier, verifierList } from "../../note/note.ts";
import { Checkpoint } from "./checkpoint.ts";

/**
 * A ParsedCheckpoint is what {@link parseCheckpoint} returns on success.
 *
 * Port note: Go returns `(*Checkpoint, []byte, *note.Note, error)`. TypeScript has no
 * multiple return, so the three values come back in an object.
 * See docs/decisions/0022-parse-checkpoint-result.md.
 */
export interface ParsedCheckpoint {
	/** checkpoint is the parsed checkpoint body. */
	checkpoint: Checkpoint;
	/** otherData is whatever followed the checkpoint body in the note text, or undefined. */
	otherData: Uint8Array | undefined;
	/** note is the underlying note, including every signature that verified. */
	note: Note;
}

/**
 * A ParseCheckpointError is the error {@link parseCheckpoint} throws.
 *
 * Port note: Go's ParseCheckpoint returns the underlying note alongside its error
 * whenever it has one — upstream's own test asserts on the signature count of a note
 * that failed to parse — so the error has to carry it. `note` is undefined only when
 * the note itself could not be opened.
 * See docs/decisions/0022-parse-checkpoint-result.md.
 */
export class ParseCheckpointError extends Error {
	readonly note: Note | undefined;

	constructor(message: string, note: Note | undefined) {
		super(message);
		this.name = "ParseCheckpointError";
		this.note = note;
	}
}

/** errText renders an error the way Go's `%v` verb does. */
function errText(err: Error): string {
	return err.message;
}

/**
 * isReturnedError reports whether err is the port of an error a Go function would
 * have *returned*, as opposed to a panic.
 *
 * Port note: ParseCheckpoint wraps every error that note.Open and Unmarshal return;
 * a panic is not an error return and propagates through it untouched. The port has
 * only throws, so the distinction is drawn by class: TypeError, RangeError,
 * ReferenceError and SyntaxError are what JavaScript raises where Go would panic (a
 * nil dereference, an index out of range, a bug), and a thrown non-Error is never an
 * error return. Those propagate unchanged instead of being flattened into a
 * ParseCheckpointError message, which would hide a programming error behind "failed
 * to verify signatures". Every error class sumdb/note and Checkpoint.unmarshal use
 * for their results is a plain Error or a subclass of it, so is still wrapped.
 * See docs/decisions/0209-parsecheckpoint-wraps-only-returned-errors.md.
 */
function isReturnedError(err: unknown): err is Error {
	return (
		err instanceof Error &&
		!(err instanceof TypeError) &&
		!(err instanceof RangeError) &&
		!(err instanceof ReferenceError) &&
		!(err instanceof SyntaxError)
	);
}

/**
 * checkpointHashSize is the size of a checkpoint's root hash: tlog-checkpoint defines it
 * as the root of the RFC 6962 Merkle tree, and tlog-tiles fixes that tree's hash
 * algorithm as SHA-256.
 */
const checkpointHashSize = 32;

/**
 * parseCheckpoint takes a raw checkpoint as bytes and returns a parsed checkpoint
 * and any otherData in the body, providing that:
 * * a valid log signature is found; and
 * * the checkpoint unmarshals correctly; and
 * * the log origin is that expected.
 * In all other cases, a {@link ParseCheckpointError} is thrown. The underlying note is
 * always carried on the error where possible.
 * The signatures on the note will include the log signature if no error is thrown,
 * plus any signatures from otherVerifiers that were found.
 *
 * Port note: in addition to upstream's checks, the checkpoint's root hash must be 32
 * bytes ("failed to unmarshal checkpoint: invalid checkpoint - root hash has
 * unexpected size N, want 32"). C2SP tlog-checkpoint defines the third line as "the
 * base64 encoding of the root of the RFC 6962 Merkle hash tree", and RFC 6962 (and
 * C2SP tlog-tiles: "The hashing algorithm is defined to be SHA-256") fixes that hash
 * at SHA-256; upstream accepts any length. The check runs after upstream's, so
 * whatever upstream rejects is rejected with upstream's error.
 * See docs/decisions/0202-merkle-proof-hash-sizes.md.
 */
export function parseCheckpoint(
	chkpt: Uint8Array,
	origin: string,
	logVerifier: Verifier,
	...otherVerifiers: Verifier[]
): ParsedCheckpoint {
	const vs = [logVerifier, ...otherVerifiers];
	const verifiers = verifierList(...vs);

	let n: Note;
	try {
		n = open(chkpt, verifiers);
	} catch (err) {
		if (!isReturnedError(err)) {
			throw err;
		}
		// Port note: Go formats the cause with %v, not %w, so the chain stops here.
		// Keeping that means `errorIs` cannot see past this boundary in TypeScript
		// either, which is the behaviour every existing caller was written against.
		throw new ParseCheckpointError(`failed to verify signatures on checkpoint: ${errText(err)}`, undefined);
	}

	for (const s of n.sigs ?? []) {
		if (s.hash === logVerifier.keyHash() && s.name === logVerifier.name()) {
			// The log has signed this checkpoint. It is now safe to parse.
			const cp = new Checkpoint();
			let otherData: Uint8Array | undefined;
			try {
				otherData = cp.unmarshal(toUTF8(n.text));
			} catch (err) {
				if (!isReturnedError(err)) {
					throw err;
				}
				throw new ParseCheckpointError(`failed to unmarshal checkpoint: ${errText(err)}`, n);
			}
			if (cp.origin !== origin) {
				throw new ParseCheckpointError(`got Origin ${quote(cp.origin)} but expected ${quote(origin)}`, n);
			}
			if (cp.hash.length !== checkpointHashSize) {
				throw new ParseCheckpointError(
					`failed to unmarshal checkpoint: invalid checkpoint - root hash has unexpected size ${cp.hash.length}, want ${checkpointHashSize}`,
					n,
				);
			}
			return { checkpoint: cp, otherData, note: n };
		}
	}
	throw new ParseCheckpointError("no log signature found on note", n);
}
