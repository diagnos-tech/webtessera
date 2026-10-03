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
// Ported from github.com/transparency-dev/formats/log/checkpoint.go
// @ v0.0.0-20251017110053-404c0d5b696c

// Package log provides basic support for the common log checkpoint and proof
// format described by the README in this directory.

import { assertUint64 } from "../../../internal/gostd/bits.ts";
import { fromBase64, fromUTF8, splitN, toBase64, toUTF8 } from "../../../internal/gostd/bytes.ts";
import { wrapError } from "../../../internal/gostd/errors.ts";
import { parseUint } from "../../../internal/gostd/strconv.ts";
import { validUTF8, validUTF8String } from "../../../internal/gostd/unicode.ts";

const NEWLINE = toUTF8("\n");

/** Checkpoint represents a minimal log checkpoint (STH). */
export class Checkpoint {
	/** origin is the string identifying the log which issued this checkpoint. */
	origin: string;
	/**
	 * size is the number of entries in the log at this checkpoint.
	 *
	 * Port note: `uint64` in Go, so `bigint` here. See docs/decisions/0003-uint64-as-bigint.md.
	 */
	size: bigint;
	/** hash is the hash which commits to the contents of the entire log. */
	hash: Uint8Array;

	/**
	 * Port note: Go builds a Checkpoint with a composite literal and relies on the
	 * zero value elsewhere (`var got log.Checkpoint`, `cp := &Checkpoint{}`). The
	 * optional initialiser gives both: `new Checkpoint()` is the zero value.
	 *
	 * Port note: size must be a uint64; anything else throws a RangeError. See
	 * docs/decisions/0207-uint64-domain-guards.md.
	 */
	constructor(init?: { origin?: string; size?: bigint; hash?: Uint8Array }) {
		const size = init?.size ?? 0n;
		assertUint64(size, "size");
		this.origin = init?.origin ?? "";
		this.size = size;
		this.hash = init?.hash ?? new Uint8Array(0);
	}

	/**
	 * marshal returns the common format representation of this Checkpoint.
	 *
	 * Port note: Go's Marshal cannot fail. This throws a RangeError if size is not a
	 * uint64 (docs/decisions/0207-uint64-domain-guards.md), and an Error if origin
	 * holds an unpaired UTF-16 surrogate, which UTF-8 cannot encode and which would
	 * otherwise be written as U+FFFD — a checkpoint for a different origin
	 * (docs/decisions/0203-checkpoint-origin-must-be-utf8.md).
	 */
	marshal(): Uint8Array {
		assertUint64(this.size, "size");
		if (!validUTF8String(this.origin)) {
			throw new Error("invalid checkpoint - origin is not valid UTF-8");
		}
		return toUTF8(`${this.origin}\n${this.size}\n${toBase64(this.hash)}\n`);
	}

	/**
	 * unmarshal parses the common formatted checkpoint data and stores the result
	 * in the Checkpoint.
	 *
	 * The supplied data is expected to begin with the following 3 lines of text,
	 * each followed by a newline:
	 *   - <origin string>
	 *   - <decimal representation of log size>
	 *   - <base64 representation of root hash>
	 *
	 * Any trailing data after this will be returned.
	 *
	 * Port note: Go returns `([]byte, error)` and assigns to the receiver only on
	 * success, so a failed Unmarshal leaves the Checkpoint untouched. This throws
	 * instead, and likewise assigns nothing before it can no longer fail — upstream's
	 * table test compares the receiver against the zero value on every error case.
	 * The absent trailing data is `undefined`, mirroring Go's nil rather than
	 * flattening it to an empty slice.
	 *
	 * Port note: an origin line that is not valid UTF-8 is rejected ("invalid
	 * checkpoint - origin is not valid UTF-8"), after all of upstream's own checks.
	 * Go keeps the raw bytes in the origin string; a JavaScript string cannot hold
	 * them, and decoding them to U+FFFD would make distinct origins compare equal.
	 * Checkpoints arriving through a signed note are unaffected: note.open already
	 * rejects any note that is not valid UTF-8, in Go as here.
	 * See docs/decisions/0203-checkpoint-origin-must-be-utf8.md.
	 */
	unmarshal(data: Uint8Array): Uint8Array | undefined {
		const [l0, l1, l2, l3] = splitN(data, NEWLINE, 4);
		if (l0 === undefined || l1 === undefined || l2 === undefined || l3 === undefined) {
			throw new Error("invalid checkpoint - too few newlines");
		}
		const origin = fromUTF8(l0);
		if (origin.length === 0) {
			throw new Error("invalid checkpoint - empty origin");
		}
		let size: bigint;
		try {
			size = parseUint(fromUTF8(l1), 10, 64);
		} catch (err) {
			throw wrapError("invalid checkpoint - size invalid", err);
		}
		let h: Uint8Array;
		try {
			h = fromBase64(fromUTF8(l2));
		} catch (err) {
			throw wrapError("invalid checkpoint - invalid hash", err);
		}
		if (!validUTF8(l0)) {
			throw new Error("invalid checkpoint - origin is not valid UTF-8");
		}
		let rest: Uint8Array | undefined;
		if (l3.length > 0) {
			rest = l3;
		}
		this.origin = origin;
		this.size = size;
		this.hash = h;
		return rest;
	}
}
