// Copyright 2019 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from golang.org/x/mod/sumdb/note/note_test.go @ v0.31.0

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { concatBytes, fromUTF8, readUint32BE, toUTF8 } from "../../internal/gostd/bytes.ts";
import type { Reader } from "../../internal/gostd/io.ts";
import {
	errMismatchedVerifier,
	generateKey,
	newEd25519VerifierKey,
	newSigner,
	newVerifier,
	open,
	type Signature,
	type Signer,
	sign,
	UnverifiedNoteError,
	type Verifier,
	type Verifiers,
	verifierList,
} from "./note.ts";

describe("sumdb/note", () => {
	it("TestNewVerifier", () => {
		const vkey = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
		expect(() => newVerifier(vkey)).not.toThrow();

		// Check various manglings are not accepted.
		const badKey = (k: string): void => {
			expect(() => newVerifier(k), `newVerifier(${JSON.stringify(k)}) succeeded, should have failed`).toThrow();
		};

		const b = toUTF8(vkey);
		for (let i = 0; i <= b.length; i++) {
			for (let j = i + 1; j <= b.length; j++) {
				if (i !== 0 || j !== b.length) {
					badKey(fromUTF8(b.subarray(i, j)));
				}
			}
		}
		for (let i = 0; i < b.length; i++) {
			const orig = b[i] ?? 0;
			b[i] = orig + 1;
			badKey(fromUTF8(b));
			b[i] = orig;
		}

		// wrong length key, with adjusted key hash
		badKey("PeterNeumann+cc469956+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TWBADKEY==");
		// unknown algorithm, with adjusted key hash
		badKey("PeterNeumann+173116ae+ZRpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW");
	});

	it("TestNewSigner", () => {
		const skey = "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
		expect(() => newSigner(skey)).not.toThrow();

		// Check various manglings are not accepted.
		const b = toUTF8(skey);
		for (let i = 0; i <= b.length; i++) {
			for (let j = i + 1; j <= b.length; j++) {
				if (i === 0 && j === b.length) {
					continue;
				}
				const k = fromUTF8(b.subarray(i, j));
				expect(() => newSigner(k), `newSigner(${JSON.stringify(k)}) succeeded, should have failed`).toThrow();
			}
		}
		for (let i = 0; i < b.length; i++) {
			const orig = b[i] ?? 0;
			b[i] = orig + 1;
			const k = fromUTF8(b);
			expect(() => newSigner(k), `newSigner(${JSON.stringify(k)}) succeeded, should have failed`).toThrow();
			b[i] = orig;
		}
	});

	/**
	 * testSignerAndVerifier is the port of the Go helper of the same name: it checks
	 * that a signer and verifier agree on name and key hash, that a signature made by
	 * the signer verifies, and that corrupting either the signature or the message
	 * makes verification fail.
	 */
	function testSignerAndVerifier(Name: string, signer: Signer, verifier: Verifier): void {
		expect(signer.name(), "signer.name()").toBe(Name);
		expect(verifier.name(), "verifier.name()").toBe(Name);
		expect(signer.keyHash(), "signer.keyHash() != verifier.keyHash()").toBe(verifier.keyHash());

		const msg = toUTF8("hi");
		const sig = signer.sign(msg);
		expect(verifier.verify(msg, sig), "verifier.verify failed on signature returned by signer.sign").toBe(true);
		sig[0] = ((sig[0] ?? 0) + 1) & 0xff;
		expect(verifier.verify(msg, sig), "verifier.verify succeeded on corrupt signature").toBe(false);
		sig[0] = ((sig[0] ?? 0) - 1) & 0xff;
		msg[0] = ((msg[0] ?? 0) + 1) & 0xff;
		expect(verifier.verify(msg, sig), "verifier.verify succeeded on corrupt message").toBe(false);
	}

	it("TestGenerateKey", () => {
		// Generate key pair, make sure it is all self-consistent.
		const Name = "EnochRoot";

		const { skey, vkey } = generateKey(undefined, Name);
		const signer = newSigner(skey);
		const verifier = newVerifier(vkey);

		testSignerAndVerifier(Name, signer, verifier);

		// Check that GenerateKey returns error from rand reader.
		expect(
			() => generateKey(new timeoutOneByteReader(), Name),
			"generateKey succeeded with error-returning rand reader",
		).toThrow();
	});

	it("TestFromEd25519", () => {
		const Name = "EnochRoot";

		const priv = ed25519.utils.randomSecretKey();
		const pub = ed25519.getPublicKey(priv);
		const signer = newSignerFromEd25519Seed(Name, priv);
		const vkey = newEd25519VerifierKey(Name, pub);
		const verifier = newVerifier(vkey);

		testSignerAndVerifier(Name, signer, verifier);

		// Check that wrong key sizes return errors.
		expect(
			() => newEd25519VerifierKey(Name, pub.subarray(0, pub.length - 1)),
			"newEd25519VerifierKey succeeded with a seed of the wrong size",
		).toThrow();
	});

	it("TestSign", () => {
		const skey = "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
		const text =
			"If you think cryptography is the answer to your problem,\n" + "then you don't know what your problem is.\n";

		const signer = newSigner(skey);

		let msg = sign({ text }, signer);

		const want =
			"If you think cryptography is the answer to your problem,\n" +
			"then you don't know what your problem is.\n" +
			"\n" +
			"— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n";
		expect(fromUTF8(msg), "sign: wrong output").toBe(want);

		// Check that existing signature is replaced by new one.
		msg = sign({ text, sigs: [{ name: "PeterNeumann", hash: 0xc74f20a3, base64: "BADSIGN=" }] }, signer);
		expect(fromUTF8(msg), "sign replacing signature: wrong output").toBe(want);

		// Check various bad inputs.
		expect(() => sign({ text: "abc" }, signer), "sign with short text").toThrow("malformed note");

		expect(() => sign({ text, sigs: [{ name: "a+b", hash: 0, base64: "ABCD" }] }), "sign with bad name").toThrow(
			"malformed note",
		);

		expect(
			() => sign({ text, sigs: [{ name: "PeterNeumann", hash: 0xc74f20a3, base64: "BADHASH=" }] }),
			"sign with bad pre-filled signature",
		).toThrow("malformed note");

		expect(() => sign({ text }, badSigner(signer)), "sign with bad signer").toThrow("invalid signer");

		let thrown: unknown;
		try {
			sign({ text }, errSigner(signer));
		} catch (e) {
			thrown = e;
		}
		expect(thrown, "sign with failing signer").toBe(errSurprise);
	});

	it("TestVerifierList", () => {
		const peterKey = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
		const peterVerifier = newVerifier(peterKey);

		const enochKey = "EnochRoot+af0cfe78+ATtqJ7zOtqQtYqOo0CpvDXNlMhV3HeJDpjrASKGLWdop";
		const enochVerifier = newVerifier(enochKey);

		const list = verifierList(peterVerifier, enochVerifier, enochVerifier);
		expect(list.verifier("PeterNeumann", 0xc74f20a3)).toBe(peterVerifier);
		expect(() => list.verifier("PeterNeumann", 0xc74f20a4)).toThrow("unknown key PeterNeumann+c74f20a4");
		expect(() => list.verifier("PeterNeuman", 0xc74f20a3)).toThrow("unknown key PeterNeuman+c74f20a3");
		expect(() => list.verifier("EnochRoot", 0xaf0cfe78)).toThrow("ambiguous key EnochRoot+af0cfe78");
	});

	it("TestOpen", () => {
		const peterKey = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
		const peterVerifier = newVerifier(peterKey);

		const enochKey = "EnochRoot+af0cfe78+ATtqJ7zOtqQtYqOo0CpvDXNlMhV3HeJDpjrASKGLWdop";
		const enochVerifier = newVerifier(enochKey);

		const text =
			"If you think cryptography is the answer to your problem,\n" + "then you don't know what your problem is.\n";
		const peterSig =
			"— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n";
		const enochSig =
			"— EnochRoot rwz+eBzmZa0SO3NbfRGzPCpDckykFXSdeX+MNtCOXm2/5n2tiOHp+vAF1aGrQ5ovTG01oOTGwnWLox33WWd1RvMc+QQ=\n";

		const peter: Signature = {
			name: "PeterNeumann",
			hash: 0xc74f20a3,
			base64: "x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=",
		};
		const enoch: Signature = {
			name: "EnochRoot",
			hash: 0xaf0cfe78,
			base64: "rwz+eBzmZa0SO3NbfRGzPCpDckykFXSdeX+MNtCOXm2/5n2tiOHp+vAF1aGrQ5ovTG01oOTGwnWLox33WWd1RvMc+QQ=",
		};

		// Check one signature verified, one not.
		let n = open(toUTF8(text + "\n" + peterSig + enochSig), verifierList(peterVerifier));
		expect(n.text).toBe(text);
		expect(n.sigs).toEqual([peter]);
		expect(n.unverifiedSigs).toEqual([enoch]);

		// Check both verified.
		n = open(toUTF8(text + "\n" + peterSig + enochSig), verifierList(peterVerifier, enochVerifier));
		expect(n.sigs).toEqual([peter, enoch]);
		expect(n.unverifiedSigs).toEqual([]);

		// Check both unverified.
		let thrown: unknown;
		try {
			open(toUTF8(text + "\n" + peterSig + enochSig), verifierList());
			throw new Error("open unverified succeeded, want error");
		} catch (e) {
			thrown = e;
		}
		expect(thrown, "open unverified: err is not UnverifiedNoteError").toBeInstanceOf(UnverifiedNoteError);
		const e = thrown as UnverifiedNoteError;
		expect(e.message).toBe("note has no verifiable signatures");

		const un = e.note;
		expect(un, "open unverified: missing note in UnverifiedNoteError").toBeDefined();
		expect(un.sigs).toEqual([]);
		expect(un.unverifiedSigs).toEqual([peter, enoch]);

		// Check duplicated verifier.
		expect(() =>
			open(toUTF8(text + "\n" + enochSig), verifierList(enochVerifier, peterVerifier, enochVerifier)),
		).toThrow("ambiguous key EnochRoot+af0cfe78");

		// Check unused duplicated verifier.
		expect(() =>
			open(toUTF8(text + "\n" + peterSig), verifierList(enochVerifier, peterVerifier, enochVerifier)),
		).not.toThrow();

		// Check too many signatures.
		expect(() => open(toUTF8(text + "\n" + peterSig.repeat(101)), verifierList(peterVerifier))).toThrow(
			"malformed note",
		);
		expect(() => open(toUTF8(text + "\n" + peterSig.repeat(101)), verifierList())).toThrow("malformed note");

		// Invalid signature.
		//
		// Port note: Go slices peterSig by *byte* index. The em dash that opens a
		// signature line is one Go byte index apart from one JavaScript string index
		// per line, so splicing has to happen on the encoded bytes or the "ABCD" lands
		// in the wrong place and the test stops testing what it was written to test.
		const peterSigB = toUTF8(peterSig);
		const corruptPeter = concatBytes(peterSigB.subarray(0, 60), toUTF8("ABCD"), peterSigB.subarray(60));
		expect(() => open(concatBytes(toUTF8(text + "\n"), corruptPeter), verifierList(peterVerifier))).toThrow(
			"invalid signature for key PeterNeumann+c74f20a3",
		);

		// Duplicated verified and unverified signatures.
		const enochSigB = toUTF8(enochSig);
		const corruptEnoch = concatBytes(enochSigB.subarray(0, 60), toUTF8("ABCD"), enochSigB.subarray(60));
		const enochABCD: Signature = {
			name: "EnochRoot",
			hash: 0xaf0cfe78,
			base64:
				"rwz+eBzmZa0SO3NbfRGzPCpDckykFXSdeX+MNtCOXm2/5n" + "ABCD" + "2tiOHp+vAF1aGrQ5ovTG01oOTGwnWLox33WWd1RvMc+QQ=",
		};
		n = open(
			concatBytes(toUTF8(text + "\n" + peterSig + peterSig + enochSig + enochSig), corruptEnoch),
			verifierList(peterVerifier),
		);
		expect(n.sigs).toEqual([peter]);
		expect(n.unverifiedSigs).toEqual([enoch, enochABCD]);

		// Invalid encoded message syntax.
		//
		// Port note: the last two of these are byte sequences, not text. "\xff" is a
		// single invalid UTF-8 byte in Go; writing it as a JavaScript string literal
		// would produce U+00FF, which encodes to two *valid* UTF-8 bytes and would
		// quietly stop exercising the UTF-8 rejection path.
		const badMsgs: Uint8Array[] = [
			toUTF8(text),
			toUTF8(text + "\n"),
			toUTF8(text + "\n" + peterSig.slice(0, peterSig.length - 1)),
			concatBytes(new Uint8Array([0x01]), toUTF8(text + "\n" + peterSig)),
			concatBytes(new Uint8Array([0xff]), toUTF8(text + "\n" + peterSig)),
			toUTF8(
				text +
					"\n" +
					"— Bad Name x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=",
			),
			toUTF8(text + "\n" + peterSig + "Unexpected line.\n"),
		];
		for (const msg of badMsgs) {
			expect(() => open(msg, verifierList(peterVerifier)), `open bad msg:\n${fromUTF8(msg)}`).toThrow("malformed note");
		}

		// Verifiers returns a Verifier for the wrong name or hash.
		const misnamedSig = peterSig.replaceAll("PeterNeumann", "CarmenSandiego");
		let mismatched: unknown;
		try {
			open(toUTF8(text + "\n" + misnamedSig), fixedVerifier(peterVerifier));
		} catch (err) {
			mismatched = err;
		}
		expect(mismatched, "open with wrong Verifier").toBe(errMismatchedVerifier);

		const wrongHash = peterSig.replaceAll("x08g", "xxxx");
		try {
			mismatched = undefined;
			open(toUTF8(text + "\n" + wrongHash), fixedVerifier(peterVerifier));
		} catch (err) {
			mismatched = err;
		}
		expect(mismatched, "open with wrong Verifier").toBe(errMismatchedVerifier);
	});

	// Beyond upstream: Go's `[]byte(string)` is UTF-8, and a note's text is text.
	// A port that reached for charCodeAt would corrupt every multi-byte rune, sign the
	// wrong bytes, and produce a note the rest of the ecosystem rejects — with nothing
	// in an ASCII-only test suite to notice.
	//
	// The expected message is not constructed here: it is the literal output of
	// `note.Sign` running under Go 1.25.5 with golang.org/x/mod v0.31.0, for the same
	// key and the same text.
	it("signs a note whose text is not ASCII byte-identically to Go", () => {
		const skey = "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
		const vkey = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
		const text = "árvore de transparência 日本語 🌲\n";

		// 31 UTF-16 code units (the tree is a surrogate pair), 41 UTF-8 bytes.
		// Go signs the 41.
		expect(text.length).toBe(31);
		expect(toUTF8(text).length).toBe(41);

		const msg = sign({ text }, newSigner(skey));
		expect(fromUTF8(msg)).toBe(
			"árvore de transparência 日本語 🌲\n" +
				"\n" +
				"— PeterNeumann x08go++3OV7s/KeQz0gcxdTb0xCe6RGE+WqNgFmfn4c7Kh2Tj4rqMVeBKDYPti8V31GF/I1uTTEjjn8pxz1ai4qlEwM=\n",
		);

		const n = open(msg, verifierList(newVerifier(vkey)));
		expect(n.text).toBe(text);
		expect(n.sigs?.length).toBe(1);
	});

	// Beyond upstream: a signer *name* with a multi-byte rune has to survive the round
	// trip too, and it is hashed into the key hash. formats/log's own benchmark uses
	// "Señor-%d" names, so this is not hypothetical. Both the generated verifier key
	// and the signed note are Go's literal output for an all-zero seed.
	it("signs under a non-ASCII signer name byte-identically to Go", () => {
		const { skey, vkey } = generateKey(new zeroSeedReader(), "Señor-0");
		expect(vkey).toBe("Señor-0+2b9e7c9d+ATtqJ7zOtqQtYqOo0CpvDXNlMhV3HeJDpjrASKGLWdop");

		const text = "árvore de transparência 日本語 🌲\n";
		const msg = sign({ text }, newSigner(skey));
		expect(fromUTF8(msg)).toBe(
			"árvore de transparência 日本語 🌲\n" +
				"\n" +
				"— Señor-0 K558nbKx+Og8ic5C+e3Te6A+uYuB6Ke9u13b5DG3K6iHje8ZDo9lHeHE57w3+eEmwnoKPPo8zxLg9LmiEExwKY7szw4=\n",
		);

		const n = open(msg, verifierList(newVerifier(vkey)));
		expect(n.sigs?.[0]?.name).toBe("Señor-0");
	});

	// Beyond upstream, and the single most security-critical case in the package.
	//
	// Go's crypto/ed25519 — which sumdb/note verifies against — is RFC 8032 /
	// FIPS 186-5 *cofactorless*: a signature is valid only if R == [S]B - [k]A exactly.
	// @noble/curves verifies the *cofactored* equation [8](R + [k]A - [S]B) = O in both
	// of its zip215 modes, so it additionally accepts a signature whose residual is a
	// non-zero small-order point. Those signatures exist for mixed-order public keys.
	//
	// A verifier that accepted a checkpoint signature Go rejects would let a webtessera
	// client and a Go witness split on the same bytes. This vector is constructed to be
	// accepted by noble under both zip215 settings and rejected by Go's crypto/ed25519
	// (confirmed against Go 1.25.5); the port must reject it too. The construction is
	// deterministic and independently reproducible: A' = [a]B + T0 where T0 has order 8,
	// signed with S = r + k*a so the residual is the non-zero torsion point -[k]T0.
	it("rejects a signature valid under noble's cofactored rule but invalid under Go's (RFC 8032)", () => {
		const L = 2n ** 252n + 27742317777372353535851937790883648493n;
		const modL = (x: bigint): bigint => ((x % L) + L) % L;
		const leToBig = (b: Uint8Array): bigint => {
			let v = 0n;
			for (let i = b.length - 1; i >= 0; i--) {
				v = (v << 8n) | BigInt(b[i] ?? 0);
			}
			return v;
		};
		const bigToLE = (x: bigint, len: number): Uint8Array => {
			const b = new Uint8Array(len);
			let v = x;
			for (let i = 0; i < len; i++) {
				b[i] = Number(v & 0xffn);
				v >>= 8n;
			}
			return b;
		};

		// One of the eight Ed25519 torsion points; this one has order 8.
		const T0 = ed25519.Point.fromHex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", true);
		expect(T0.isSmallOrder(), "T0 must be small-order").toBe(true);

		const a = modL(0x1234567890abcdef1122334455667788n);
		const A = ed25519.Point.BASE.multiply(a);
		const Aprime = A.add(T0); // mixed order: prime-order part plus torsion
		const pubkey = Aprime.toBytes();

		const msg = toUTF8("hi");
		const r = modL(0x0fedcba987654321aabbccddeeff0011n);
		const Rb = ed25519.Point.BASE.multiply(r).toBytes();
		const k = modL(leToBig(sha512(concatBytes(Rb, pubkey, msg))));
		const S = modL(r + k * a);
		const sig = concatBytes(Rb, bigToLE(S, 32));

		// Guard against a vacuous test: noble accepts this under both rules, so if the
		// port merely delegated to noble it would accept it too.
		expect(ed25519.verify(sig, msg, pubkey, { zip215: true }), "noble zip215:true").toBe(true);
		expect(ed25519.verify(sig, msg, pubkey, { zip215: false }), "noble zip215:false").toBe(true);

		// The port must reject it, matching Go's crypto/ed25519.Verify == false.
		const verifier = newVerifier(newEd25519VerifierKey("MixedOrder", pubkey));
		expect(verifier.verify(msg, sig), "port must reject the cofactored-only signature").toBe(false);
	});
});

/**
 * newSignerFromEd25519Seed constructs a new signer from a verifier name and a
 * crypto/ed25519 private key seed.
 *
 * Port note: Go's version of this helper reaches into the package's unexported
 * keyHash and signer. This one re-derives the key hash from the specification
 * instead, which makes the test an independent check of note.ts rather than a
 * restatement of it.
 */
function newSignerFromEd25519Seed(name: string, seed: Uint8Array): Signer {
	if (seed.length !== 32) {
		throw new Error("invalid seed size");
	}
	const pub = ed25519.getPublicKey(seed);
	const pubkey = concatBytes(new Uint8Array([1]), pub);
	const hash = testKeyHash(name, pubkey);

	return {
		name: () => name,
		keyHash: () => hash,
		sign: (msg: Uint8Array) => ed25519.sign(msg, seed),
	};
}

/** testKeyHash re-derives the key hash straight from the package documentation. */
function testKeyHash(name: string, key: Uint8Array): number {
	return readUint32BE(sha256(concatBytes(toUTF8(name), toUTF8("\n"), key)), 0);
}

/** badSigner is the port of Go's badSigner: a Signer that reports an invalid name. */
function badSigner(s: Signer): Signer {
	return { name: () => "bad name", keyHash: () => s.keyHash(), sign: (msg) => s.sign(msg) };
}

const errSurprise = new Error("surprise!");

/** errSigner is the port of Go's errSigner: a Signer whose Sign always fails. */
function errSigner(s: Signer): Signer {
	return {
		name: () => s.name(),
		keyHash: () => s.keyHash(),
		sign: (): Uint8Array => {
			throw errSurprise;
		},
	};
}

/** fixedVerifier is the port of Go's fixedVerifier: it answers with one verifier, always. */
function fixedVerifier(v: Verifier): Verifiers {
	return { verifier: () => v };
}

/** zeroSeedReader yields an endless run of zero bytes, making generateKey deterministic. */
class zeroSeedReader implements Reader {
	read(p: Uint8Array): number {
		p.fill(0);
		return p.length;
	}
}

/**
 * timeoutOneByteReader mirrors `iotest.TimeoutReader(iotest.OneByteReader(rand.Reader))`:
 * it yields a single byte and then fails, so GenerateKey cannot fill a 32-byte seed.
 */
class timeoutOneByteReader implements Reader {
	private reads = 0;
	read(p: Uint8Array): number {
		this.reads++;
		if (this.reads > 1) {
			throw new Error("timeout");
		}
		if (p.length === 0) {
			return 0;
		}
		p[0] = 0;
		return 1;
	}
}
