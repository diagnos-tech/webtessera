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

// This file has no upstream counterpart. It is the key custody of the safe API: a log's
// Ed25519 key is held by the platform's WebCrypto API as a non-extractable CryptoKey
// wherever the platform supports Ed25519, and by @noble/curves otherwise, and it signs
// through the note package's AsyncSigner. Key strings and key formats are the ported note
// package's; nothing here parses or encodes a key format of its own. See
// docs/decisions/0222-key-custody.md.

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesEqual, concatBytes, fromBase64, fromHex } from "../internal/gostd/bytes.ts";
import { cut } from "../internal/gostd/strings.ts";
import { isSpace, validUTF8String } from "../internal/gostd/unicode.ts";
import {
	type AsyncSigner,
	generateKey,
	newEd25519VerifierKey,
	newSigner,
	newVerifier,
	type Signer,
	type Verifier,
} from "../vendor/note/note.ts";
import { isSignerKey, quoteInput, WebtesseraError } from "./errors.ts";

/**
 * KeyBackend says what holds a {@link LogKey}'s secret: the platform's WebCrypto API, as a
 * CryptoKey, or @noble/curves, as bytes in JavaScript memory.
 *
 * ```ts
 * if (key.backend === "noble") {
 *   console.warn("this runtime cannot hold a non-extractable Ed25519 key");
 * }
 * ```
 */
export type KeyBackend = "webcrypto" | "noble";

/**
 * LogKey is a log's Ed25519 signing key, held so that its secret cannot leak by accident.
 * It signs checkpoints as a note AsyncSigner, whose name is the log's origin, and carries
 * the public half as a note verifier key (`vkey`) to hand to anyone who verifies the log.
 *
 * A LogKey never exposes its secret: not as a property, not through toString, toJSON or
 * Node's inspect, and not in an error message. A key whose `backend` is "webcrypto" and
 * whose `extractable` is false cannot be exported by anyone, this library included; one
 * whose `extractable` is true could be, by code with access to its CryptoKey, or by
 * reading the process's memory.
 *
 * Create one with generateLogKey; on a server, import one with importLogKey from
 * webtessera/server; in a browser, open a persistent one with openDeviceKey from
 * webtessera/browser.
 *
 * ```ts
 * const key = await generateLogKey("example.com/log");
 * console.log(`${key}`); // LogKey(example.com/log+1a2b3c4d+AQ…, webcrypto, non-extractable)
 * publish(key.vkey);     // what verifiers need
 * ```
 */
export interface LogKey extends AsyncSigner {
	/** origin is the log's checkpoint origin, and the key's note name. */
	readonly origin: string;
	/** vkey is the note verifier key (`<origin>+<hash>+<key>`): publish it. */
	readonly vkey: string;
	/** backend is what holds the secret. */
	readonly backend: KeyBackend;
	/** extractable is whether the secret could be read out of this process at all. */
	readonly extractable: boolean;

	/** name returns the origin, as a note Signer's name does. */
	name(): string;
	/** keyHash returns the note key hash. */
	keyHash(): number;
	/** sign resolves to the Ed25519 signature of msg. */
	sign(msg: Uint8Array): Promise<Uint8Array>;
	/** verifier returns a note Verifier for this key, built from vkey. */
	verifier(): Verifier;
	/** toString describes the key by its vkey and custody, never its secret. */
	toString(): string;
	/** toJSON is what JSON.stringify shows of the key: its public description only. */
	toJSON(): LogKeyInfo;
}

/**
 * LogKeyInfo is the public description of a LogKey, as toJSON returns it.
 *
 * ```ts
 * JSON.stringify(key); // {"origin":"example.com/log","vkey":"example.com/log+…","backend":"webcrypto","extractable":false}
 * ```
 */
export interface LogKeyInfo {
	readonly origin: string;
	readonly vkey: string;
	readonly backend: KeyBackend;
	readonly extractable: boolean;
}

/**
 * GenerateLogKeyOptions configures generateLogKey.
 *
 * ```ts
 * await generateLogKey("example.com/log", { fallback: "error" });
 * ```
 */
export interface GenerateLogKeyOptions {
	/**
	 * fallback chooses what happens where WebCrypto cannot hold an Ed25519 key (an old
	 * browser, a page that is not a secure context): `"noble"`, the default, holds the key
	 * in memory with @noble/curves and reports it as `backend: "noble"`, `extractable:
	 * true`; `"error"` throws instead, for code that must not run without a
	 * non-extractable key.
	 */
	readonly fallback?: "noble" | "error";
	/**
	 * extractable creates the WebCrypto key as extractable, for an application that backs
	 * it up itself. It defaults to false, and nothing in webtessera ever exports a key.
	 */
	readonly extractable?: boolean;
}

// Every LogKey this module made, so that a factory taking a key can refuse anything else,
// and the private half of each WebCrypto-backed one, for persisting it in IndexedDB.
const issued = new WeakSet<LogKey>();
const cryptoKeys = new WeakMap<LogKey, { readonly privateKey: CryptoKey; readonly publicKey: Uint8Array }>();
// Keys that live as long as their log does: loaded from or saved to a device key store,
// or supplied by the application as a CryptoKey it manages itself.
const durable = new WeakSet<LogKey>();

/** logKey implements LogKey. Its secret is reachable only from the sign closure. */
class logKey implements LogKey {
	readonly origin: string;
	readonly vkey: string;
	readonly backend: KeyBackend;
	readonly extractable: boolean;
	readonly #hash: number;
	readonly #verifier: Verifier;
	readonly #sign: (msg: Uint8Array) => Promise<Uint8Array>;

	constructor(
		verifier: Verifier,
		vkey: string,
		backend: KeyBackend,
		extractable: boolean,
		sign: (msg: Uint8Array) => Promise<Uint8Array>,
	) {
		this.origin = verifier.name();
		this.vkey = vkey;
		this.backend = backend;
		this.extractable = extractable;
		this.#hash = verifier.keyHash();
		this.#verifier = verifier;
		this.#sign = sign;
	}

	name(): string {
		return this.origin;
	}

	keyHash(): number {
		return this.#hash;
	}

	sign(msg: Uint8Array): Promise<Uint8Array> {
		return this.#sign(msg);
	}

	verifier(): Verifier {
		return this.#verifier;
	}

	toString(): string {
		return `LogKey(${this.vkey}, ${this.backend}, ${this.extractable ? "extractable" : "non-extractable"})`;
	}

	toJSON(): LogKeyInfo {
		return { origin: this.origin, vkey: this.vkey, backend: this.backend, extractable: this.extractable };
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return this.toString();
	}
}

// RFC 8032, section 7.1, TEST 1: the probe that decides whether WebCrypto's Ed25519 can be
// used checks that it signs exactly as Ed25519 is specified, byte for byte, because the
// log's signatures must be the ones the ported, @noble/curves-based signer would make.
const probeSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const probeSignature =
	"e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

/** pkcs8Prefix is the DER encoding of an Ed25519 PrivateKeyInfo (RFC 8410) up to its 32-byte seed. */
const pkcs8Prefix = fromHex("302e020100300506032b657004220420");

// The probe's verdict for each SubtleCrypto it has examined. A runtime has one, but keying
// by it rather than caching a single answer keeps a test that substitutes the global
// crypto object from seeing a stale verdict.
const probes = new WeakMap<SubtleCrypto, Promise<boolean>>();

/**
 * webCryptoEd25519 resolves to whether this runtime's WebCrypto API (`crypto.subtle`) can
 * hold and use Ed25519 keys, and signs exactly as RFC 8032 specifies. The answer is
 * computed once, by signing RFC 8032's first test vector, and cached.
 *
 * Node.js 22.18 and later, Deno, Bun, workerd and current browsers (Chrome and Edge 137,
 * Firefox 129, Safari 17) support it; browsers expose `crypto.subtle` only in secure
 * contexts (HTTPS and localhost).
 *
 * ```ts
 * if (!(await webCryptoEd25519())) {
 *   console.warn("keys will be held in memory by @noble/curves");
 * }
 * ```
 */
export function webCryptoEd25519(): Promise<boolean> {
	const subtle = subtleCrypto();
	if (subtle === undefined) {
		return Promise.resolve(false);
	}
	let probe = probes.get(subtle);
	if (probe === undefined) {
		probe = probeEd25519(subtle);
		probes.set(subtle, probe);
	}
	return probe;
}

async function probeEd25519(subtle: SubtleCrypto): Promise<boolean> {
	try {
		const seed = fromHex(probeSeed);
		const key = await subtle.importKey("pkcs8", pkcs8(seed), { name: "Ed25519" }, false, ["sign"]);
		const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, key, new Uint8Array(0)));
		return bytesEqual(sig, fromHex(probeSignature));
	} catch {
		return false;
	}
}

/**
 * generateLogKey generates a new Ed25519 key for the log with the given origin: a
 * non-extractable WebCrypto key where the runtime supports one (see webCryptoEd25519),
 * and otherwise, unless `fallback` is `"error"`, a key held in memory by @noble/curves,
 * which reports `backend: "noble"` and `extractable: true`.
 *
 * The key lives as long as the object does. To keep a log's key across restarts, import
 * it from a secret store with importLogKey on a server, or open it with openDeviceKey in a
 * browser, which persists it in IndexedDB.
 *
 * ```ts
 * const key = await generateLogKey("example.com/log");
 * key.backend;     // "webcrypto"
 * key.extractable; // false
 * ```
 */
export async function generateLogKey(origin: string, options: GenerateLogKeyOptions = {}): Promise<LogKey> {
	checkOrigin(origin, "generateLogKey");
	const fallback = checkFallback(options.fallback, "generateLogKey");
	const extractable = options.extractable === true;
	if (await webCryptoEd25519()) {
		const subtle = subtleCrypto() as SubtleCrypto;
		const pair = (await subtle.generateKey({ name: "Ed25519" }, extractable, ["sign", "verify"])) as CryptoKeyPair;
		const publicKey = await exportRawPublicKey(subtle, pair.publicKey);
		return webCryptoKey(origin, pair.privateKey, publicKey);
	}
	if (fallback === "error") {
		throw unsupported("generateLogKey");
	}
	// The key is made exactly as Go's note.GenerateKey makes one, by its port.
	const { skey, vkey } = generateKey(undefined, origin);
	return nobleKey(newSigner(skey), vkey);
}

/**
 * importSignerKey imports a note signer key (`PRIVATE+KEY+<name>+<hash>+<key>`) as a
 * LogKey, into a non-extractable WebCrypto key where the runtime supports one.
 *
 * The key string is checked by the note package's newSigner, exactly as Go's
 * note.NewSigner checks it. The bytes decoded from it are wiped once they have been
 * imported; the string itself is immutable and cannot be, which is why browsers never
 * get this function.
 *
 * @internal Exported to webtessera/server as importLogKey, which checks the runtime first.
 */
export async function importSignerKey(
	skey: string | undefined,
	options: { readonly fallback?: "noble" | "error" } = {},
): Promise<LogKey> {
	if (skey === undefined || skey === "") {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`importLogKey: no key (${skey === undefined ? "undefined" : "an empty string"}); pass the log's signer key, ` +
				"PRIVATE+KEY+<name>+<hash>+<key>, from your secret store. If the environment variable that should hold " +
				"it is not set, create a key pair with `npx webtessera keygen <origin>`",
		);
	}
	if (typeof skey !== "string") {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`importLogKey takes a note signer key string (PRIVATE+KEY+…), got ${typeName(skey)}`,
		);
	}
	const fallback = checkFallback(options.fallback, "importLogKey");
	let signer: Signer;
	try {
		signer = newSigner(skey);
	} catch (err) {
		// The note package's errors are fixed strings ("malformed verifier id", ...) that
		// never quote the key; nothing else from the key may reach this message. A verifier
		// key is public, so saying that is what was passed reveals nothing.
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`importLogKey: not a valid note signer key (${err instanceof Error ? err.message : "unknown error"}); ` +
				(isVerifierKey(skey)
					? "this is a verifier (public) key, the half to publish. importLogKey takes the log's signer key, " +
						"PRIVATE+KEY+<name>+<hash>+<key>, from your secret store"
					: "expected PRIVATE+KEY+<name>+<hash>+<key>, as generateLogKeyPair from webtessera/server produces"),
		);
	}
	const origin = signer.name();
	const seed = seedOf(skey);
	try {
		const publicKey = ed25519.getPublicKey(seed);
		if (await webCryptoEd25519()) {
			const subtle = subtleCrypto() as SubtleCrypto;
			const der = pkcs8(seed);
			let privateKey: CryptoKey;
			try {
				privateKey = await subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
			} finally {
				der.fill(0);
			}
			return webCryptoKey(origin, privateKey, publicKey);
		}
		if (fallback === "error") {
			throw unsupported("importLogKey");
		}
		return nobleKey(signer, newEd25519VerifierKey(origin, publicKey));
	} finally {
		seed.fill(0);
	}
}

/**
 * fromCryptoKeyPair wraps an Ed25519 CryptoKeyPair that the application already holds as
 * the LogKey of the log with the given origin. The private key is used as it is, and its
 * own `extractable` flag is reported; the public key must be extractable, since the vkey
 * is made from its raw bytes.
 *
 * @internal Exported to webtessera/browser as fromCryptoKey.
 */
export async function fromCryptoKeyPair(origin: string, pair: CryptoKeyPair): Promise<LogKey> {
	checkOrigin(origin, "fromCryptoKey");
	const { privateKey, publicKey } = pair ?? {};
	if (!isCryptoKey(privateKey) || !isCryptoKey(publicKey)) {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			"fromCryptoKey takes a CryptoKeyPair, such as crypto.subtle.generateKey returns for Ed25519",
		);
	}
	if (privateKey.algorithm.name !== "Ed25519" || publicKey.algorithm.name !== "Ed25519") {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`fromCryptoKey needs an Ed25519 key pair, got ${quoteInput(privateKey.algorithm.name)}`,
		);
	}
	if (privateKey.type !== "private" || !privateKey.usages.includes("sign")) {
		throw new WebtesseraError("INVALID_ARGUMENT", 'fromCryptoKey needs a private key with the "sign" usage');
	}
	const subtle = subtleCrypto();
	if (subtle === undefined) {
		throw unsupported("fromCryptoKey");
	}
	const raw = await exportRawPublicKey(subtle, publicKey);
	const key = webCryptoKey(origin, privateKey, raw);
	await checkKeyPair(key);
	durable.add(key);
	return key;
}

/**
 * restoreCryptoKey rebuilds a LogKey from a private CryptoKey and the raw public key it was
 * persisted with, after checking that the two belong together.
 *
 * @internal For the device key store in webtessera/browser.
 */
export async function restoreCryptoKey(origin: string, privateKey: CryptoKey, publicKey: Uint8Array): Promise<LogKey> {
	const key = webCryptoKey(origin, privateKey, publicKey);
	await checkKeyPair(key);
	durable.add(key);
	return key;
}

/**
 * cryptoKeyOf returns the private CryptoKey and raw public key of a WebCrypto-backed
 * LogKey, or undefined for any other key.
 *
 * @internal For the device key store in webtessera/browser.
 */
export function cryptoKeyOf(
	key: LogKey,
): { readonly privateKey: CryptoKey; readonly publicKey: Uint8Array } | undefined {
	return cryptoKeys.get(key);
}

/**
 * markDurable records that key now lives as long as a log can: it was saved to a device
 * key store.
 *
 * @internal For the device key store in webtessera/browser.
 */
export function markDurable(key: LogKey): void {
	durable.add(key);
}

/**
 * isDurable reports whether key was loaded from or saved to a device key store, or
 * supplied as a CryptoKey the application manages.
 *
 * @internal For openBrowserLog.
 */
export function isDurable(key: LogKey): boolean {
	return durable.has(key);
}

/**
 * assertLogKey throws a WebtesseraError, saying what to pass instead, unless key is a
 * LogKey made by this module.
 *
 * @internal For the log factories.
 */
export function assertLogKey(key: unknown, where: string): asserts key is LogKey {
	if (typeof key === "string") {
		throw new WebtesseraError(
			isSignerKey(key) ? "SIGNER_KEY_MISUSE" : "INVALID_ARGUMENT",
			`${where}: key must be a LogKey, not a string. On a server, import a signer key string with ` +
				"importLogKey(skey) from webtessera/server; browsers never handle private key strings.",
		);
	}
	if (typeof key !== "object" || key === null || !issued.has(key as LogKey)) {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`${where}: key must be a LogKey made by generateLogKey, importLogKey or openDeviceKey, got ${typeName(key)}`,
		);
	}
}

/**
 * checkOrigin throws, with a message that says how to fix it, unless origin can be a
 * checkpoint origin and a note key name: non-empty, valid UTF-8, without spaces or `+`.
 *
 * @internal For the log factories and the device key store.
 */
export function checkOrigin(origin: unknown, where: string): asserts origin is string {
	if (typeof origin !== "string") {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`${where}: the origin must be a string, such as "example.com/log", got ${typeName(origin)}`,
		);
	}
	if (isSignerKey(origin)) {
		throw new WebtesseraError(
			"SIGNER_KEY_MISUSE",
			`${where}: the first argument is the log's origin (such as "example.com/log"), and this looks like a ` +
				"private signer key. Do not put signer keys in source code or logs.",
		);
	}
	if (origin === "" || !validUTF8String(origin) || origin.includes("+") || [...origin].some(isSpaceChar)) {
		throw new WebtesseraError(
			"INVALID_ARGUMENT",
			`${where}: ${quoteInput(origin)} cannot be a log origin: an origin is a non-empty name without spaces ` +
				'or "+", conventionally the log\'s URL without its scheme, such as "example.com/log"',
		);
	}
}

/** webCryptoKey builds a LogKey around a WebCrypto private key and its raw public key. */
function webCryptoKey(origin: string, privateKey: CryptoKey, publicKey: Uint8Array): LogKey {
	const vkey = newEd25519VerifierKey(origin, publicKey);
	const subtle = subtleCrypto() as SubtleCrypto;
	const key = new logKey(newVerifier(vkey), vkey, "webcrypto", privateKey.extractable, async (msg) => {
		return new Uint8Array(await subtle.sign({ name: "Ed25519" }, privateKey, msg as Uint8Array<ArrayBuffer>));
	});
	issued.add(key);
	cryptoKeys.set(key, { privateKey, publicKey: publicKey.slice() });
	return key;
}

/** nobleKey builds a LogKey around a note Signer made by the ported newSigner, which signs with @noble/curves. */
function nobleKey(signer: Signer, vkey: string): LogKey {
	const key = new logKey(newVerifier(vkey), vkey, "noble", true, async (msg) => signer.sign(msg));
	issued.add(key);
	return key;
}

/** checkKeyPair throws unless key's private half makes signatures its vkey verifies. */
async function checkKeyPair(key: LogKey): Promise<void> {
	const msg = new TextEncoder().encode("webtessera key check\n");
	let ok = false;
	try {
		ok = key.verifier().verify(msg, await key.sign(msg));
	} catch {
		ok = false;
	}
	if (!ok) {
		throw new WebtesseraError("KEY_MISMATCH", `the private and public keys of ${key.origin} do not belong together`);
	}
}

/** seedOf decodes the Ed25519 seed from a signer key that newSigner has already accepted. */
function seedOf(skey: string): Uint8Array {
	// PRIVATE+KEY+<name>+<hash>+<key>: newSigner has checked every field, and the base64 key
	// may itself contain "+", so the first four separators are cut as newSigner cuts them.
	const [, afterPriv1] = cut(skey, "+");
	const [, afterPriv2] = cut(afterPriv1, "+");
	const [, afterName] = cut(afterPriv2, "+");
	const [, key64] = cut(afterName, "+");
	const key = fromBase64(key64);
	const seed = key.slice(1);
	key.fill(0);
	return seed;
}

/** pkcs8 encodes an Ed25519 seed as a PKCS #8 PrivateKeyInfo, the format WebCrypto imports private keys in. */
function pkcs8(seed: Uint8Array): Uint8Array<ArrayBuffer> {
	return concatBytes(pkcs8Prefix, seed) as Uint8Array<ArrayBuffer>;
}

/** exportRawPublicKey exports a public CryptoKey in the raw format, which for Ed25519 is its 32-byte encoding. */
async function exportRawPublicKey(subtle: SubtleCrypto, key: CryptoKey): Promise<Uint8Array> {
	// The Workers runtime types exportKey's result as ArrayBuffer | JsonWebKey for every
	// format; the raw format always produces an ArrayBuffer.
	return new Uint8Array((await subtle.exportKey("raw", key)) as ArrayBuffer);
}

function subtleCrypto(): SubtleCrypto | undefined {
	return (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
}

function isCryptoKey(k: unknown): k is CryptoKey {
	return typeof k === "object" && k !== null && typeof (k as CryptoKey).type === "string" && "algorithm" in k;
}

function isSpaceChar(ch: string): boolean {
	const r = ch.codePointAt(0);
	return r !== undefined && isSpace(r);
}

function checkFallback(fallback: unknown, where: string): "noble" | "error" {
	if (fallback === undefined || fallback === "noble" || fallback === "error") {
		return fallback ?? "noble";
	}
	throw new WebtesseraError(
		"INVALID_ARGUMENT",
		`${where}: fallback must be "noble" or "error", got ${quoteInput(fallback)}`,
	);
}

function unsupported(where: string): Error {
	return new WebtesseraError(
		"UNSUPPORTED_RUNTIME",
		`${where}: this runtime's WebCrypto API cannot hold an Ed25519 key (it needs Node.js 22.18, Deno, Bun, ` +
			"workerd, or Chrome 137, Firefox 129 or Safari 17 on an HTTPS or localhost page), so a non-extractable " +
			'key is impossible here. Pass fallback: "noble" to accept a key held in memory.',
	);
}

/**
 * isVerifierKey reports whether s parses as a note verifier key, for telling someone who
 * passed one where a signer key belongs that they have the public half.
 */
function isVerifierKey(s: string): boolean {
	try {
		newVerifier(s);
		return true;
	} catch {
		return false;
	}
}

function typeName(v: unknown): string {
	if (v === null) {
		return "null";
	}
	if (typeof v === "object") {
		return v.constructor?.name ?? "object";
	}
	return typeof v;
}
