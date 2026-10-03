// Copyright 2026 MedDeck LTDA. All Rights Reserved.
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

// This file has no upstream counterpart. It produces the witness's cosignatures
// (https://c2sp.org/tlog-cosignature) and the checkpoint the witness stores alongside them.
// See docs/decisions/0171-witness-server.md.

import { concatBytes, toUTF8 } from "../internal/gostd/bytes.ts";
import { coSigV1Timestamp } from "../vendor/formats/note/note_cosigv1.ts";
import { open, type Signature, type Signer, sign, UnverifiedNoteError, verifierList } from "../vendor/note/note.ts";
import { echo } from "./errors.ts";

/** Cosigned is the outcome of cosigning a checkpoint. */
export interface Cosigned {
	/**
	 * signatureLines is the add-checkpoint response body: "a sequence of one or more [note]
	 * signature lines, each starting with the `—` character (U+2014) and ending with a
	 * newline character (U+000A)".
	 */
	readonly signatureLines: Uint8Array;
	/**
	 * checkpoint is the note to store: the checkpoint text, the log signatures the witness
	 * verified, and the witness's own. The monitoring endpoint serves it, and the spec
	 * requires exactly that: "it MUST include the cosignature(s) from the witness's key(s)
	 * that were returned from add-checkpoint and the cosignature from the log key(s) that
	 * the witness verified."
	 */
	readonly checkpoint: Uint8Array;
	/** signatures are the witness's own signatures, parsed. */
	readonly signatures: readonly Signature[];
}

/**
 * cosign signs the checkpoint text with every signer, once. Signing once matters: a
 * cosignature/v1 signer embeds the current time, so signing the stored checkpoint and the
 * response separately could make them disagree.
 */
export function cosign(text: string, logSignatures: readonly Signature[], signers: readonly Signer[]): Cosigned {
	const textBytes = toUTF8(text);
	const signed = sign({ text }, ...signers);
	// sign returns the text, a blank line, and then exactly the new signature lines.
	const signatureLines = signed.subarray(textBytes.length + 1);
	let logLines = "";
	for (const s of logSignatures) {
		logLines += `— ${s.name} ${s.base64}\n`;
	}
	return {
		signatureLines,
		checkpoint: concatBytes(textBytes, toUTF8(`\n${logLines}`), signatureLines),
		signatures: signaturesOf(signed),
	};
}

/**
 * checkTimestampsAdvance throws if a new cosignature/v1 signature carries a timestamp the
 * spec does not allow, or one older than the latest the same key made for this log.
 *
 * A cosignature/v1 says that "as of the specified time, the consistent tree head with the
 * largest size the cosigner has observed for the log ... has the specified root hash". If
 * the witness's clock stepped backwards, a fresh cosignature on a larger tree would carry
 * an earlier time than the cosignature on the smaller one, and the two statements would
 * contradict each other. Refusing is safe: nothing is stored, and the log retries with its
 * next checkpoint.
 *
 * Timestamps are compared as the int64 seconds the signatures carry. tlog-cosignature
 * requires one to be positive ("the timestamp MUST NOT be zero") and to "NOT exceed
 * 2^63 - 1", which the int64 reading enforces by turning anything larger negative; a stored
 * timestamp outside that range means the stored state is not what this witness wrote, and is
 * refused just as explicitly rather than compared. Signatures that are not cosignature/v1
 * (other algorithms embed time differently, or not at all) are not compared.
 */
export function checkTimestampsAdvance(
	origin: string,
	latest: Uint8Array | undefined,
	fresh: readonly Signature[],
): void {
	const previous = latest === undefined ? [] : signaturesOf(latest);
	for (const f of fresh) {
		const now = timestampOf(f);
		if (now === undefined) {
			continue;
		}
		if (now <= 0n) {
			throw new Error(`witness produced a cosignature with invalid timestamp ${now} for ${echo(origin)}`);
		}
		for (const p of previous) {
			if (p.name !== f.name || p.hash !== f.hash) {
				continue;
			}
			const then = timestampOf(p);
			if (then === undefined) {
				continue;
			}
			if (then <= 0n) {
				throw new Error(`stored cosignature for ${echo(origin)} has invalid timestamp ${then}`);
			}
			if (now < then) {
				throw new Error(`witness clock is behind its latest cosignature for ${echo(origin)}: ${now}s < ${then}s`);
			}
		}
	}
}

/**
 * signaturesOf returns every signature on a note without verifying any. Opening a note
 * with no known keys is the documented way to do that: open "records signatures without
 * associated verifiers as unverified signatures" and, finding no verified one, throws an
 * UnverifiedNoteError carrying the parsed note.
 */
function signaturesOf(note: Uint8Array): Signature[] {
	try {
		open(note, verifierList());
	} catch (err) {
		if (err instanceof UnverifiedNoteError) {
			return err.note.unverifiedSigs ?? [];
		}
		throw err;
	}
	return [];
}

/** timestampOf returns a cosignature/v1 signature's timestamp in int64 seconds, if it is one. */
function timestampOf(s: Signature): bigint | undefined {
	try {
		return coSigV1Timestamp(s);
	} catch {
		return undefined;
	}
}
