// Copyright 2023 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from github.com/transparency-dev/formats/note/note_cosigv1.go
// @ v0.0.0-20251017110053-404c0d5b696c
//
// Licence note: upstream carries the Go Authors' BSD-style notice above on this file even
// though the rest of transparency-dev/formats is Apache-2.0, and the file does reproduce
// code from golang.org/x/mod/sumdb/note (`isValidName`, and the key-hash computation in
// `keyHashEd25519`). The notice is kept as upstream has it; do not replace it with the
// Apache header.
//
// Port note: this is a narrow port of `formats/note`, covering the functions this port
// calls: `NewVerifierForCosignatureV1` and `NewSignerForCosignatureV1` (`src/witness.ts`'s
// `newWitness` and its tests), plus `VKeyToCosignatureV1` and `CoSigV1Timestamp`, which the
// witness server (`src/witness/`) uses to publish its key and to keep its cosignature
// timestamps monotonic. The private machinery they need (`formatCosignatureV1`,
// `verifyCosigV1`, `keyHashEd25519`, `isValidName`, the `Signer`/`verifier` structs) comes
// with them. NOT ported, because nothing in this port calls them: the whole of
// `note_verifier.go` (`NewVerifier`'s algorithm-dispatching, ECDSA, RFC6962 STH verifiers)
// and `note_rfc6962.go`. See docs/decisions/0071-formats-note-cosigv1-partial-port.md and
// docs/decisions/0174-formats-note-cosigv1-timestamp-and-vkey-conversion.md.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
	appendUint64BE,
	concatBytes,
	fromBase64,
	readUint32BE,
	readUint64BE,
	toBase64,
	toUTF8,
} from "../../../internal/gostd/bytes.ts";
import { SentinelError } from "../../../internal/gostd/errors.ts";
import { parseUint } from "../../../internal/gostd/strconv.ts";
import { cut } from "../../../internal/gostd/strings.ts";
import { isSpace, validUTF8String } from "../../../internal/gostd/unicode.ts";
import {
	checkEd25519PublicKey,
	type Signature as NoteSignature,
	type Signer as NoteSigner,
	type Verifier as NoteVerifier,
	verifyEd25519,
} from "../../note/note.ts";

const algEd25519 = 1;
const algEd25519CosignatureV1 = 4;

const keyHashSize = 4;
const timestampSize = 8;
const ed25519SignatureSize = 64;
const ed25519SeedSize = 32;

/**
 * newSignerForCosignatureV1 constructs a new Signer that produces timestamped
 * cosignature/v1 signatures from a standard Ed25519 encoded signer key.
 *
 * (The returned Signer has a different key hash from a non-timestamped one,
 * meaning it will differ from the key hash in the input encoding.)
 */
export function newSignerForCosignatureV1(skey: string): Signer {
	const [priv1, afterPriv1] = cut(skey, "+");
	const [priv2, afterPriv2] = cut(afterPriv1, "+");
	const [name, afterName] = cut(afterPriv2, "+");
	const [hash16, key64] = cut(afterName, "+");
	const key = tryFromBase64(key64);
	if (
		priv1 !== "PRIVATE" ||
		priv2 !== "KEY" ||
		hash16.length !== 8 ||
		key === undefined ||
		!isValidName(name) ||
		key.length === 0
	) {
		throw errSignerID;
	}

	const alg = key[0];
	const seed = key.subarray(1);
	switch (alg) {
		default:
			throw errSignerAlg;

		case algEd25519: {
			if (seed.length !== ed25519SeedSize) {
				throw errSignerID;
			}
			// Port note: Go stores an Ed25519 private key as seed||public and passes all
			// 64 bytes to Sign. @noble/curves takes the 32-byte seed directly and derives
			// the same public key, matching src/vendor/note/note.ts's newSigner.
			const pub = ed25519.getPublicKey(seed);
			const pubkey = concatBytes(new Uint8Array([algEd25519CosignatureV1]), pub);
			const hash = keyHashEd25519(name, pubkey);
			const verifyFn = verifyCosigV1(pubkey.subarray(1));
			const signFn = (msg: Uint8Array): Uint8Array => {
				const t = BigInt(Math.floor(Date.now() / 1000));
				// formatCosignatureV1 throws on a malformed msg; Go's Sign returns that
				// error unwrapped, so it is let to propagate here too, per
				// src/vendor/note/note.ts's Signer.sign doc comment.
				const m = formatCosignatureV1(t, msg);

				// The signature itself is encoded as timestamp || signature.
				const tsBytes = appendUint64BE(new Uint8Array(0), t);
				const sig = ed25519.sign(m, seed);
				return concatBytes(tsBytes, sig);
			};
			return new Signer(name, hash, signFn, verifyFn);
		}
	}
}

/**
 * newVerifierForCosignatureV1 constructs a new Verifier for timestamped
 * cosignature/v1 signatures from either a standard Ed25519 encoded verifier key, or an Ed25519 CosignatureV1 key.
 *
 * (In the case of passing a standard Ed25519 key, the returned Verifier has a different key hash from a non-timestamped one,
 * meaning it will differ from the key hash in the input encoding.)
 */
export function newVerifierForCosignatureV1(vkey: string): NoteVerifier {
	const [name, afterName] = cut(vkey, "+");
	const [hash16, key64] = cut(afterName, "+");
	const key = tryFromBase64(key64);
	if (hash16.length !== 8 || key === undefined || !isValidName(name) || key.length === 0) {
		throw errVerifierID;
	}

	const alg = key[0];
	const keyData = key.subarray(1);
	switch (alg) {
		default:
			throw errVerifierAlg;

		case algEd25519:
		case algEd25519CosignatureV1: {
			if (keyData.length !== 32) {
				throw errVerifierID;
			}
			// Port note: Go accepts any 32 bytes here. Like src/vendor/note/note.ts's
			// newVerifier, the port refuses a small-order or non-canonically encoded public key
			// rather than build a verifier for it: a small-order key verifies signatures nobody
			// made, which for a witness key would let anyone forge its cosignatures. See
			// docs/decisions/0174-formats-note-cosigv1-timestamp-and-vkey-conversion.md.
			checkEd25519PublicKey(keyData);
			const hash = keyHashEd25519(name, concatBytes(new Uint8Array([algEd25519CosignatureV1]), keyData));
			return new verifier(name, hash, verifyCosigV1(keyData));
		}
	}
}

/** vKeyToCosignatureV1 converts a standard Ed25519 vkey to an Ed25519CosignatureV1 vkey. */
export function vKeyToCosignatureV1(vkey: string): string {
	const [name, afterName] = cut(vkey, "+");
	const [hash16, key64] = cut(afterName, "+");
	const algKey = tryFromBase64(key64);
	if (hash16.length !== 8 || algKey === undefined || !isValidName(name) || algKey.length === 0) {
		throw errVerifierID;
	}

	const alg = algKey[0];
	const key = algKey.subarray(1);
	if (alg !== algEd25519) {
		throw errVerifierAlg;
	}
	let hash: number;
	try {
		// Port note: the value is a uint32, which a double holds exactly.
		hash = Number(parseUint(hash16, 16, 32));
	} catch {
		throw errInvalidHash;
	}

	if (hash !== keyHashEd25519(name, algKey)) {
		throw errInvalidHash;
	}
	if (key.length !== 32) {
		throw errVerifierID;
	}
	const pubKey = concatBytes(new Uint8Array([algEd25519CosignatureV1]), key);
	const h = keyHashEd25519(name, pubKey);

	return `${name}+${h.toString(16).padStart(8, "0")}+${toBase64(pubKey)}`;
}

/**
 * coSigV1Timestamp extracts the embedded timestamp from a CoSigV1 signature.
 *
 * Port note: Go returns `(time.Time, error)`, building the time with
 * `time.Unix(int64(binary.BigEndian.Uint64(r)), 0)` and returning `time.UnixMilli(0)` alongside
 * every error. This returns the int64 Go hands to time.Unix, as a bigint number of seconds
 * since the Unix epoch, and throws the error instead. A JavaScript `Date` cannot stand in for
 * time.Time here: it is limited to ±8.64e15 milliseconds (about year 275760), while Go accepts
 * any int64, so a Date would turn large timestamps into an Invalid Date that compares false
 * with everything. The int64 conversion is kept: a timestamp of 2^63 or more reads as
 * negative, exactly as in Go, and callers decide what an out-of-range value means to them.
 */
export function coSigV1Timestamp(s: NoteSignature): bigint {
	const r = tryFromBase64(s.base64);
	if (r === undefined) {
		throw errMalformedSig;
	}
	if (r.length !== keyHashSize + timestampSize + ed25519SignatureSize) {
		throw errVerifierAlg;
	}
	// Skip the hash
	// Next 8 bytes are the timestamp as Unix seconds-since-epoch:
	return BigInt.asIntN(64, readUint64BE(r, keyHashSize));
}

/** verifyCosigV1 returns a verify function based on key. */
function verifyCosigV1(key: Uint8Array): (msg: Uint8Array, sig: Uint8Array) => boolean {
	return (msg: Uint8Array, sig: Uint8Array): boolean => {
		if (sig.length !== timestampSize + ed25519SignatureSize) {
			return false;
		}
		const t = readUint64BE(sig, 0);
		const rawSig = sig.subarray(timestampSize);
		let m: Uint8Array;
		try {
			m = formatCosignatureV1(t, msg);
		} catch {
			return false;
		}
		return verifyEd25519(key, m, rawSig);
	};
}

/**
 * formatCosignatureV1 formats the message signed by a cosignature/v1 witness.
 *
 * The signed message is in the following format
 *
 *      cosignature/v1
 *      time TTTTTTTTTT
 *      origin line
 *      NNNNNNNNN
 *      tree hash
 *      ...
 *
 * where TTTTTTTTTT is the current UNIX timestamp, and the following
 * lines are the lines of the note.
 *
 * While the witness signs all lines of the note, it's important to
 * understand that the witness is asserting observation of correct
 * append-only operation of the log based on the first three lines;
 * no semantic statement is made about any extra "extension" lines.
 */
function formatCosignatureV1(t: bigint, msg: Uint8Array): Uint8Array {
	// Port note: Go checks `len(bytes.Split(msg, []byte("\n"))) < 3`. Splitting into n
	// pieces needs n-1 separators, so counting newlines, and stopping at the second,
	// accepts exactly the same messages without materialising the pieces; this runs for
	// every signature a cosignature/v1 verifier is asked about.
	let newlines = 0;
	for (let i = 0; i < msg.length && newlines < 2; i++) {
		if (msg[i] === 0x0a) {
			newlines++;
		}
	}
	if (newlines < 2) {
		throw new Error("cosigned note format invalid");
	}
	return concatBytes(toUTF8(`cosignature/v1\ntime ${t}\n`), msg);
}

const errSignerID = new SentinelError("malformed signer id");
const errSignerAlg = new SentinelError("unknown signer algorithm");
const errVerifierID = new SentinelError("malformed verifier id");
const errVerifierAlg = new SentinelError("unknown verifier algorithm");
const errInvalidHash = new SentinelError("invalid key hash");
const errMalformedSig = new SentinelError("malformed signature");

export class Signer implements NoteSigner {
	readonly #n: string;
	readonly #h: number;
	readonly #signFn: (msg: Uint8Array) => Uint8Array;
	readonly #verifyFn: (msg: Uint8Array, sig: Uint8Array) => boolean;

	/** @internal Stands in for Go's `&Signer{...}` composite literal; construct via newSignerForCosignatureV1. */
	constructor(
		n: string,
		h: number,
		signFn: (msg: Uint8Array) => Uint8Array,
		verifyFn: (msg: Uint8Array, sig: Uint8Array) => boolean,
	) {
		this.#n = n;
		this.#h = h;
		this.#signFn = signFn;
		this.#verifyFn = verifyFn;
	}

	name(): string {
		return this.#n;
	}
	keyHash(): number {
		return this.#h;
	}
	sign(msg: Uint8Array): Uint8Array {
		return this.#signFn(msg);
	}

	verifier(): NoteVerifier {
		return new verifier(this.#n, this.#h, this.#verifyFn);
	}
}

/** verifier is a note-compatible verifier. */
class verifier implements NoteVerifier {
	private readonly n: string;
	private readonly h: number;
	private readonly v: (msg: Uint8Array, sig: Uint8Array) => boolean;

	constructor(n: string, h: number, v: (msg: Uint8Array, sig: Uint8Array) => boolean) {
		this.n = n;
		this.h = h;
		this.v = v;
	}

	name(): string {
		return this.n;
	}
	keyHash(): number {
		return this.h;
	}
	verify(msg: Uint8Array, sig: Uint8Array): boolean {
		return this.v(msg, sig);
	}
}

/**
 * isValidName reports whether name is valid.
 * It must be non-empty and not have any Unicode spaces or pluses.
 *
 * Port note: `golang.org/x/mod/sumdb/note` (src/vendor/note/note.ts) defines the exact
 * same function privately, and Go's own `formats/note` package duplicates it too rather
 * than importing `sumdb/note`'s unexported copy — this port mirrors that duplication.
 */
function isValidName(name: string): boolean {
	if (name === "" || !validUTF8String(name)) {
		return false;
	}
	for (const ch of name) {
		const r = ch.codePointAt(0);
		if (r !== undefined && isSpace(r)) {
			return false;
		}
	}
	return !name.includes("+");
}

/** keyHashEd25519 computes the key hash for the given server name and encoded public key. */
function keyHashEd25519(name: string, key: Uint8Array): number {
	const h = sha256.create();
	h.update(toUTF8(name));
	h.update(toUTF8("\n"));
	h.update(key);
	return readUint32BE(h.digest(), 0);
}

/** tryFromBase64 decodes standard base64, reporting undefined on failure. */
function tryFromBase64(s: string): Uint8Array | undefined {
	try {
		return fromBase64(s);
	} catch {
		return undefined;
	}
}
