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

import { describe, expect, it } from "vitest";
import { errorIs } from "./errors.ts";
import { EOF, ErrUnexpectedEOF, type Reader, readFull } from "./io.ts";

/** zeroReader mirrors the zeroReader of sumdb/note's example_test.go. */
class zeroReader implements Reader {
	read(buf: Uint8Array): number {
		buf.fill(0);
		return buf.length;
	}
}

/** oneByteReader mirrors iotest.OneByteReader: it yields one byte per read. */
class oneByteReader implements Reader {
	private n = 0;
	read(buf: Uint8Array): number {
		if (buf.length === 0) {
			return 0;
		}
		buf[0] = this.n++;
		return 1;
	}
}

/** shortReader yields limit bytes in total and then reports EOF. */
class shortReader implements Reader {
	private remaining: number;
	constructor(limit: number) {
		this.remaining = limit;
	}
	read(buf: Uint8Array): number {
		if (this.remaining === 0) {
			throw EOF;
		}
		const n = Math.min(buf.length, this.remaining);
		buf.fill(1, 0, n);
		this.remaining -= n;
		return n;
	}
}

describe("gostd/io", () => {
	it("readFull fills the buffer from a reader that returns it all at once", () => {
		const buf = new Uint8Array(32).fill(0xff);
		readFull(new zeroReader(), buf);
		expect(Array.from(buf)).toEqual(new Array<number>(32).fill(0));
	});

	it("readFull loops over a reader that returns one byte at a time", () => {
		const buf = new Uint8Array(4);
		readFull(new oneByteReader(), buf);
		expect(Array.from(buf)).toEqual([0, 1, 2, 3]);
	});

	it("readFull reports ErrUnexpectedEOF on a partial read", () => {
		const buf = new Uint8Array(32);
		let thrown: unknown;
		try {
			readFull(new shortReader(3), buf);
		} catch (e) {
			thrown = e;
		}
		expect(errorIs(thrown, ErrUnexpectedEOF)).toBe(true);
	});

	it("readFull reports EOF when nothing at all could be read", () => {
		const buf = new Uint8Array(32);
		let thrown: unknown;
		try {
			readFull(new shortReader(0), buf);
		} catch (e) {
			thrown = e;
		}
		expect(errorIs(thrown, EOF)).toBe(true);
	});

	it("readFull treats a read of 0 bytes with no error as the end of the input, unlike Go's retry", () => {
		// Go's io.ReadFull retries a (0, nil) read, which spins forever on a reader that never
		// makes progress; the port reports EOF instead (see readFull's Port note).
		const stalled: Reader = {
			read(): number {
				return 0;
			},
		};
		expect(() => readFull(stalled, new Uint8Array(4))).toThrow(EOF);
	});

	it("readFull reports ErrUnexpectedEOF when a read of 0 bytes follows a partial read", () => {
		let calls = 0;
		const stallsAfterOneByte: Reader = {
			read(buf: Uint8Array): number {
				calls++;
				if (calls === 1) {
					buf[0] = 7;
					return 1;
				}
				return 0;
			},
		};
		expect(() => readFull(stallsAfterOneByte, new Uint8Array(4))).toThrow(ErrUnexpectedEOF);
		expect(calls).toBe(2);
	});

	it("readFull propagates a reader error", () => {
		const boom = new Error("boom");
		const failing: Reader = {
			read(): number {
				throw boom;
			},
		};
		expect(() => readFull(failing, new Uint8Array(8))).toThrow(boom);
	});

	it("readFull on an empty buffer never touches the reader", () => {
		const failing: Reader = {
			read(): number {
				throw new Error("should not be called");
			},
		};
		expect(() => readFull(failing, new Uint8Array(0))).not.toThrow();
	});
});
