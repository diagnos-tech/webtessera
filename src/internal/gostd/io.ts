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

// This file is not a port of a Tessera file. It stands in for the small part of Go's
// `io` package that the port relies on: `note.GenerateKey` takes an `io.Reader` for
// its randomness, and both the upstream tests and the upstream examples depend on
// being able to substitute a deterministic or a failing one.

import { SentinelError } from "./errors.ts";

/** EOF stands in for `io.EOF`: a Reader has no more input to give. */
export const EOF = new SentinelError("EOF");

/**
 * ErrUnexpectedEOF stands in for `io.ErrUnexpectedEOF`: a read that had already
 * produced some bytes hit the end of the input before it could produce them all.
 */
export const ErrUnexpectedEOF = new SentinelError("unexpected EOF");

/**
 * A Reader is the port of `io.Reader`.
 *
 * read fills p with up to p.length bytes and returns the number of bytes read, which
 * may be fewer than p.length even when more input remains. It throws to report an
 * error, and throws {@link EOF} when the input is exhausted.
 *
 * Port note: Go's `Read` returns `(n int, err error)` and is permitted to report a
 * non-zero n together with an error. A thrown error cannot carry n, so a Reader that
 * has bytes to deliver must return them and report the error on the following call.
 * That is the behaviour `io.ReadFull` is specified against anyway, and it is what
 * every Reader in this port and its tests does.
 */
export interface Reader {
	read(p: Uint8Array): number;
}

/**
 * readFull reads exactly buf.length bytes from r into buf (`io.ReadFull`).
 *
 * It throws {@link EOF} if no bytes were read at all, {@link ErrUnexpectedEOF} if
 * fewer than buf.length bytes were read, and re-throws any other reader error
 * unchanged.
 *
 * Port note: a read that returns 0 bytes without throwing is treated as the end of the
 * input here ({@link EOF} if nothing had been read yet, otherwise {@link ErrUnexpectedEOF}).
 * Go's `io.ReadFull` retries such a read, because `io.Reader` documents (0, nil) as
 * "nothing happened"; a reader that keeps returning it makes Go's loop spin forever. A
 * synchronous Reader has nothing to wait for between calls, so a retry could never see
 * different input, and failing is the safer reading. The difference is observable only
 * for a Reader that returns 0 and later returns bytes. See
 * docs/decisions/0020-gostd-stdlib-standins-for-note.md.
 */
export function readFull(r: Reader, buf: Uint8Array): void {
	let n = 0;
	while (n < buf.length) {
		let got: number;
		try {
			got = r.read(buf.subarray(n));
		} catch (e) {
			if (e === EOF && n > 0) {
				throw ErrUnexpectedEOF;
			}
			throw e;
		}
		if (got <= 0) {
			throw n > 0 ? ErrUnexpectedEOF : EOF;
		}
		n += got;
	}
}
