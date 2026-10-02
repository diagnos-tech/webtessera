// Copyright 2019 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from golang.org/x/mod/sumdb/note/note.go @ v0.31.0

// Package note defines the notes signed by the Go module database server.
//
// A note is text signed by one or more server keys.
// The text should be ignored unless the note is signed by
// a trusted server key and the signature has been verified
// using the server's public key.
//
// A server's public key is identified by a name, typically the "host[/path]"
// giving the base URL of the server's transparency log.
// The syntactic restrictions on a name are that it be non-empty,
// well-formed UTF-8 containing neither Unicode spaces nor plus (U+002B).
//
// A Go module database server signs texts using public key cryptography.
// A given server may have multiple public keys, each
// identified by a 32-bit hash of the public key.
//
// # Verifying Notes
//
// A {@link Verifier} allows verification of signatures by one server public key.
// It can report the name of the server and the uint32 hash of the key,
// and it can verify a purported signature by that key.
//
// The standard implementation of a Verifier is constructed
// by {@link newVerifier} starting from a verifier key, which is a
// plain text string of the form "<name>+<hash>+<keydata>".
//
// A {@link Verifiers} allows looking up a Verifier by the combination
// of server name and key hash.
//
// The standard implementation of a Verifiers is constructed
// by verifierList from a list of known verifiers.
//
// A {@link Note} represents a text with one or more signatures.
// An implementation can reject a note with too many signatures
// (for example, more than 100 signatures).
//
// A {@link Signature} represents a signature on a note, verified or not.
//
// The {@link open} function takes as input a signed message
// and a set of known verifiers. It decodes and verifies
// the message signatures and returns a {@link Note} structure
// containing the message text and (verified or unverified) signatures.
//
// # Signing Notes
//
// A {@link Signer} allows signing a text with a given key.
// It can report the name of the server and the hash of the key
// and can sign a raw text using that key.
//
// The standard implementation of a Signer is constructed
// by {@link newSigner} starting from an encoded signer key, which is a
// plain text string of the form "PRIVATE+KEY+<name>+<hash>+<keydata>".
// Anyone with an encoded signer key can sign messages using that key,
// so it must be kept secret. The encoding begins with the literal text
// "PRIVATE+KEY" to avoid confusion with the public server key.
//
// The {@link sign} function takes as input a Note and a list of Signers
// and returns an encoded, signed message.
//
// # Signed Note Format
//
// A signed note consists of a text ending in newline (U+000A),
// followed by a blank line (only a newline),
// followed by one or more signature lines of this form:
// em dash (U+2014), space (U+0020),
// server name, space, base64-encoded signature, newline.
//
// Signed notes must be valid UTF-8 and must not contain any
// ASCII control characters (those below U+0020) other than newline.
//
// A signature is a base64 encoding of 4+n bytes.
//
// The first four bytes in the signature are the uint32 key hash
// stored in big-endian order.
//
// The remaining n bytes are the result of using the specified key
// to sign the note text (including the final newline but not the
// separating blank line).
//
// # Generating Keys
//
// There is only one key type, Ed25519 with algorithm identifier 1.
// New key types may be introduced in the future as needed,
// although doing so will require deploying the new algorithms to all clients
// before starting to depend on them for signatures.
//
// The {@link generateKey} function generates and returns a new signer
// and corresponding verifier.
//
// # Example
//
// Here is a well-formed signed note:
//
//	If you think cryptography is the answer to your problem,
//	then you don't know what your problem is.
//
//	— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=
//
// It can be constructed and displayed using:
//
//	const skey = "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
//	const text = "If you think cryptography is the answer to your problem,\n" +
//		"then you don't know what your problem is.\n";
//
//	const signer = newSigner(skey);
//	const msg = sign({ text }, signer);
//
// The note's text is two lines, including the final newline,
// and the text is purportedly signed by a server named
// "PeterNeumann". (Although server names are canonically
// base URLs, the only syntactic requirement is that they
// not contain spaces or newlines).
//
// If {@link open} is given access to a {@link Verifiers} including the
// {@link Verifier} for this key, then it will succeed at verifying
// the encoded message and returning the parsed {@link Note}.
//
// You can add your own signature to this message by re-signing the note.
// This will print a doubly-signed message, like:
//
//	If you think cryptography is the answer to your problem,
//	then you don't know what your problem is.
//
//	— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=
//	— EnochRoot rwz+eBzmZa0SO3NbfRGzPCpDckykFXSdeX+MNtCOXm2/5n2tiOHp+vAF1aGrQ5ovTG01oOTGwnWLox33WWd1RvMc+QQ=

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import {
	appendUint32BE,
	concatBytes,
	fromBase64,
	fromUTF8,
	hasPrefix,
	indexByte,
	lastIndex,
	readUint32BE,
	toBase64,
	toUTF8,
} from "../../internal/gostd/bytes.ts";
import { SentinelError } from "../../internal/gostd/errors.ts";
import { type Reader, readFull } from "../../internal/gostd/io.ts";
import { parseUint } from "../../internal/gostd/strconv.ts";
import { cut } from "../../internal/gostd/strings.ts";
import { isSpace, validUTF8, validUTF8String } from "../../internal/gostd/unicode.ts";

/** A Verifier verifies messages signed with a specific key. */
export interface Verifier {
	/** name returns the server name associated with the key. */
	name(): string;

	/** keyHash returns the key hash. */
	keyHash(): number;

	/** verify reports whether sig is a valid signature of msg. */
	verify(msg: Uint8Array, sig: Uint8Array): boolean;
}

/** A Signer signs messages using a specific key. */
export interface Signer {
	/** name returns the server name associated with the key. */
	name(): string;

	/** keyHash returns the key hash. */
	keyHash(): number;

	/**
	 * sign returns a signature for the given message.
	 *
	 * Port note: Go's Sign returns `([]byte, error)`; this throws instead, and
	 * {@link sign} lets the error escape unchanged, as Go's Sign returns it unwrapped.
	 */
	sign(msg: Uint8Array): Uint8Array;
}

/** keyHash computes the key hash for the given server name and encoded public key. */
function keyHash(name: string, key: Uint8Array): number {
	const h = sha256.create();
	h.update(toUTF8(name));
	h.update(toUTF8("\n"));
	h.update(key);
	const sum = h.digest();
	return readUint32BE(sum, 0);
}

// Port note: these sentinels are unexported in Go, where the package's own tests can
// still reach them. A TypeScript test file is a separate module and cannot, so they
// are exported and marked `@internal`, following ADR-0010.
// See docs/decisions/0021-note-error-model.md.

/**
 * errVerifierID reports a verifier key that is not well-formed.
 * @internal
 */
export const errVerifierID = new SentinelError("malformed verifier id");
/**
 * errVerifierAlg reports a verifier key naming an algorithm this package cannot use.
 * @internal
 */
export const errVerifierAlg = new SentinelError("unknown verifier algorithm");
/**
 * errVerifierHash reports a verifier key whose stated hash is not the key's hash.
 * @internal
 */
export const errVerifierHash = new SentinelError("invalid verifier hash");

const algEd25519 = 1;

/**
 * ED25519_ORDER is L, the order of the Ed25519 prime-order subgroup
 * (2^252 + 27742317777372353535851937790883648493).
 */
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

/** leBytesToScalar reads a little-endian byte slice as a bigint, as Ed25519 encodes scalars. */
function leBytesToScalar(b: Uint8Array): bigint {
	let n = 0n;
	for (let i = b.length - 1; i >= 0; i--) {
		n = (n << 8n) | BigInt(b[i] as number);
	}
	return n;
}

/**
 * verifyEd25519 verifies an Ed25519 signature exactly as Go's crypto/ed25519.Verify
 * does — the implementation sumdb/note is written against — returning false rather than
 * throwing, which is what Go's Verify does for a malformed signature or a public key
 * that is not a curve point. Upstream's TestOpen depends on a 67-byte signature
 * producing an InvalidSignatureError rather than an exception.
 *
 * Two ways @noble/curves' default verification differs from Go's, each of which would
 * let a webtessera client and a Go witness reach different verdicts on the same
 * checkpoint — the split-view attack a transparency log exists to prevent:
 *
 *   - zip215. noble defaults to ZIP215 point decoding, which accepts non-canonical
 *     encodings and small-order public keys. `zip215: false` selects Go's RFC 8032 /
 *     FIPS 186-5 canonicality: canonical R and A, a scalar S < L, and no small-order A.
 *
 *   - cofactor. noble's verify checks the *cofactored* group equation
 *     [8](R + [k]A - [S]B) = O in *both* zip215 modes, so it also accepts any signature
 *     whose verification residual is a non-zero point of small order. Such signatures
 *     exist for mixed-order public keys, and Go rejects them because it is
 *     *cofactorless*: it recomputes R' = [S]B - [k]A and requires R == R' exactly.
 *     `zip215: false` does not change this, so after noble's canonicality gate the
 *     residual is recomputed here and required to be the identity, matching Go.
 *
 * See docs/decisions/0025-ed25519-rfc8032-not-zip215.md.
 *
 * @internal Exported so `src/vendor/formats/note/note_cosigv1.ts` can reuse the same
 * RFC 8032 / cofactorless verification `formats/note`'s own `verifyCosigV1` calls via
 * Go's `crypto/ed25519.Verify` — the same underlying Go function `sumdb/note` uses, so
 * this is the one place both ported packages' signature checks must agree bit-for-bit.
 * Not re-exported from any barrel; `note.ts` itself is package.json's `./note` entry
 * point (there is no separate barrel to filter through), so this stays documented as
 * internal rather than hidden, following the precedent already set by `errVerifierID`
 * and friends a few lines below.
 */
export function verifyEd25519(pubkey: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
	// Canonicality gate: RFC 8032 point decoding, S < L and small-order-A rejection, as
	// well as the 64-byte length check. noble throws on a bad length or a non-point key;
	// the catch turns that into false, as Go's Verify returns false for both.
	let canonical: boolean;
	try {
		canonical = ed25519.verify(sig, msg, pubkey, { zip215: false });
	} catch {
		return false;
	}
	if (!canonical) {
		return false;
	}
	// Cofactorless confirmation: require the residual R + [k]A - [S]B to be exactly O,
	// not merely small-order. This re-decodes points the gate already validated.
	try {
		const r = sig.subarray(0, 32);
		const s = leBytesToScalar(sig.subarray(32, 64));
		if (s >= ED25519_ORDER) {
			// S must be canonical (0 <= S < L), as Go's SetCanonicalBytes requires.
			return false;
		}
		const A = ed25519.Point.fromBytes(pubkey, false);
		const R = ed25519.Point.fromBytes(r, false);
		const k = leBytesToScalar(sha512(concatBytes(r, pubkey, msg))) % ED25519_ORDER;
		const residual = R.add(A.multiplyUnsafe(k)).subtract(ed25519.Point.BASE.multiplyUnsafe(s));
		return residual.is0();
	} catch {
		return false;
	}
}

/**
 * isValidName reports whether name is valid.
 * It must be non-empty and not have any Unicode spaces or pluses.
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

/** newVerifier construct a new {@link Verifier} from an encoded verifier key. */
export function newVerifier(vkey: string): Verifier {
	const [name, afterName] = cut(vkey, "+");
	const [hash16, key64] = cut(afterName, "+");
	const hash = tryParseKeyHash(hash16);
	const key = tryFromBase64(key64);
	if (hash16.length !== 8 || hash === undefined || key === undefined || !isValidName(name) || key.length === 0) {
		throw errVerifierID;
	}
	if (hash !== keyHash(name, key)) {
		throw errVerifierHash;
	}

	const alg = key[0];
	const keyData = key.subarray(1);
	switch (alg) {
		default:
			throw errVerifierAlg;

		case algEd25519:
			if (keyData.length !== 32) {
				throw errVerifierID;
			}
			// Port note: verification matches Go's crypto/ed25519.Verify (RFC 8032 /
			// FIPS 186-5, cofactorless), not @noble/curves' ZIP215-and-cofactored
			// default. See verifyEd25519 and docs/decisions/0025-ed25519-rfc8032-not-zip215.md.
			return new verifier(name, hash, (msg: Uint8Array, sig: Uint8Array): boolean => verifyEd25519(keyData, msg, sig));
	}
}

/**
 * tryParseKeyHash is `strconv.ParseUint(hash16, 16, 32)`, reporting undefined on failure.
 *
 * Port note: Go folds `err1` into the combined validity check at the call site, so the
 * failure has to become a value rather than a throw. The caller checks the length
 * separately, exactly as upstream does. The result is narrowed to `number` because a
 * key hash is uint32, which is exact as a double.
 */
function tryParseKeyHash(hash16: string): number | undefined {
	try {
		return Number(parseUint(hash16, 16, 32));
	} catch {
		return undefined;
	}
}

/** tryFromBase64 decodes standard base64, reporting undefined on failure. */
function tryFromBase64(s: string): Uint8Array | undefined {
	try {
		return fromBase64(s);
	} catch {
		return undefined;
	}
}

/** verifier is a trivial Verifier implementation. */
class verifier implements Verifier {
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

/** newSigner constructs a new {@link Signer} from an encoded signer key. */
export function newSigner(skey: string): Signer {
	const [priv1, afterPriv1] = cut(skey, "+");
	const [priv2, afterPriv2] = cut(afterPriv1, "+");
	const [name, afterName] = cut(afterPriv2, "+");
	const [hash16, key64] = cut(afterName, "+");
	const hash = tryParseKeyHash(hash16);
	const key = tryFromBase64(key64);
	if (
		priv1 !== "PRIVATE" ||
		priv2 !== "KEY" ||
		hash16.length !== 8 ||
		hash === undefined ||
		key === undefined ||
		!isValidName(name) ||
		key.length === 0
	) {
		throw errSignerID;
	}

	// Note: hash is the hash of the public key and we have the private key.
	// Must verify hash after deriving public key.

	let pubkey: Uint8Array;
	let signFn: (msg: Uint8Array) => Uint8Array;

	const alg = key[0];
	const seed = key.subarray(1);
	switch (alg) {
		default:
			throw errSignerAlg;

		case algEd25519: {
			if (seed.length !== 32) {
				throw errSignerID;
			}
			// Port note: Go stores an Ed25519 private key as seed||public and passes
			// all 64 bytes to Sign. @noble/curves takes the 32-byte seed directly and
			// derives the same public key, so `key = ed25519.NewKeyFromSeed(key)` here
			// is the derivation of the public half.
			const pub = ed25519.getPublicKey(seed);
			pubkey = concatBytes(new Uint8Array([algEd25519]), pub);
			signFn = (msg: Uint8Array): Uint8Array => ed25519.sign(msg, seed);
			break;
		}
	}

	if (hash !== keyHash(name, pubkey)) {
		throw errSignerHash;
	}

	return new signer(name, hash, signFn);
}

/**
 * errSignerID reports a signer key that is not well-formed.
 * @internal
 */
export const errSignerID = new SentinelError("malformed verifier id");
/**
 * errSignerAlg reports a signer key naming an algorithm this package cannot use.
 * @internal
 */
export const errSignerAlg = new SentinelError("unknown verifier algorithm");
/**
 * errSignerHash reports a signer key whose stated hash is not the public key's hash.
 * @internal
 */
export const errSignerHash = new SentinelError("invalid verifier hash");

/** signer is a trivial Signer implementation. */
class signer implements Signer {
	private readonly n: string;
	private readonly h: number;
	private readonly s: (msg: Uint8Array) => Uint8Array;

	constructor(n: string, h: number, s: (msg: Uint8Array) => Uint8Array) {
		this.n = n;
		this.h = h;
		this.s = s;
	}

	name(): string {
		return this.n;
	}
	keyHash(): number {
		return this.h;
	}
	sign(msg: Uint8Array): Uint8Array {
		return this.s(msg);
	}
}

/**
 * generateKey generates a signer and verifier key pair for a named server.
 * The signer key skey is private and must be kept secret.
 *
 * Port note: Go returns `(skey, vkey string, err error)`. TypeScript has no multiple
 * return, so the two keys come back in an object and the error is thrown. `rand` is
 * `undefined` where Go passes a nil io.Reader, which both languages take to mean "use
 * the platform CSPRNG".
 */
export function generateKey(rand: Reader | undefined, name: string): { skey: string; vkey: string } {
	let seed: Uint8Array;
	if (rand === undefined) {
		seed = ed25519.utils.randomSecretKey();
	} else {
		seed = new Uint8Array(32);
		readFull(rand, seed);
	}
	const pub = ed25519.getPublicKey(seed);
	const pubkey = concatBytes(new Uint8Array([algEd25519]), pub);
	const privkey = concatBytes(new Uint8Array([algEd25519]), seed);
	const h = keyHash(name, pubkey);

	const skey = `PRIVATE+KEY+${name}+${hex8(h)}+${toBase64(privkey)}`;
	const vkey = `${name}+${hex8(h)}+${toBase64(pubkey)}`;
	return { skey, vkey };
}

/**
 * newEd25519VerifierKey returns an encoded verifier key using the given name
 * and Ed25519 public key.
 */
export function newEd25519VerifierKey(name: string, key: Uint8Array): string {
	if (key.length !== 32) {
		throw new Error(`invalid public key size ${key.length}, expected 32`);
	}

	const pubkey = concatBytes(new Uint8Array([algEd25519]), key);
	const hash = keyHash(name, pubkey);

	const b64Key = toBase64(pubkey);
	return `${name}+${hex8(hash)}+${b64Key}`;
}

/** hex8 renders a uint32 the way Go's `%08x` verb does. */
function hex8(v: number): string {
	return v.toString(16).padStart(8, "0");
}

/** A Verifiers is a collection of known verifier keys. */
export interface Verifiers {
	/**
	 * verifier returns the Verifier associated with the key
	 * identified by the name and hash.
	 * If the name, hash pair is unknown, verifier should throw
	 * an {@link UnknownVerifierError}.
	 */
	verifier(name: string, hash: number): Verifier;
}

/**
 * An UnknownVerifierError indicates that the given key is not known.
 * The {@link open} function records signatures without associated verifiers as
 * unverified signatures.
 *
 * Port note: Go's field is `Name`. `Error.prototype.name` already means "the class of
 * this error" in JavaScript, and shadowing it would make `console.error(err)` print
 * the server name where the error type belongs, so the field is `keyName` here.
 * See docs/decisions/0021-note-error-model.md.
 */
export class UnknownVerifierError extends Error {
	readonly keyName: string;
	readonly keyHash: number;

	constructor(keyName: string, keyHash: number) {
		super(`unknown key ${keyName}+${hex8(keyHash)}`);
		this.name = "UnknownVerifierError";
		this.keyName = keyName;
		this.keyHash = keyHash;
	}
}

/**
 * An ambiguousVerifierError indicates that the given name and hash
 * match multiple keys passed to {@link verifierList}.
 * (If this happens, some malicious actor has taken control of the
 * verifier list, at which point we may as well give up entirely,
 * but we diagnose the problem instead.)
 *
 * @internal
 */
export class ambiguousVerifierError extends Error {
	readonly keyName: string;
	readonly hash: number;

	constructor(keyName: string, hash: number) {
		super(`ambiguous key ${keyName}+${hex8(hash)}`);
		this.name = "ambiguousVerifierError";
		this.keyName = keyName;
		this.hash = hash;
	}
}

/** verifierList returns a {@link Verifiers} implementation that uses the given list of verifiers. */
export function verifierList(...list: Verifier[]): Verifiers {
	// Port note: the value type is a non-empty tuple because Go's `m[k] = append(m[k], v)`
	// can only ever produce a non-empty list. Saying so in the type is what lets
	// `verifier` return `v[0]` without a cast under `noUncheckedIndexedAccess`.
	const m = new Map<string, [Verifier, ...Verifier[]]>();
	for (const v of list) {
		const k = nameHash(v.name(), v.keyHash());
		const existing = m.get(k);
		if (existing === undefined) {
			m.set(k, [v]);
		} else {
			existing.push(v);
		}
	}
	return new verifierMap(m);
}

/**
 * nameHash is the port of Go's `nameHash` struct used as a map key.
 *
 * Port note: JavaScript Maps key by identity, so a composite key has to be encoded as
 * a string. The hash is rendered as exactly eight hex digits, so the boundary between
 * the two fields is unambiguous whatever the name contains.
 */
function nameHash(name: string, hash: number): string {
	return hex8(hash) + name;
}

class verifierMap implements Verifiers {
	private readonly m: Map<string, [Verifier, ...Verifier[]]>;

	constructor(m: Map<string, [Verifier, ...Verifier[]]>) {
		this.m = m;
	}

	verifier(name: string, hash: number): Verifier {
		const v = this.m.get(nameHash(name, hash));
		if (v === undefined) {
			throw new UnknownVerifierError(name, hash);
		}
		if (v.length > 1) {
			throw new ambiguousVerifierError(name, hash);
		}
		return v[0];
	}
}

/**
 * A Note is a text and signatures.
 *
 * Port note: Go's `Sigs` and `UnverifiedSigs` are slices, and a note being signed for
 * the first time leaves both nil — `Sign(&Note{Text: text})` is the common case. The
 * two fields are therefore optional here rather than required-and-empty, which is the
 * faithful rendering of a nil slice. {@link open} always populates both.
 */
export interface Note {
	/** text of note */
	text: string;
	/** verified signatures */
	sigs?: Signature[];
	/** unverified signatures */
	unverifiedSigs?: Signature[];
}

/** A Signature is a single signature found in a note. */
export interface Signature {
	/**
	 * name and hash give the name and key hash
	 * for the key that generated the signature.
	 */
	name: string;
	hash: number;

	/** base64 records the base64-encoded signature bytes. */
	base64: string;
}

/**
 * An UnverifiedNoteError indicates that the note
 * successfully parsed but had no verifiable signatures.
 */
export class UnverifiedNoteError extends Error {
	readonly note: Note;

	constructor(note: Note) {
		super("note has no verifiable signatures");
		this.name = "UnverifiedNoteError";
		this.note = note;
	}
}

/**
 * An InvalidSignatureError indicates that the given key was known
 * and the associated Verifier rejected the signature.
 *
 * Port note: Go's field is `Name`; see {@link UnknownVerifierError} for why it is
 * `keyName` here.
 */
export class InvalidSignatureError extends Error {
	readonly keyName: string;
	readonly hash: number;

	constructor(keyName: string, hash: number) {
		super(`invalid signature for key ${keyName}+${hex8(hash)}`);
		this.name = "InvalidSignatureError";
		this.keyName = keyName;
		this.hash = hash;
	}
}

/**
 * errMalformedNote reports a note that does not parse as a signed note.
 * @internal
 */
export const errMalformedNote = new SentinelError("malformed note");
/**
 * errInvalidSigner reports a Signer whose name is not a valid server name.
 * @internal
 */
export const errInvalidSigner = new SentinelError("invalid signer");
/**
 * errMismatchedVerifier reports a Verifiers that answered with the wrong verifier.
 * @internal
 */
export const errMismatchedVerifier = new SentinelError("verifier name or hash doesn't match signature");

const sigSplit = toUTF8("\n\n");
const sigPrefix = toUTF8("— ");

/**
 * open opens and parses the message msg, checking signatures from the known verifiers.
 *
 * For each signature in the message, open calls known.verifier to find a verifier.
 * If known.verifier returns a verifier and the verifier accepts the signature,
 * open records the signature in the returned note's sigs field.
 * If known.verifier returns a verifier but the verifier rejects the signature,
 * open throws an {@link InvalidSignatureError}.
 * If known.verifier throws an {@link UnknownVerifierError},
 * open records the signature in the returned note's unverifiedSigs field.
 * If known.verifier throws any other error, open re-throws that error.
 *
 * If no known verifier has signed an otherwise valid note,
 * open throws an {@link UnverifiedNoteError}.
 * In this case, the unverified note can be fetched from inside the error.
 */
export function open(msg: Uint8Array, known: Verifiers | undefined): Note {
	// Treat nil Verifiers as empty list, to produce useful error instead of crash.
	const kn = known ?? verifierList();

	// Must have valid UTF-8 with no non-newline ASCII control characters.
	//
	// Port note: Go walks the message rune by rune with utf8.DecodeRune and rejects
	// both the replacement rune produced by an invalid byte and any rune below U+0020
	// other than newline. Validating the whole slice and then scanning for control
	// bytes accepts exactly the same messages: in well-formed UTF-8 every byte below
	// 0x80 is a rune of the same value, and every byte of a multi-byte sequence is
	// 0x80 or above, so a byte below 0x20 is a control rune and nothing else.
	if (!validUTF8(msg)) {
		throw errMalformedNote;
	}
	for (const b of msg) {
		if (b < 0x20 && b !== 0x0a) {
			throw errMalformedNote;
		}
	}

	// Must end with signature block preceded by blank line.
	const split = lastIndex(msg, sigSplit);
	if (split < 0) {
		throw errMalformedNote;
	}
	const text = msg.subarray(0, split + 1);
	let sigs = msg.subarray(split + 2);
	if (sigs.length === 0 || sigs[sigs.length - 1] !== 0x0a) {
		throw errMalformedNote;
	}

	const verified: Signature[] = [];
	const unverified: Signature[] = [];
	const n: Note = {
		text: fromUTF8(text),
		sigs: verified,
		unverifiedSigs: unverified,
	};

	// Parse and verify signatures.
	// Ignore duplicate signatures.
	const seen = new Set<string>();
	const seenUnverified = new Set<string>();
	let numSig = 0;
	while (sigs.length > 0) {
		// Pull out next signature line.
		// We know sigs[sigs.length-1] == '\n', so indexByte always finds one.
		const i = indexByte(sigs, 0x0a);
		let line = sigs.subarray(0, i);
		sigs = sigs.subarray(i + 1);

		if (!hasPrefix(line, sigPrefix)) {
			throw errMalformedNote;
		}
		line = line.subarray(sigPrefix.length);
		const lineText = fromUTF8(line);
		const [name, b64] = cut(lineText, " ");
		let sig = tryFromBase64(b64);
		if (sig === undefined || !isValidName(name) || b64 === "" || sig.length < 5) {
			throw errMalformedNote;
		}
		const hash = readUint32BE(sig, 0);
		sig = sig.subarray(4);

		if (++numSig > 100) {
			// Avoid spending forever parsing a note with many signatures.
			throw errMalformedNote;
		}

		let v: Verifier;
		try {
			v = kn.verifier(name, hash);
		} catch (err) {
			if (err instanceof UnknownVerifierError) {
				// Drop repeated identical unverified signatures.
				if (seenUnverified.has(lineText)) {
					continue;
				}
				seenUnverified.add(lineText);
				unverified.push({ name, hash, base64: b64 });
				continue;
			}
			throw err;
		}

		// Check that known.verifier returned the right verifier.
		if (v.name() !== name || v.keyHash() !== hash) {
			throw errMismatchedVerifier;
		}

		// Drop repeated signatures by a single verifier.
		const key = nameHash(name, hash);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const ok = v.verify(text, sig);
		if (!ok) {
			throw new InvalidSignatureError(name, hash);
		}

		verified.push({ name, hash, base64: b64 });
	}

	// Parsed and verified all the signatures.
	if (verified.length === 0) {
		throw new UnverifiedNoteError(n);
	}
	return n;
}

/**
 * sign signs the note with the given signers and returns the encoded message.
 * The new signatures from signers are listed in the encoded message after
 * the existing signatures already present in n.sigs.
 * If any signer uses the same key as an existing signature,
 * the existing signature is elided from the output.
 */
export function sign(n: Note, ...signers: Signer[]): Uint8Array {
	if (!n.text.endsWith("\n")) {
		throw errMalformedNote;
	}
	// Port note: Go accumulates the whole message in one bytes.Buffer, starting with
	// the text. Here the text is encoded once, up front, because the signers have to
	// be handed exactly those bytes; the rest of the message is assembled as a string
	// and encoded at the end. The concatenation is identical either way, and doing it
	// this way makes it impossible to sign anything other than the text.
	const textBytes = toUTF8(n.text);

	// Prepare signatures.
	let sigs = "";
	const have = new Set<string>();
	for (const s of signers) {
		const name = s.name();
		const hash = s.keyHash();
		have.add(nameHash(name, hash));
		if (!isValidName(name)) {
			throw errInvalidSigner;
		}

		const sig = s.sign(textBytes); // textBytes holds n.text

		const hbuf = appendUint32BE(new Uint8Array(0), hash);
		const b64 = toBase64(concatBytes(hbuf, sig));
		sigs += `— ${name} ${b64}\n`;
	}

	let buf = "\n";

	// Emit existing signatures not replaced by new ones.
	for (const list of [n.sigs, n.unverifiedSigs]) {
		for (const sig of list ?? []) {
			const name = sig.name;
			const hash = sig.hash;
			if (!isValidName(name)) {
				throw errMalformedNote;
			}
			if (have.has(nameHash(name, hash))) {
				continue;
			}
			// Double-check hash against base64.
			const raw = tryFromBase64(sig.base64);
			if (raw === undefined || raw.length < 4 || readUint32BE(raw, 0) !== hash) {
				throw errMalformedNote;
			}
			buf += `— ${sig.name} ${sig.base64}\n`;
		}
	}
	buf += sigs;

	return concatBytes(textBytes, toUTF8(buf));
}
