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

// This file is not a port of a Tessera file. It stands in for Go's `bytes`,
// `encoding/hex`, `encoding/base64` and `encoding/binary` packages, which the port
// uses pervasively and TypeScript does not provide.
//
// Everything here is deliberately dependency-free and allocation-conscious: it sits
// underneath the Merkle layer, which is the hottest code in the package.

const HEX_ALPHABET = "0123456789abcdef";

/** bytesEqual reports whether a and b have the same length and contents (`bytes.Equal`). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a === b) {
		return true;
	}
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

/**
 * bytesCompare returns -1, 0 or +1 according to whether a sorts before, equal to, or
 * after b in lexicographic byte order (`bytes.Compare`).
 */
export function bytesCompare(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const av = a[i] as number;
		const bv = b[i] as number;
		if (av !== bv) {
			return av < bv ? -1 : 1;
		}
	}
	if (a.length === b.length) {
		return 0;
	}
	return a.length < b.length ? -1 : 1;
}

/** concatBytes joins the given slices into one, in order (`bytes.Join` with no separator). */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) {
		total += p.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/**
 * splitN slices s into subslices separated by sep, returning at most n of them
 * (`bytes.SplitN`).
 *
 * The last returned subslice is the unsplit remainder. n < 0 returns every subslice;
 * n == 0 returns none. As in Go, the returned subslices are views into s, not copies.
 */
export function splitN(s: Uint8Array, sep: Uint8Array, n: number): Uint8Array[] {
	if (n === 0) {
		return [];
	}
	if (sep.length === 0) {
		throw new Error("bytes: splitN with an empty separator is not supported");
	}
	const out: Uint8Array[] = [];
	let start = 0;
	while (n < 0 || out.length < n - 1) {
		const i = indexOf(s, sep, start);
		if (i < 0) {
			break;
		}
		out.push(s.subarray(start, i));
		start = i + sep.length;
	}
	out.push(s.subarray(start));
	return out;
}

/** indexOf returns the index of the first instance of sep in s at or after from, or -1. */
function indexOf(s: Uint8Array, sep: Uint8Array, from: number): number {
	const last = s.length - sep.length;
	outer: for (let i = from; i <= last; i++) {
		for (let j = 0; j < sep.length; j++) {
			if (s[i + j] !== sep[j]) {
				continue outer;
			}
		}
		return i;
	}
	return -1;
}

/** indexByte returns the index of the first instance of c in s, or -1 (`bytes.IndexByte`). */
export function indexByte(s: Uint8Array, c: number): number {
	for (let i = 0; i < s.length; i++) {
		if (s[i] === c) {
			return i;
		}
	}
	return -1;
}

/**
 * lastIndex returns the index of the last instance of sep in s, or -1 (`bytes.LastIndex`).
 * As in Go, an empty sep matches at the end of s.
 */
export function lastIndex(s: Uint8Array, sep: Uint8Array): number {
	if (sep.length === 0) {
		return s.length;
	}
	outer: for (let i = s.length - sep.length; i >= 0; i--) {
		for (let j = 0; j < sep.length; j++) {
			if (s[i + j] !== sep[j]) {
				continue outer;
			}
		}
		return i;
	}
	return -1;
}

/** hasPrefix reports whether s begins with prefix (`bytes.HasPrefix`). */
export function hasPrefix(s: Uint8Array, prefix: Uint8Array): boolean {
	if (s.length < prefix.length) {
		return false;
	}
	for (let i = 0; i < prefix.length; i++) {
		if (s[i] !== prefix[i]) {
			return false;
		}
	}
	return true;
}

/** toHex encodes b as a lower-case hexadecimal string (`hex.EncodeToString`). */
export function toHex(b: Uint8Array): string {
	let out = "";
	for (let i = 0; i < b.length; i++) {
		const v = b[i] as number;
		out += HEX_ALPHABET[v >> 4];
		out += HEX_ALPHABET[v & 0x0f];
	}
	return out;
}

/**
 * fromHex decodes a lower- or upper-case hexadecimal string (`hex.DecodeString`).
 * It throws on odd length or non-hex characters, as Go's decoder does.
 */
export function fromHex(s: string): Uint8Array {
	if (s.length % 2 !== 0) {
		throw new Error(`encoding/hex: odd length hex string: ${s.length}`);
	}
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) {
		const byte = Number.parseInt(s.substring(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(byte)) {
			throw new Error(`encoding/hex: invalid byte at offset ${i * 2}`);
		}
		out[i] = byte;
	}
	return out;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/** toUTF8 encodes a string as UTF-8 bytes, which is what `[]byte(s)` does in Go. */
export function toUTF8(s: string): Uint8Array {
	return utf8Encoder.encode(s);
}

/** fromUTF8 decodes UTF-8 bytes to a string, which is what `string(b)` does in Go. */
export function fromUTF8(b: Uint8Array): string {
	return utf8Decoder.decode(b);
}

/**
 * appendUint16BE appends v to b in big-endian order
 * (`binary.BigEndian.AppendUint16`). It is how tlog-tiles length-prefixes entries.
 */
export function appendUint16BE(b: Uint8Array, v: number): Uint8Array {
	const out = new Uint8Array(b.length + 2);
	out.set(b, 0);
	out[b.length] = (v >> 8) & 0xff;
	out[b.length + 1] = v & 0xff;
	return out;
}

/** readUint16BE reads a big-endian uint16 at the given offset (`binary.BigEndian.Uint16`). */
export function readUint16BE(b: Uint8Array, offset: number): number {
	const hi = b[offset];
	const lo = b[offset + 1];
	if (hi === undefined || lo === undefined) {
		throw new Error("binary: read past end of buffer");
	}
	return (hi << 8) | lo;
}

/** appendUint32BE appends v to b in big-endian order (`binary.BigEndian.AppendUint32`). */
export function appendUint32BE(b: Uint8Array, v: number): Uint8Array {
	const out = new Uint8Array(b.length + 4);
	out.set(b, 0);
	out[b.length] = (v >>> 24) & 0xff;
	out[b.length + 1] = (v >>> 16) & 0xff;
	out[b.length + 2] = (v >>> 8) & 0xff;
	out[b.length + 3] = v & 0xff;
	return out;
}

/**
 * readUint32BE reads a big-endian uint32 at the given offset
 * (`binary.BigEndian.Uint32`). The result is unsigned: sumdb/note key hashes are
 * uint32 and routinely have the top bit set.
 */
export function readUint32BE(b: Uint8Array, offset: number): number {
	const b0 = b[offset];
	const b1 = b[offset + 1];
	const b2 = b[offset + 2];
	const b3 = b[offset + 3];
	if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
		throw new Error("binary: read past end of buffer");
	}
	return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

/** appendUint64BE appends v to b in big-endian order (`binary.BigEndian.AppendUint64`). */
export function appendUint64BE(b: Uint8Array, v: bigint): Uint8Array {
	const out = new Uint8Array(b.length + 8);
	out.set(b, 0);
	for (let i = 7; i >= 0; i--) {
		out[b.length + i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

/** readUint64BE reads a big-endian uint64 at the given offset (`binary.BigEndian.Uint64`). */
export function readUint64BE(b: Uint8Array, offset: number): bigint {
	let v = 0n;
	for (let i = 0; i < 8; i++) {
		const byte = b[offset + i];
		if (byte === undefined) {
			throw new Error("binary: read past end of buffer");
		}
		v = (v << 8n) | BigInt(byte);
	}
	return v;
}

/** toBase64 encodes b as standard base64 with padding (`base64.StdEncoding.EncodeToString`). */
export function toBase64(b: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < b.length; i++) {
		binary += String.fromCharCode(b[i] as number);
	}
	return btoa(binary);
}

const BASE64_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD_CHAR = 0x3d; // '='
const CR = 0x0d;
const LF = 0x0a;

/** BASE64_STD_DECODE_MAP is Go's `Encoding.decodeMap`: 0xff marks a character not in the alphabet. */
const BASE64_STD_DECODE_MAP = ((): Uint8Array => {
	const m = new Uint8Array(256).fill(0xff);
	for (let i = 0; i < BASE64_STD_ALPHABET.length; i++) {
		m[BASE64_STD_ALPHABET.charCodeAt(i)] = i;
	}
	return m;
})();

/** corruptInputError is the port of `base64.CorruptInputError`. */
function corruptInputError(offset: number): Error {
	return new Error(`illegal base64 data at input byte ${offset}`);
}

/**
 * fromBase64 decodes standard base64 with padding (`base64.StdEncoding.DecodeString`).
 *
 * Port note: this is a transcription of Go's `Encoding.Decode`/`decodeQuantum` rather
 * than a wrapper around `atob`, for two reasons.
 *
 * Acceptance: `atob` implements WHATWG forgiving-base64, which accepts missing padding
 * and strips *all* ASCII whitespace. `base64.StdEncoding` rejects unpadded input and
 * ignores only \r and \n. Both differences are load-bearing — `internal/parse` relies
 * on the strictness to reject a malformed checkpoint hash, and `sumdb/note` relies on
 * it to reject a signature line whose server name contains a space, which `atob` would
 * silently decode into a valid-looking signature.
 *
 * Error offsets: the golden fixtures pin the exact text of a rejection, down to the
 * byte offset, and Go's offsets are positions in the original input reached by a
 * left-to-right scan — not something a length check can reproduce. Decoding
 * "5dyaeacGWamtVZy3Ad7Zoqudu-Oq0klgz_Nw7" reports byte 25, the base64url character, not
 * byte 36, where the input runs short.
 */
export function fromBase64(s: string): Uint8Array {
	if (s.length === 0) {
		return new Uint8Array(0);
	}
	// The maximum output is 3 bytes per 4 input characters; the exact length is known
	// only once padding and newlines have been seen.
	const dst = new Uint8Array(Math.ceil(s.length / 4) * 3);
	let n = 0;
	let si = 0;
	while (si < s.length) {
		const q = decodeQuantum(dst, n, s, si);
		si = q.si;
		n += q.n;
		if (q.err !== undefined) {
			throw q.err;
		}
	}
	return dst.subarray(0, n);
}

/** decodeQuantum decodes one 4-character group, mirroring Go's `Encoding.decodeQuantum`. */
function decodeQuantum(dst: Uint8Array, di: number, src: string, si0: number): { si: number; n: number; err?: Error } {
	// Decode quantum using the base64 alphabet
	const dbuf = new Uint8Array(4);
	let dlen = 4;
	let si = si0;
	let err: Error | undefined;

	for (let j = 0; j < 4; j++) {
		if (src.length === si) {
			if (j === 0) {
				return { si, n: 0 };
			}
			// StdEncoding always pads, so a short final quantum is always an error.
			return { si, n: 0, err: corruptInputError(si - j) };
		}
		const inCh = src.charCodeAt(si);
		si++;

		const out = BASE64_STD_DECODE_MAP[inCh];
		if (out !== undefined && out !== 0xff) {
			dbuf[j] = out;
			continue;
		}

		if (inCh === LF || inCh === CR) {
			j--;
			continue;
		}

		if (inCh !== PAD_CHAR) {
			return { si, n: 0, err: corruptInputError(si - 1) };
		}

		// We've reached the end and there's padding
		if (j === 0 || j === 1) {
			// incorrect padding
			return { si, n: 0, err: corruptInputError(si - 1) };
		}
		if (j === 2) {
			// "==" is expected, the first "=" is already consumed.
			// skip over newlines
			while (si < src.length && (src.charCodeAt(si) === LF || src.charCodeAt(si) === CR)) {
				si++;
			}
			if (si === src.length) {
				// not enough padding
				return { si, n: 0, err: corruptInputError(src.length) };
			}
			if (src.charCodeAt(si) !== PAD_CHAR) {
				// incorrect padding
				return { si, n: 0, err: corruptInputError(si - 1) };
			}
			si++;
		}

		// skip over newlines
		while (si < src.length && (src.charCodeAt(si) === LF || src.charCodeAt(si) === CR)) {
			si++;
		}
		if (si < src.length) {
			// trailing garbage
			err = corruptInputError(si);
		}
		dlen = j;
		break;
	}

	// Convert 4x 6bit source bytes into 3 bytes
	const val = ((dbuf[0] ?? 0) << 18) | ((dbuf[1] ?? 0) << 12) | ((dbuf[2] ?? 0) << 6) | (dbuf[3] ?? 0);
	if (dlen === 4) {
		dst[di + 2] = val & 0xff;
	}
	if (dlen >= 3) {
		dst[di + 1] = (val >>> 8) & 0xff;
	}
	if (dlen >= 2) {
		dst[di] = (val >>> 16) & 0xff;
	}

	return { si, n: dlen - 1, ...(err !== undefined ? { err } : {}) };
}
