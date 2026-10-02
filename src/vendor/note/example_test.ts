// Copyright 2019 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.
//
// Ported from golang.org/x/mod/sumdb/note/example_test.go @ v0.31.0
//
// Port note: Go's testable examples assert on what the function writes to stdout.
// There is no equivalent in vitest, so each example builds the same string the Go
// example would have printed and asserts on it. The `// Output:` block of the Go
// example is reproduced verbatim as the expected value.

import { describe, expect, it } from "vitest";
import { fromUTF8, toUTF8 } from "../../internal/gostd/bytes.ts";
import type { Reader } from "../../internal/gostd/io.ts";
import { generateKey, newSigner, newVerifier, open, sign, verifierList } from "./note.ts";

/** zeroReader is the port of the example's zeroReader: an endless run of zero bytes. */
class zeroReader implements Reader {
	read(buf: Uint8Array): number {
		buf.fill(0);
		return buf.length;
	}
}

const rand = { Reader: new zeroReader() };

describe("sumdb/note examples", () => {
	it("ExampleSign", () => {
		const skey = "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
		const text =
			"If you think cryptography is the answer to your problem,\n" + "then you don't know what your problem is.\n";

		const signer = newSigner(skey);
		const msg = sign({ text }, signer);

		expect(fromUTF8(msg)).toBe(
			"If you think cryptography is the answer to your problem,\n" +
				"then you don't know what your problem is.\n" +
				"\n" +
				"— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n",
		);
	});

	it("ExampleOpen", () => {
		const vkey = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
		const msg = toUTF8(
			"If you think cryptography is the answer to your problem,\n" +
				"then you don't know what your problem is.\n" +
				"\n" +
				"— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n",
		);

		const verifier = newVerifier(vkey);
		const verifiers = verifierList(verifier);

		const n = open(msg, verifiers);
		const sig = n.sigs?.[0];
		expect(sig).toBeDefined();
		// fmt.Printf("%s (%08x):\n%s", n.Sigs[0].Name, n.Sigs[0].Hash, n.Text)
		const printed = `${sig?.name} (${(sig?.hash ?? 0).toString(16).padStart(8, "0")}):\n${n.text}`;

		expect(printed).toBe(
			"PeterNeumann (c74f20a3):\n" +
				"If you think cryptography is the answer to your problem,\n" +
				"then you don't know what your problem is.\n",
		);
	});

	it("ExampleSign_add_signatures", () => {
		let vkey = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
		let msg = toUTF8(
			"If you think cryptography is the answer to your problem,\n" +
				"then you don't know what your problem is.\n" +
				"\n" +
				"— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n",
		);

		const verifier = newVerifier(vkey);
		const verifiers = verifierList(verifier);

		const n = open(msg, verifiers);

		// biome-ignore lint/style/useConst: mirrors the Go example's two-step declaration and assignment.
		let skey: string;
		({ skey, vkey } = generateKey(rand.Reader, "EnochRoot"));
		void vkey; // give to verifiers

		const me = newSigner(skey);

		msg = sign(n, me);

		expect(fromUTF8(msg)).toBe(
			"If you think cryptography is the answer to your problem,\n" +
				"then you don't know what your problem is.\n" +
				"\n" +
				"— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n" +
				"— EnochRoot rwz+eBzmZa0SO3NbfRGzPCpDckykFXSdeX+MNtCOXm2/5n2tiOHp+vAF1aGrQ5ovTG01oOTGwnWLox33WWd1RvMc+QQ=\n",
		);
	});

	// Beyond upstream: the key the example derives from an all-zero seed is the very
	// key note_test.go hardcodes as EnochRoot's, so deriving it here proves that
	// generateKey reads exactly 32 bytes from the reader and hashes the right preimage.
	it("derives EnochRoot's published verifier key from an all-zero seed", () => {
		const { vkey } = generateKey(rand.Reader, "EnochRoot");
		expect(vkey).toBe("EnochRoot+af0cfe78+ATtqJ7zOtqQtYqOo0CpvDXNlMhV3HeJDpjrASKGLWdop");
	});
});
