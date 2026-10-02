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
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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
				throw new ParseCheckpointError(`failed to unmarshal checkpoint: ${errText(err)}`, n);
			}
			if (cp.origin !== origin) {
				throw new ParseCheckpointError(`got Origin ${quote(cp.origin)} but expected ${quote(origin)}`, n);
			}
			return { checkpoint: cp, otherData, note: n };
		}
	}
	throw new ParseCheckpointError("no log signature found on note", n);
}
