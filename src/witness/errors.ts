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

// This file has no upstream counterpart. It names the outcomes of the C2SP tlog-witness
// add-checkpoint call (https://c2sp.org/tlog-witness) that are not a cosignature, one
// sentinel per HTTP status the spec assigns, so that programmatic callers and the HTTP
// handler agree on them. The names follow transparency-dev/witness, the Go witness, where
// it has an equivalent. See docs/decisions/0171-witness-server.md.

import { SentinelError } from "../internal/gostd/errors.ts";

/**
 * ErrMalformedRequest is the cause of every rejection the spec answers with "400 Bad
 * Request": a body that does not follow the request grammar, a checkpoint that is not a
 * well-formed note or checkpoint, or an old size larger than the checkpoint's.
 */
export const ErrMalformedRequest = new SentinelError("malformed request");

/**
 * ErrUnknownLog is the cause when the witness has no keys for the checkpoint's origin:
 * "If the checkpoint origin is unknown, the witness MUST respond with a "404 Not Found"
 * HTTP status code."
 */
export const ErrUnknownLog = new SentinelError("unknown log");

/**
 * ErrNoValidSignature is the cause when no signature from a key trusted for the origin
 * verifies, or one that names a trusted key fails to: the spec's "403 Forbidden".
 */
export const ErrNoValidSignature = new SentinelError("no valid signature from a trusted log key");

/**
 * ErrOldSizeMismatch is the cause when the request's old size is not the size of the
 * latest checkpoint the witness cosigned for the log. It is always carried by an
 * {@link OldSizeMismatchError}, which says what that size is.
 */
export const ErrOldSizeMismatch = new SentinelError("old size does not match the latest cosigned checkpoint");

/**
 * OldSizeMismatchError reports the "409 Conflict" the spec prescribes when the old size
 * does not match, with the size the client should retry from. The HTTP handler sends it
 * as the response body, "the tree size of the latest cosigned checkpoint in decimal,
 * followed by a newline", with `Content-Type: text/x.tlog.size`.
 */
export class OldSizeMismatchError extends Error {
	/** latestSize is the size of the latest cosigned checkpoint, or 0 if there is none. */
	readonly latestSize: bigint;

	constructor(oldSize: bigint, latestSize: bigint) {
		super(`${ErrOldSizeMismatch.message}: old size ${oldSize}, latest cosigned size ${latestSize}`, {
			cause: ErrOldSizeMismatch,
		});
		this.name = "OldSizeMismatchError";
		this.latestSize = latestSize;
	}
}

/**
 * ErrRootMismatch is the cause when the checkpoint has the size of the latest cosigned
 * one but a different root hash: proof that the log presented two different trees of the
 * same size. tlog-witness v1.0.0 answers it with "409 Conflict" (without the
 * `text/x.tlog.size` body that distinguishes the old-size conflict); see
 * docs/decisions/0171-witness-server.md for the later editor's draft that moves it to 422.
 */
export const ErrRootMismatch = new SentinelError(
	"root hash differs from the latest cosigned checkpoint of the same size",
);

/**
 * ErrInvalidProof is the cause of every "422 Unprocessable Entity": a consistency proof
 * that does not verify, a non-empty proof where the spec requires an empty one, or a
 * checkpoint of size zero whose root is not the empty tree's.
 */
export const ErrInvalidProof = new SentinelError("invalid consistency proof");

// maxEchoChars bounds how much of a request a refusal message repeats back.
const maxEchoChars = 96;

/**
 * echo quotes a piece of a request for an error message, cut down to a bounded length, so
 * that a refusal never reflects more than a few dozen characters of attacker input.
 *
 * @internal
 */
export function echo(s: string): string {
	const clipped = s.length > maxEchoChars ? `${s.slice(0, maxEchoChars)}...` : s;
	return JSON.stringify(clipped);
}
