// Copyright 2019 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from golang.org/x/mod/sumdb/note/note_test.go @ v0.31.0

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { concatBytes, fromHex, fromUTF8, readUint32BE, toBase64, toUTF8 } from "../../internal/gostd/bytes.ts";
import type { Reader } from "../../internal/gostd/io.ts";
import {
	ambiguousVerifierError,
	checkEd25519PublicKey,
	errInvalidSigner,
	errMalformedNote,
	errMismatchedVerifier,
	errSignerAlg,
	errSignerHash,
	errSignerID,
	errVerifierAlg,
	errVerifierHash,
	errVerifierID,
	errVerifierNonCanonicalKey,
	errVerifierSmallOrderKey,
	generateKey,
	InvalidSignatureError,
	newEd25519VerifierKey,
	newSigner,
	newVerifier,
	open,
	type Signature,
	type Signer,
	sign,
	UnknownVerifierError,
	UnverifiedNoteError,
	type Verifier,
	type Verifiers,
	verifierList,
	verifyEd25519,
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
		// Port note: Go compares err.Error() with the expected text; the port's errors
		// are the package's sentinels, so identity is asserted, which implies the text.
		expect(
			thrownBy(() => sign({ text: "abc" }, signer)),
			"sign with short text",
		).toBe(errMalformedNote);

		expect(
			thrownBy(() => sign({ text, sigs: [{ name: "a+b", hash: 0, base64: "ABCD" }] })),
			"sign with bad name",
		).toBe(errMalformedNote);

		expect(
			thrownBy(() => sign({ text, sigs: [{ name: "PeterNeumann", hash: 0xc74f20a3, base64: "BADHASH=" }] })),
			"sign with bad pre-filled signature",
		).toBe(errMalformedNote);

		expect(
			thrownBy(() => sign({ text }, badSigner(signer))),
			"sign with bad signer",
		).toBe(errInvalidSigner);
		expect(errMalformedNote.message).toBe("malformed note");
		expect(errInvalidSigner.message).toBe("invalid signer");

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
		const badHash = thrownBy(() => list.verifier("PeterNeumann", 0xc74f20a4));
		expect(badHash).toBeInstanceOf(UnknownVerifierError);
		expect((badHash as Error).message).toBe("unknown key PeterNeumann+c74f20a4");
		const badName = thrownBy(() => list.verifier("PeterNeuman", 0xc74f20a3));
		expect(badName).toBeInstanceOf(UnknownVerifierError);
		expect((badName as Error).message).toBe("unknown key PeterNeuman+c74f20a3");
		const ambiguous = thrownBy(() => list.verifier("EnochRoot", 0xaf0cfe78));
		expect(ambiguous).toBeInstanceOf(ambiguousVerifierError);
		expect((ambiguous as Error).message).toBe("ambiguous key EnochRoot+af0cfe78");
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
		expect(
			messageOf(() => open(toUTF8(text + "\n" + enochSig), verifierList(enochVerifier, peterVerifier, enochVerifier))),
		).toBe("ambiguous key EnochRoot+af0cfe78");

		// Check unused duplicated verifier.
		expect(() =>
			open(toUTF8(text + "\n" + peterSig), verifierList(enochVerifier, peterVerifier, enochVerifier)),
		).not.toThrow();

		// Check too many signatures.
		expect(thrownBy(() => open(toUTF8(text + "\n" + peterSig.repeat(101)), verifierList(peterVerifier)))).toBe(
			errMalformedNote,
		);
		expect(thrownBy(() => open(toUTF8(text + "\n" + peterSig.repeat(101)), verifierList()))).toBe(errMalformedNote);

		// Invalid signature.
		//
		// Port note: Go slices peterSig by *byte* index. The em dash that opens a
		// signature line is one Go byte index apart from one JavaScript string index
		// per line, so splicing has to happen on the encoded bytes or the "ABCD" lands
		// in the wrong place and the test stops testing what it was written to test.
		const peterSigB = toUTF8(peterSig);
		const corruptPeter = concatBytes(peterSigB.subarray(0, 60), toUTF8("ABCD"), peterSigB.subarray(60));
		const invalid = thrownBy(() => open(concatBytes(toUTF8(text + "\n"), corruptPeter), verifierList(peterVerifier)));
		expect(invalid).toBeInstanceOf(InvalidSignatureError);
		expect((invalid as Error).message).toBe("invalid signature for key PeterNeumann+c74f20a3");

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
			expect(
				thrownBy(() => open(msg, verifierList(peterVerifier))),
				`open bad msg:\n${fromUTF8(msg)}`,
			).toBe(errMalformedNote);
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
	// Not upstream. verifyEd25519 must reach Go's crypto/ed25519.Verify verdict on every
	// input (docs/decisions/0206-ed25519-verification-matches-go.md). These vectors come
	// from the note/gostd fidelity audit's differential run (2,366 vectors, 0
	// disagreements with Go 1.25.5); `go` is Go's verdict for each. They cover an honest
	// signature, every small-order public-key encoding (Go accepts a signature under
	// each, and so must this function), mixed-order keys that Go accepts and rejects,
	// torsioned R, a non-canonical S, and a small-order key with a random signature.
	const goVerdicts: Array<{ cat: string; pub: string; msg: string; sig: string; go: boolean }> = [
		{
			cat: "honest",
			pub: "10d8286c2e12fd8226c911980a386abf4a3aad6c3b1763ef4b45430f2ee50716",
			msg: "145fa6b5ed7cbf52ca06bc956ba03f4c302bae94b2",
			sig: "eb97665ae87e32048a6366932f659d8ef7db7d6b41c9fb5abce3b0752bf016b2279f4fc600a7400377954506f4fb9dac012cc38b665148eebed92b2e15949903",
			go: true,
		},
		{
			cat: "S+L",
			pub: "10d8286c2e12fd8226c911980a386abf4a3aad6c3b1763ef4b45430f2ee50716",
			msg: "145fa6b5ed7cbf52ca06bc956ba03f4c302bae94b2",
			sig: "eb97665ae87e32048a6366932f659d8ef7db7d6b41c9fb5abce3b0752bf016b2147345231b0a535b4d323da9d2f57cc1012cc38b665148eebed92b2e15949913",
			go: false,
		},
		{
			cat: "smallA-valid",
			pub: "0100000000000000000000000000000000000000000000000000000000000000",
			msg: "27a9756fe0",
			sig: "32ee23de5d5474e6095e90040fb360e01cf32892dfa9b9a2be7b0ee0bab754e3ee281bffb9161f4db37510597608456565e157edf54fbf6b0303268f35b87502",
			go: true,
		},
		{
			cat: "smallA-invalid",
			pub: "0100000000000000000000000000000000000000000000000000000000000000",
			msg: "31bec871b1",
			sig: "7404662ba7dae5ff2b517703c8c4563cf279e2baad863767dac8c47b917ba15b942f753a3f5f8358b58e5ba9439e1b4092f30f70bcec24f28f84a4a7d355180f",
			go: false,
		},
		{
			cat: "smallA-valid",
			pub: "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
			msg: "6c",
			sig: "5ed4618b1a684bfbf1475d5e87cc130f9255f2dde09781e8b41c5b28656ecc2663c8de3f7d7087570f69745d530188faa2e04a161ed10f8acb9144a13348c30f",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "0000000000000000000000000000000000000000000000000000000000000000",
			msg: "4c5f",
			sig: "846bef079ff96d8a4d60f8fe48b76a19b415d94608eb93b41a093fa194c5caafc295e5e093ddec5e2fa96d2cd0f31fc383a43396ed8473af7ebdd569f3521305",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "0000000000000000000000000000000000000000000000000000000000000080",
			msg: "5dd275ca",
			sig: "1f2c93f65ebf0560e3c7ec1c0c6837fbda3963436f1929e57209a751dc08994b53cffcab1d6e52ac18ec52c395982e333ef6463852ea97e75057761cea7b980b",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
			msg: "d5",
			sig: "938fec2bdc61e88ac16b0b126fabae3f2c7dd9806124656a88b7b8fe20e5d9f0110890164317e79063fbbd1e3569422491480aebad6618f76e437b6affe1170f",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
			msg: "cd2fba07bdc891e8",
			sig: "e08af7479648d3864de10132e38357f5caf9a7bad49ca7182d34d2324aed4edbe015d8409d5033b16fb8f7999136731da0b67b5bf4da6f97690b5c4d4c673b0a",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
			msg: "aae94c07",
			sig: "6367ed247ee4465e7e6f694fb1b3bdd52b5fca703163bcfb09f6feeae4e38db82813ea6453cef9f16e1d23debdfefa89a337479bd1f1769a05bd4fadcd9b7205",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
			msg: "4860676d",
			sig: "f1b2f9c0daa6fd8bc3fe7c8d5eb045db9b35d4a241e072fc224d587a89de200de7a9053b9837623449345308532719e1cbfe1a8fde58f2b4ec973c0a2a7f6706",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
			msg: "551480e787",
			sig: "9186a4a8af2a41847be0e614937018fcc768a4ab1606d854f3d7cd475551dd593ef272bf012079d566fbc87d661639fa0e56fbbd02d8de91ae105ebc6de77203",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
			msg: "7730f96e",
			sig: "6f9fe213371e7b0234ab5ba95b7a6c72b80648e00e334fe078eb9cc46908ca37a6b6babf8e265bdc0f4453e523e28dde1938e351600446976b7e83871f623900",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			msg: "d10501",
			sig: "de8428be583c890a3dddc98e3fa18ab0bbfb62e4fdee885cf0c1a5df34b24df2fab1493a527afe855e8cb3541c8f17d4f6206ae501de37f3ffb72f0e4d0d6602",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			msg: "c1",
			sig: "229c226c543207e237d145c67374e32788d299f1d561360ca7b0fc17dc1c796da7f4126c23a170fe837f4681ef6fc9038f7ae70485ba31a981251312655a9003",
			go: true,
		},
		{
			cat: "smallA-valid",
			pub: "0100000000000000000000000000000000000000000000000000000000000080",
			msg: "30",
			sig: "1f6615d2bd9e632db79e11ae45a7b6a7c149a0408cb4c67a40ef70e46800ccfe10acdf42b3087470e22d462688d9dd7616fa555d2632ec4994bb03795af09702",
			go: true,
		},
		{
			cat: "mixed-order",
			pub: "49bc5d4984b49988e30c8ba78003272c8e3a28a7deb173e12574ba4efaa94c85",
			msg: "083ca1c56185",
			sig: "c530e787722ee9366f05ee5d745a376594588c84d2370fc8f1d252b069a37d2be7bb6442550da9b2d351a2babc74abfb403a6f4ca5226384478e854de973470c",
			go: true,
		},
		{
			cat: "mixed-order",
			pub: "ad79bb277beb74674186f04bfc2c73564c253b9b39fe6a7a2dfaa8849d6dc376",
			msg: "62",
			sig: "f405a53dd49833e614c0d8dcfbc54b8694e5615bc479fba9838d755369fa5909e5902716aa8c4398acefa6e1a8ebc771db128b00771dd41b525f292f969b0d04",
			go: false,
		},
		{
			cat: "mixed-order",
			pub: "205a37a16add45d5a12596b6626dca3f469770a63e889be21c07598d50e391b7",
			msg: "14",
			sig: "bb2a21e87116d1baeb0a83f52cbeff6c9cdc71223af7eda58c4442a7960106ba121ee61e12c6485f2adafe9138298cdffc7839cb1d03756cac3ff429d19fa903",
			go: true,
		},
		{
			cat: "mixed-order",
			pub: "346bf6c66a4871aa041d32bb8a94953b5ae7af0503e6aed1ecb4c2c872b88c97",
			msg: "4c467a",
			sig: "19b4e32b92f79c105099ce747b2c17b811db99dc14a0a134bca2a6c3a102e6ab04bd7d09d8e837c535d8501bf20a77709258222bb0b74125fc7533c00f4ada0e",
			go: false,
		},
		{
			cat: "mixed-order",
			pub: "ce1f6eafd7239b9f1df5881b458482152a2a48d8d6e5b55bbd7eefceb2821a87",
			msg: "868fc7",
			sig: "9722c02ec19ae308720fa31c88b6b8ae1a1e42b6fb1b678772230fbe98cb48b38acceec0e9b95eef68a512bba3cc048261bb82f7a19e4159ff603b48e6eee204",
			go: false,
		},
		{
			cat: "mixed-order",
			pub: "17c1e85b0b2e7d6251a3925b40c8666c96859f2fc68ad8fa523656ad2d053f8c",
			msg: "223acb5b004688",
			sig: "710c06352e63248d3eb28bb737be67e305ea3f886a6ab086ad77966c004a9d5dbf3342acf7ae7a5fd9f84b6a9ad2c8607a8457e512db051558d1a66aadbcae00",
			go: true,
		},
		{
			cat: "R+torsion",
			pub: "90bd99de9cade1c5ca3fc430b448c73584152fac63675ce3ed61f96eb03d6ee9",
			msg: "1e020ea5",
			sig: "cf800910b3d9aa729b00e5fa66590c325e7085470fa6691d03be98999ca64d9cc6aa334929ee12584896d273cd5c4a256c51d3558daa0a66d3e3dd6540ce4901",
			go: false,
		},
		{
			cat: "R+torsion",
			pub: "7d6d534770665416f0f5c173b6005600c626145918581d1dce5f1e17af0689ca",
			msg: "09725ba8",
			sig: "6eee0b611360e953b74f0491496a56a91dc4e9f24c8c8f90a80450be2f488df65db95403a62656c7d0e04428e43604ad86df537b8022dd16f86068c87e90370f",
			go: false,
		},
	];

	it("verifyEd25519 reaches Go's verdict on the audit's pinned vectors", () => {
		for (const v of goVerdicts) {
			expect(verifyEd25519(fromHex(v.pub), fromHex(v.msg), fromHex(v.sig)), `${v.cat} pub=${v.pub}`).toBe(v.go);
		}
	});

	// Not upstream: the configuration-time refusal of degenerate keys that Go's
	// NewVerifier accepts (docs/decisions/0206-ed25519-verification-matches-go.md).
	it("newVerifier refuses small-order Ed25519 public keys", () => {
		const smallOrder = [...new Set(goVerdicts.filter((v) => v.cat.startsWith("smallA")).map((v) => v.pub))];
		expect(smallOrder.length).toBe(13);
		for (const pub of smallOrder) {
			const key = fromHex(pub);
			const vkey = newEd25519VerifierKey("SmallOrder", key);
			const err = thrownBy(() => newVerifier(vkey));
			// A non-canonical encoding of a small-order point is reported as small-order.
			expect(err, pub).toBe(errVerifierSmallOrderKey);
			expect(thrownBy(() => checkEd25519PublicKey(key))).toBe(errVerifierSmallOrderKey);
		}
		expect(errVerifierSmallOrderKey.message).toBe("unsafe verifier key: Ed25519 public key is a small-order point");
	});

	it("newVerifier refuses a non-canonical encoding of a large-order point", () => {
		// y = p + k for small k is a non-canonical encoding of the point with y = k, when
		// that point exists; find the first one of large order.
		const p = 2n ** 255n - 19n;
		let found: Uint8Array | undefined;
		for (let k = 2n; k < 19n && found === undefined; k++) {
			const enc = new Uint8Array(32);
			let v = p + k;
			for (let i = 0; i < 32; i++) {
				enc[i] = Number(v & 0xffn);
				v >>= 8n;
			}
			try {
				if (!ed25519.Point.fromBytes(enc, true).isSmallOrder()) {
					found = enc;
				}
			} catch {
				// not a curve point
			}
		}
		expect(found).toBeDefined();
		const key = found as Uint8Array;
		expect(thrownBy(() => newVerifier(newEd25519VerifierKey("NonCanonical", key)))).toBe(errVerifierNonCanonicalKey);
		// The canonical encoding of the same point is fine.
		const canonical = ed25519.Point.fromBytes(key, true).toBytes();
		expect(() => newVerifier(newEd25519VerifierKey("Canonical", canonical))).not.toThrow();
	});

	it("newVerifier still accepts what Go accepts otherwise: mixed-order keys and non-points", () => {
		for (const v of goVerdicts.filter((x) => x.cat === "mixed-order")) {
			const verifier = newVerifier(newEd25519VerifierKey("MixedOrder", fromHex(v.pub)));
			expect(verifier.verify(fromHex(v.msg), fromHex(v.sig))).toBe(v.go);
		}
		// 32 bytes that do not decode to a point: Go builds the verifier, and it verifies
		// nothing.
		const notAPoint = fromHex("0200000000000000000000000000000000000000000000000000000000000000");
		expect(() => ed25519.Point.fromBytes(notAPoint, true)).toThrow();
		const verifier = newVerifier(newEd25519VerifierKey("NotAPoint", notAPoint));
		expect(verifier.verify(toUTF8("hi"), new Uint8Array(64))).toBe(false);
	});

	// Not upstream: edge behaviours of key parsing and of open that nothing above pins
	// exactly. Each expectation was confirmed against golang.org/x/mod v0.31.0's
	// NewVerifier, NewSigner and Open (Go 1.24).
	it("pins verifier and signer key edge cases to Go's errors", () => {
		const peterKey = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
		const peterSkey = "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
		// The key hash is parsed as hex, so upper case is accepted.
		expect(newVerifier("PeterNeumann+C74F20A3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW").keyHash()).toBe(
			0xc74f20a3,
		);
		// ...but it must be exactly eight digits.
		expect(thrownBy(() => newVerifier("PeterNeumann+0c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW"))).toBe(
			errVerifierID,
		);
		// A hash that does not match the key.
		expect(thrownBy(() => newVerifier("PeterNeumann+c74f20a4+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW"))).toBe(
			errVerifierHash,
		);
		// Unpadded base64 is malformed, not decoded leniently.
		expect(thrownBy(() => newVerifier(peterKey.replace(/=*$/, "").slice(0, -1)))).toBe(errVerifierID);
		// An empty name, a name with a plus or a Unicode space (U+0085 is White_Space).
		expect(thrownBy(() => newVerifier("+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW"))).toBe(errVerifierID);
		expect(
			thrownBy(() => newVerifier("Peter\u0085Neumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW")),
		).toBe(errVerifierID);
		// An unknown algorithm with a matching hash.
		expect(thrownBy(() => newVerifier("PeterNeumann+173116ae+ZRpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW"))).toBe(
			errVerifierAlg,
		);
		// A 31-byte Ed25519 key with a matching hash.
		const short = newEd25519VerifierKeyUnchecked("PeterNeumann", new Uint8Array(31).fill(7));
		expect(thrownBy(() => newVerifier(short))).toBe(errVerifierID);

		expect(newSigner(peterSkey).keyHash()).toBe(0xc74f20a3);
		expect(thrownBy(() => newSigner(peterSkey.replace("PRIVATE", "private")))).toBe(errSignerID);
		expect(thrownBy(() => newSigner(peterSkey.replace("c74f20a3", "c74f20a4")))).toBe(errSignerHash);
		expect(
			thrownBy(() => newSigner("PRIVATE+KEY+PeterNeumann+c74f20a3+ZYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz")),
		).toBe(errSignerAlg);
		// Go's signer sentinels carry the verifier wording, verbatim.
		expect(errSignerID.message).toBe("malformed verifier id");
		expect(errSignerAlg.message).toBe("unknown verifier algorithm");
		expect(errSignerHash.message).toBe("invalid verifier hash");
	});

	it("pins open's edge cases to Go's behaviour", () => {
		const peterVerifier = newVerifier("PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW");
		const text =
			"If you think cryptography is the answer to your problem,\n" + "then you don't know what your problem is.\n";
		const peterSig =
			"— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n";
		// Exactly 100 signature lines is the limit, and repeats count towards it.
		expect(open(toUTF8(text + "\n" + peterSig.repeat(100)), verifierList(peterVerifier)).sigs?.length).toBe(1);
		// An undefined Verifiers is an empty list, not a crash.
		expect(thrownBy(() => open(toUTF8(text + "\n" + peterSig), undefined))).toBeInstanceOf(UnverifiedNoteError);
		// A signature of exactly four bytes (a key hash and nothing else) is malformed.
		expect(thrownBy(() => open(toUTF8(`${text}\n— PeterNeumann x08gow==\n`), verifierList(peterVerifier)))).toBe(
			errMalformedNote,
		);
		// A carriage return is a control character.
		expect(
			thrownBy(() => open(toUTF8(`${text.replace("\n", "\r\n")}\n${peterSig}`), verifierList(peterVerifier))),
		).toBe(errMalformedNote);
		// The text keeps a leading byte-order mark, which is not a control character, so
		// the note is well-formed; Peter's signature is over different bytes, so it fails.
		const bom = thrownBy(() => open(toUTF8(`\ufeff${text}\n${peterSig}`), verifierList(peterVerifier)));
		expect(bom).toBeInstanceOf(InvalidSignatureError);
	});

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

/** thrownBy returns what fn throws, failing the test if it returns normally. */
function thrownBy(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error("expected a throw");
}

/** messageOf returns the message of what fn throws. */
function messageOf(fn: () => unknown): string {
	return (thrownBy(fn) as Error).message;
}

/**
 * newEd25519VerifierKeyUnchecked encodes a verifier key for an Ed25519 key of any
 * length, re-deriving the key hash from the specification, so that newVerifier's own
 * length check is what rejects it.
 */
function newEd25519VerifierKeyUnchecked(name: string, key: Uint8Array): string {
	const pubkey = concatBytes(new Uint8Array([1]), key);
	return `${name}+${testKeyHash(name, pubkey).toString(16).padStart(8, "0")}+${toBase64(pubkey)}`;
}
