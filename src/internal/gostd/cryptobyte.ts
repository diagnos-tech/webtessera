// Copyright 2017 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
//
// Use of this source code is governed by a BSD-style license, reproduced here
// because this file is a derivative work of golang.org/x/crypto/cryptobyte and
// this repository is otherwise Apache-2.0:
//
// Copyright 2009 The Go Authors.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google LLC nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Ported from golang.org/x/crypto@v0.46.0/cryptobyte/{string,builder}.go

// Package cryptobyte contains types that help with parsing and constructing
// length-prefixed, binary messages.
//
// The String type is for parsing. It wraps a Uint8Array and provides helper
// functions for consuming structures, value by value.
//
// The Builder type is for constructing messages. It providers helper functions
// for appending values and also for appending length-prefixed submessages –
// without having to worry about calculating the length prefix ahead of time.
//
// Port note: upstream's ASN.1 support (the `asn1` subpackage, `AddASN1*`,
// `ReadASN1*`, and the `isASN1` branch of `addLengthPrefixed`) and its fixed-size
// Builder (`NewFixedBuilder`, `AddValue`) are not ported — Tessera uses neither.
// See docs/decisions/0040-cryptobyte-port-scope.md.

const emptyBytes = new Uint8Array(0);

/**
 * BuildError wraps an error. If a BuilderContinuation throws this value, it will be
 * caught and the inner error will be reported by Builder.bytes.
 *
 * Port note: Go's BuildError is a plain struct used as a panic payload. Here it
 * extends Error, because throwing a non-Error breaks stack capture in every JS
 * runtime; the wrapped error is still available as `err`, exactly as in Go.
 */
export class BuildError extends Error {
	readonly err: Error;

	constructor(err: Error) {
		super(err.message, { cause: err });
		this.name = "BuildError";
		this.err = err;
	}
}

/**
 * BuilderContinuation is a continuation-passing interface for building
 * length-prefixed byte sequences. Builder methods for length-prefixed
 * sequences (addUint8LengthPrefixed etc) will invoke the BuilderContinuation
 * supplied to them. The child builder passed to the continuation can be used
 * to build the content of the length-prefixed sequence. For example:
 *
 *	const parent = new Builder();
 *	parent.addUint8LengthPrefixed((child) => {
 *	  child.addUint8(42);
 *	  child.addUint8LengthPrefixed((grandchild) => {
 *	    grandchild.addUint8(5);
 *	  });
 *	});
 *
 * It is an error to write more bytes to the child than allowed by the reserved
 * length prefix. After the continuation returns, the child must be considered
 * invalid, i.e. users must not store any copies or references of the child
 * that outlive the continuation.
 *
 * If the continuation throws a value of type BuildError then the inner error
 * will be reported as the error from bytes. If the child throws otherwise then
 * bytes will rethrow the same value.
 */
export type BuilderContinuation = (child: Builder) => void;

/**
 * A Builder builds byte strings from fixed-length and length-prefixed values.
 *
 * Simple values are marshaled and appended to a Builder using methods on the
 * Builder. Length-prefixed values are marshaled by providing a
 * BuilderContinuation, which is a function that writes the inner contents of
 * the value to a given Builder. See the documentation for BuilderContinuation
 * for details.
 */
export class Builder {
	private err: Error | undefined;
	// Port note: Go's `result []byte` is a slice header — a pointer to a backing array
	// plus a length — and `append` reallocates when the array is full. TypeScript has no
	// growable byte slice, so the pair is modelled explicitly. `buf` stands in for the
	// backing array, which a parent and its child share until an append reallocates it,
	// and `len` stands in for `len(b.result)`, which each builder tracks for itself.
	// `flushChild` copies both back from the child, mirroring Go's `b.result = child.result`.
	// See docs/decisions/0041-cryptobyte-builder-buffer-model.md.
	private buf: Uint8Array = emptyBytes;
	private len = 0;
	private child: Builder | undefined;
	private offset = 0;
	private pendingLenLen = 0;
	private inContinuation: { value: boolean } | undefined;

	/**
	 * The zero value is a usable Builder that allocates space as needed. Pass a buffer to
	 * append to it instead, as Go's NewBuilder does.
	 */
	constructor(buffer?: Uint8Array) {
		if (buffer !== undefined) {
			this.buf = buffer;
			this.len = buffer.length;
		}
	}

	/**
	 * setError sets the value to be reported as the error from bytes. Writes
	 * performed after calling setError are ignored.
	 */
	setError(err: Error): void {
		this.err = err;
	}

	/**
	 * bytes returns the bytes written by the builder, or throws if an error has
	 * occurred during building.
	 *
	 * Port note: Go returns `([]byte, error)` here and panics in BytesOrPanic; in
	 * TypeScript both throw, so the two are the same function. bytesOrPanic is kept so
	 * that call sites stay in one-to-one correspondence with the Go source. See
	 * docs/decisions/0042-cryptobyte-error-and-out-parameter-shape.md.
	 */
	bytes(): Uint8Array {
		if (this.err !== undefined) {
			throw this.err;
		}
		return this.buf.slice(this.offset, this.len);
	}

	/**
	 * bytesOrPanic returns the bytes written by the builder or throws if an error
	 * has occurred during building.
	 */
	bytesOrPanic(): Uint8Array {
		if (this.err !== undefined) {
			throw this.err;
		}
		return this.buf.slice(this.offset, this.len);
	}

	/** addUint8 appends an 8-bit value to the byte string. */
	addUint8(v: number): void {
		this.add(Uint8Array.of(v));
	}

	/** addUint16 appends a big-endian, 16-bit value to the byte string. */
	addUint16(v: number): void {
		this.add(Uint8Array.of(v >>> 8, v));
	}

	/**
	 * addUint24 appends a big-endian, 24-bit value to the byte string. The highest
	 * byte of the 32-bit input value is silently truncated.
	 */
	addUint24(v: number): void {
		this.add(Uint8Array.of(v >>> 16, v >>> 8, v));
	}

	/** addUint32 appends a big-endian, 32-bit value to the byte string. */
	addUint32(v: number): void {
		this.add(Uint8Array.of(v >>> 24, v >>> 16, v >>> 8, v));
	}

	/** addUint48 appends a big-endian, 48-bit value to the byte string. */
	addUint48(v: bigint): void {
		this.add(
			Uint8Array.of(
				Number((v >> 40n) & 0xffn),
				Number((v >> 32n) & 0xffn),
				Number((v >> 24n) & 0xffn),
				Number((v >> 16n) & 0xffn),
				Number((v >> 8n) & 0xffn),
				Number(v & 0xffn),
			),
		);
	}

	/** addUint64 appends a big-endian, 64-bit value to the byte string. */
	addUint64(v: bigint): void {
		this.add(
			Uint8Array.of(
				Number((v >> 56n) & 0xffn),
				Number((v >> 48n) & 0xffn),
				Number((v >> 40n) & 0xffn),
				Number((v >> 32n) & 0xffn),
				Number((v >> 24n) & 0xffn),
				Number((v >> 16n) & 0xffn),
				Number((v >> 8n) & 0xffn),
				Number(v & 0xffn),
			),
		);
	}

	/** addBytes appends a sequence of bytes to the byte string. */
	addBytes(v: Uint8Array): void {
		this.add(v);
	}

	/** addUint8LengthPrefixed adds a 8-bit length-prefixed byte sequence. */
	addUint8LengthPrefixed(f: BuilderContinuation): void {
		this.addLengthPrefixed(1, f);
	}

	/** addUint16LengthPrefixed adds a big-endian, 16-bit length-prefixed byte sequence. */
	addUint16LengthPrefixed(f: BuilderContinuation): void {
		this.addLengthPrefixed(2, f);
	}

	/** addUint24LengthPrefixed adds a big-endian, 24-bit length-prefixed byte sequence. */
	addUint24LengthPrefixed(f: BuilderContinuation): void {
		this.addLengthPrefixed(3, f);
	}

	/** addUint32LengthPrefixed adds a big-endian, 32-bit length-prefixed byte sequence. */
	addUint32LengthPrefixed(f: BuilderContinuation): void {
		this.addLengthPrefixed(4, f);
	}

	private callContinuation(f: BuilderContinuation, arg: Builder): void {
		// addLengthPrefixed always allocates this before calling in, so the fallback is
		// unreachable; it stands in for Go's guarantee that b.inContinuation is non-nil here.
		// biome-ignore lint/suspicious/noAssignInExpressions: lazy initialisation is the point of this line.
		const inContinuation = (this.inContinuation ??= { value: false });
		if (!inContinuation.value) {
			inContinuation.value = true;

			try {
				f(arg);
			} catch (r) {
				if (r instanceof BuildError) {
					this.err = r.err;
				} else {
					throw r;
				}
			} finally {
				inContinuation.value = false;
			}
			return;
		}

		f(arg);
	}

	private addLengthPrefixed(lenLen: number, f: BuilderContinuation): void {
		// Subsequent writes can be ignored if the builder has encountered an error.
		if (this.err !== undefined) {
			return;
		}

		const offset = this.len;
		this.add(new Uint8Array(lenLen));

		if (this.inContinuation === undefined) {
			this.inContinuation = { value: false };
		}

		const child = new Builder();
		child.buf = this.buf;
		child.len = this.len;
		child.offset = offset;
		child.pendingLenLen = lenLen;
		child.inContinuation = this.inContinuation;
		this.child = child;

		this.callContinuation(f, this.child);
		this.flushChild();
		if (this.child !== undefined) {
			throw new Error("cryptobyte: internal error");
		}
	}

	private flushChild(): void {
		if (this.child === undefined) {
			return;
		}
		this.child.flushChild();
		const child = this.child;
		this.child = undefined;

		if (child.err !== undefined) {
			this.err = child.err;
			return;
		}

		const length = child.len - child.pendingLenLen - child.offset;

		if (length < 0) {
			throw new Error("cryptobyte: internal error"); // result unexpectedly shrunk
		}

		// Port note: the length is divided rather than shifted because a JavaScript
		// bitwise operator truncates its operand to 32 bits, and a uint32 length prefix
		// can legitimately describe more bytes than that.
		let l = length;
		for (let i = child.pendingLenLen - 1; i >= 0; i--) {
			child.buf[child.offset + i] = l % 256;
			l = Math.floor(l / 256);
		}
		if (l !== 0) {
			this.err = new Error(
				`cryptobyte: pending child length ${length} exceeds ${child.pendingLenLen}-byte length prefix`,
			);
			return;
		}

		this.buf = child.buf;
		this.len = child.len;
	}

	private add(bytes: Uint8Array): void {
		if (this.err !== undefined) {
			return;
		}
		if (this.child !== undefined) {
			throw new Error("cryptobyte: attempted write while child is pending");
		}
		this.grow(bytes.length);
		this.buf.set(bytes, this.len);
		this.len += bytes.length;
	}

	// grow makes room for n more bytes, reallocating the backing array if it is full.
	// It stands in for the reallocation Go's append performs, and doubles for the same
	// reason: to keep repeated appends amortised constant time.
	private grow(n: number): void {
		const need = this.len + n;
		if (need <= this.buf.length) {
			return;
		}
		let capacity = this.buf.length === 0 ? 64 : this.buf.length * 2;
		while (capacity < need) {
			capacity *= 2;
		}
		const next = new Uint8Array(capacity);
		next.set(this.buf.subarray(0, this.len));
		this.buf = next;
	}

	/**
	 * unwrite rolls back non-negative n bytes written directly to the Builder.
	 * An attempt by a child builder passed to a continuation to unwrite bytes
	 * from its parent will throw.
	 */
	unwrite(n: number): void {
		if (this.err !== undefined) {
			return;
		}
		if (this.child !== undefined) {
			throw new Error("cryptobyte: attempted unwrite while child is pending");
		}
		const length = this.len - this.pendingLenLen - this.offset;
		if (length < 0) {
			throw new Error("cryptobyte: internal error");
		}
		if (n < 0) {
			throw new Error("cryptobyte: attempted to unwrite negative number of bytes");
		}
		if (n > length) {
			throw new Error("cryptobyte: attempted to unwrite more than was written");
		}
		this.len -= n;
	}
}

/**
 * newBuilder creates a Builder that appends its output to the given buffer.
 *
 * Port note: unlike Go's NewBuilder, the buffer is never written to in place — a
 * Uint8Array has no spare capacity to write into, so the first append copies. Callers
 * that relied on Go's aliasing must read the result back from bytes(). See
 * docs/decisions/0041-cryptobyte-builder-buffer-model.md.
 */
export function newBuilder(buffer: Uint8Array): Builder {
	return new Builder(buffer);
}

/**
 * String represents a string of bytes. It provides methods for parsing
 * fixed-length and length-prefixed values from it.
 *
 * Port note: Go's `type String []byte` is consumed through a pointer receiver that
 * reslices the value in place. TypeScript has no reslicing, so String is a cursor
 * object over a Uint8Array. Its read methods return the value read, or undefined where
 * Go returns false, and leave the cursor untouched on failure exactly as Go does. See
 * docs/decisions/0042-cryptobyte-error-and-out-parameter-shape.md.
 */
// biome-ignore lint/suspicious/noShadowRestrictedNames: the name mirrors Go's cryptobyte.String; see ADR-0042.
export class String {
	private s: Uint8Array;

	constructor(b?: Uint8Array) {
		this.s = b ?? emptyBytes;
	}

	/** length reports the number of unread bytes, standing in for Go's `len(s)`. */
	get length(): number {
		return this.s.length;
	}

	/**
	 * bytes returns the unread bytes. It stands in for Go's implicit conversion from
	 * `String` to `[]byte`, and like that conversion it aliases the underlying storage
	 * rather than copying it.
	 */
	bytes(): Uint8Array {
		return this.s;
	}

	// read advances a String by n bytes and returns them. If less than n bytes
	// remain, it returns undefined.
	private read(n: number): Uint8Array | undefined {
		if (this.s.length < n || n < 0) {
			return undefined;
		}
		const v = this.s.subarray(0, n);
		this.s = this.s.subarray(n);
		return v;
	}

	/** skip advances the String by n byte and reports whether it was successful. */
	skip(n: number): boolean {
		return this.read(n) !== undefined;
	}

	/**
	 * readUint8 decodes an 8-bit value and advances over it. It returns undefined if
	 * the read was unsuccessful.
	 */
	readUint8(): number | undefined {
		const v = this.read(1);
		if (v === undefined) {
			return undefined;
		}
		return v[0] as number;
	}

	/**
	 * readUint16 decodes a big-endian, 16-bit value and advances over it. It returns
	 * undefined if the read was unsuccessful.
	 */
	readUint16(): number | undefined {
		const v = this.read(2);
		if (v === undefined) {
			return undefined;
		}
		return ((v[0] as number) << 8) | (v[1] as number);
	}

	/**
	 * readUint24 decodes a big-endian, 24-bit value and advances over it. It returns
	 * undefined if the read was unsuccessful.
	 */
	readUint24(): number | undefined {
		const v = this.read(3);
		if (v === undefined) {
			return undefined;
		}
		return ((v[0] as number) << 16) | ((v[1] as number) << 8) | (v[2] as number);
	}

	/**
	 * readUint32 decodes a big-endian, 32-bit value and advances over it. It returns
	 * undefined if the read was unsuccessful.
	 */
	readUint32(): number | undefined {
		const v = this.read(4);
		if (v === undefined) {
			return undefined;
		}
		// Multiplication rather than a shift: `x << 24` is a signed 32-bit operation in
		// JavaScript and would make any value with the high bit set come out negative.
		return (v[0] as number) * 0x1000000 + (((v[1] as number) << 16) | ((v[2] as number) << 8) | (v[3] as number));
	}

	/**
	 * readUint48 decodes a big-endian, 48-bit value and advances over it. It returns
	 * undefined if the read was unsuccessful.
	 */
	readUint48(): bigint | undefined {
		const v = this.read(6);
		if (v === undefined) {
			return undefined;
		}
		return this.beUint(v);
	}

	/**
	 * readUint64 decodes a big-endian, 64-bit value and advances over it. It returns
	 * undefined if the read was unsuccessful.
	 */
	readUint64(): bigint | undefined {
		const v = this.read(8);
		if (v === undefined) {
			return undefined;
		}
		return this.beUint(v);
	}

	private beUint(v: Uint8Array): bigint {
		let out = 0n;
		for (let i = 0; i < v.length; i++) {
			out = (out << 8n) | BigInt(v[i] as number);
		}
		return out;
	}

	private readLengthPrefixed(lenLen: number): String | undefined {
		const lenBytes = this.read(lenLen);
		if (lenBytes === undefined) {
			return undefined;
		}
		let length = 0;
		for (const b of lenBytes) {
			length = length * 256 + b;
		}
		const v = this.read(length);
		if (v === undefined) {
			return undefined;
		}
		return new String(v);
	}

	/**
	 * readUint8LengthPrefixed reads the content of an 8-bit length-prefixed value and
	 * advances over it. It returns undefined if the read was unsuccessful.
	 */
	readUint8LengthPrefixed(): String | undefined {
		return this.readLengthPrefixed(1);
	}

	/**
	 * readUint16LengthPrefixed reads the content of a big-endian, 16-bit
	 * length-prefixed value and advances over it. It returns undefined if the read was
	 * unsuccessful.
	 */
	readUint16LengthPrefixed(): String | undefined {
		return this.readLengthPrefixed(2);
	}

	/**
	 * readUint24LengthPrefixed reads the content of a big-endian, 24-bit
	 * length-prefixed value and advances over it. It returns undefined if the read was
	 * unsuccessful.
	 */
	readUint24LengthPrefixed(): String | undefined {
		return this.readLengthPrefixed(3);
	}

	/**
	 * readBytes reads n bytes and advances over them. It returns undefined if the read
	 * was unsuccessful.
	 */
	readBytes(n: number): Uint8Array | undefined {
		return this.read(n);
	}

	/** empty reports whether the string does not contain any bytes. */
	empty(): boolean {
		return this.s.length === 0;
	}
}
