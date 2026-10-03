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

// This file is not a port of a Tessera file. It stands in for the one use of Go's
// `bufio` package that the port's sources share: a `bufio.Scanner` over an in-memory
// byte slice with the default `ScanLines` split function, as `bufio.NewScanner(
// bytes.NewReader(p))` builds it. Tessera's witness policy parser (witness.go) and
// transparency-dev/formats' tlog-proof decoder (proof/tlog_proof.go) both read their
// input that way, and both depend on its exact edge cases: a `\r` before the newline is
// dropped, a final line without a newline is still a line, and a line of
// MaxScanTokenSize bytes or more stops the scan with ErrTooLong.

import { fromUTF8 } from "./bytes.ts";
import { SentinelError } from "./errors.ts";

/**
 * MaxScanTokenSize is `bufio.MaxScanTokenSize`, the maximum size of a token a default
 * Scanner accepts: a line (counting a `\r` before its newline, but not the newline
 * itself) must be shorter than this.
 */
export const MaxScanTokenSize = 64 * 1024;

/** ErrTooLong stands in for `bufio.ErrTooLong`, which Scanner.err() reports for a line that is too long. */
export const ErrTooLong = new SentinelError("bufio.Scanner: token too long");

/**
 * Scanner stands in for a `bufio.Scanner` reading p with the `ScanLines` split function.
 *
 * Successive calls to {@link scan} step through the lines of p, skipping the bytes
 * between them: one line per `\n`, with the `\n` and a `\r` immediately before it
 * removed, and no empty final line for input that ends with a newline. The scan stops
 * at the end of the input, or at the first line of {@link MaxScanTokenSize} bytes or
 * more, after which {@link err} returns {@link ErrTooLong}. As in Go, {@link text} and
 * {@link bytes} return the empty value once scan has returned false.
 */
export class Scanner {
	readonly #p: Uint8Array;
	#start = 0;
	#token: Uint8Array = new Uint8Array(0);
	#err: Error | undefined;
	#done = false;

	constructor(p: Uint8Array) {
		this.#p = p;
	}

	/**
	 * scan advances the Scanner to the next line, which is then available through
	 * {@link bytes} or {@link text}. It returns false when the scan stops, by reaching the
	 * end of the input or an error; {@link err} then returns the error, or undefined if
	 * the scan stopped at the end of the input.
	 */
	scan(): boolean {
		this.#token = new Uint8Array(0);
		if (this.#done) {
			return false;
		}
		const p = this.#p;
		if (this.#start >= p.length) {
			this.#done = true;
			return false;
		}
		const nl = p.indexOf(0x0a, this.#start);
		const end = nl < 0 ? p.length : nl;
		if (end - this.#start >= MaxScanTokenSize) {
			this.#done = true;
			this.#err = ErrTooLong;
			return false;
		}
		// ScanLines' dropCR.
		const lineEnd = end > this.#start && p[end - 1] === 0x0d ? end - 1 : end;
		this.#token = p.subarray(this.#start, lineEnd);
		this.#start = end + 1;
		return true;
	}

	/**
	 * bytes returns the line produced by the most recent call to {@link scan}. It is a
	 * view of the input, as Go's Bytes is a view of the Scanner's buffer.
	 */
	bytes(): Uint8Array {
		return this.#token;
	}

	/** text returns the line produced by the most recent call to {@link scan}, as a string. */
	text(): string {
		return fromUTF8(this.#token);
	}

	/** err returns the error that stopped the scan, or undefined if it reached the end of the input. */
	err(): Error | undefined {
		return this.#err;
	}
}
