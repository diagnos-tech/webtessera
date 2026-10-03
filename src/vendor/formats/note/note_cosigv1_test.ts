// Copyright 2023 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from github.com/transparency-dev/formats/note/note_cosigv1_test.go
// @ v0.0.0-20251017110053-404c0d5b696c
// (see note_cosigv1.ts for why this file carries the Go Authors' notice)
//
// Port note: TestCoSigV1NewVerifier calls the general `NewVerifier` dispatcher from
// note_verifier.go, which is not ported (see note_cosigv1.ts's header comment and
// docs/decisions/0174-formats-note-cosigv1-timestamp-and-vkey-conversion.md). Its rows are
// run against newVerifierForCosignatureV1 instead, which reaches the same verdict on every
// one of them, and two port-addition rows pin what that function does not check. Every other
// upstream case is here, in upstream order, followed by port additions.

import { describe, expect, it } from "vitest";
import { generateKey, newVerifier, open, type Signature, sign, verifierList } from "../../note/note.ts";
import {
	coSigV1Timestamp,
	newSignerForCosignatureV1,
	newVerifierForCosignatureV1,
	vKeyToCosignatureV1,
} from "./note_cosigv1.ts";

describe("TestSignerRoundtrip", () => {
	it("signs and opens with the signer's own derived verifier", () => {
		const { skey } = generateKey(undefined, "test");
		const s = newSignerForCosignatureV1(skey);

		const msg = "test\n123\nf+7CoKgXKE/tNys9TTXcr/ad6U/K3xvznmzew9y6SP0=\n";
		const n = sign({ text: msg }, s);

		expect(() => open(n, verifierList(s.verifier()))).not.toThrow();
	});
});

describe("TestSignerVerifierRoundtrip", () => {
	it("signs with the signer and opens with the independently derived verifier", () => {
		const { skey, vkey } = generateKey(undefined, "test");
		const s = newSignerForCosignatureV1(skey);
		const v = newVerifierForCosignatureV1(vkey);

		const msg = "test\n123\nf+7CoKgXKE/tNys9TTXcr/ad6U/K3xvznmzew9y6SP0=\n";
		const n = sign({ text: msg }, s);

		expect(() => open(n, verifierList(v))).not.toThrow();
	});
});

describe("TestVerifierInvalidSig", () => {
	it("rejects a message which is not a validly-formed signed note", () => {
		const { skey } = generateKey(undefined, "test");
		const s = newSignerForCosignatureV1(skey);

		const msg = "test\n123\nf+7CoKgXKE/tNys9TTXcr/ad6U/K3xvznmzew9y6SP0=\n";
		sign({ text: msg }, s); // Go's test signs but discards the result before opening "nobbled".

		expect(() => open(new TextEncoder().encode("nobbled"), verifierList(s.verifier()))).toThrow();
	});
});

describe("TestSigCoversExtensionLines", () => {
	it("rejects a signature when an extension line has been tampered with", () => {
		const { skey } = generateKey(undefined, "test");
		const s = newSignerForCosignatureV1(skey);

		const msg = "test\n123\nf+7CoKgXKE/tNys9TTXcr/ad6U/K3xvznmzew9y6SP0=\nExtendo\n";
		const n = sign({ text: msg }, s);

		n[n.length - 2] = "@".charCodeAt(0);
		expect(() => open(n, verifierList(s.verifier()))).toThrow();
	});
});

describe("TestCoSigV1NewVerifier", () => {
	// sigStoreKeyMaterial is an ECDSA key (algorithm 2), from note_verifier_test.go.
	const sigStoreKeyMaterial =
		"AjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABNhtmPtrWm3U1eQXBogSMdGvXwBcK5AW5i0hrZLOC96l+smGNM7nwZ4QvFK/4sueRoVj//QP22Ni4Qt9DPfkWLc=";
	const tests: { name: string; pubK: string; wantErr?: string }[] = [
		{ name: "works: convert from algEd25519", pubK: "TEST+7997405c+AQcC+FTVKf0jlTdHDY3rbevmnKxxPjigCXlVtGe6RIr6" },
		{
			name: "works: native algEd25519CosignatureV1 verifier",
			pubK: "remora.n621.de+da77ade7+BOvN63jn/bLvkieywe8R6UYAtVtNbZpXh34x7onlmtw2",
		},
		{ name: "wrong number of parts", pubK: "bananas.sigstore.dev+12344556", wantErr: "malformed verifier id" },
		{
			name: "invalid base64",
			pubK: "rekor.sigstore.dev+12345678+THIS_IS_NOT_BASE64!",
			wantErr: "malformed verifier id",
		},
		{ name: "invalid algo", pubK: "rekor.sigstore.dev+12345678+AwEB", wantErr: "unknown verifier algorithm" },
		{
			name: "invalid keyhash",
			pubK: `rekor.sigstore.dev+NOT_A_NUMBER+${sigStoreKeyMaterial}`,
			wantErr: "malformed verifier id",
		},
		{
			name: "incorrect keyhash",
			pubK: `rekor.sigstore.dev+00000000+${sigStoreKeyMaterial}`,
			wantErr: "unknown verifier algorithm",
		},
		// Port additions: NewVerifierForCosignatureV1 checks only the length of the key hash
		// field and never parses or compares it (it computes the cosignature/v1 hash itself).
		{
			name: "key hash field is not parsed",
			pubK: "remora.n621.de+ZZZZZZZZ+BOvN63jn/bLvkieywe8R6UYAtVtNbZpXh34x7onlmtw2",
		},
		{
			name: "key hash field is not compared",
			pubK: "remora.n621.de+00000000+BOvN63jn/bLvkieywe8R6UYAtVtNbZpXh34x7onlmtw2",
		},
	];
	for (const test of tests) {
		it(test.name, () => {
			if (test.wantErr === undefined) {
				expect(newVerifierForCosignatureV1(test.pubK).name()).toBe(test.pubK.split("+")[0]);
			} else {
				expect(() => newVerifierForCosignatureV1(test.pubK)).toThrow(test.wantErr);
			}
		});
	}
});

describe("TestCoSigV1Timestamp", () => {
	const tests: { name: string; sig: Signature; wantErr: boolean; wantTime?: bigint }[] = [
		{
			name: "works",
			sig: {
				name: "",
				hash: 0,
				base64:
					"ZGhGuQAAAABm/qTPeyKXD+R2rzyQsxPiP8mXum7qq/iF0u4vanlqJyocWODBt97w9uL+8qT7S5gxEHWWOworDcFiEBYJXORmnFBOBA==",
			},
			wantErr: false,
			wantTime: 1727964367n,
		},
		{
			name: "wrong type of signature",
			sig: {
				name: "",
				hash: 0,
				base64: "eQjRQm6eSKzFoiYalgwCPXu2y3ijtg68is9M46JKxuZB+dRfTmeQeDBoXnvxZx2ugnkyV+MUMLXpWs1hPb/W/4xkNQY=",
			},
			wantErr: true,
		},
		{
			name: "gibberish",
			sig: { name: "", hash: 0, base64: "5%/$!\n 2" },
			wantErr: true,
		},
	];
	for (const test of tests) {
		it(test.name, () => {
			let gotTime: bigint;
			try {
				gotTime = coSigV1Timestamp(test.sig);
			} catch (err) {
				expect(test.wantErr, `got error ${String(err)}, want err: ${test.wantErr}`).toBe(true);
				return;
			}
			expect(test.wantErr, `got no error, want err: ${test.wantErr}`).toBe(false);
			expect(gotTime).toBe(test.wantTime);
		});
	}

	// Port addition: the whole uint64 range of the timestamp field, read as Go's int64(...)
	// conversion reads it, including values no JavaScript Date can represent.
	const extremes: [string, bigint, bigint][] = [
		["0", 0n, 0n],
		["2^31", 2n ** 31n, 2n ** 31n],
		["2^53", 2n ** 53n, 2n ** 53n],
		["2^63-1", 2n ** 63n - 1n, 2n ** 63n - 1n],
		["2^63", 2n ** 63n, -(2n ** 63n)],
		["2^64-1", 2n ** 64n - 1n, -1n],
	];
	for (const [name, field, want] of extremes) {
		it(`reads a timestamp field of ${name} as int64 ${want}`, () => {
			const raw = new Uint8Array(4 + 8 + 64);
			new DataView(raw.buffer).setBigUint64(4, field);
			expect(coSigV1Timestamp({ name: "w", hash: 0, base64: btoa(String.fromCharCode(...raw)) })).toBe(want);
		});
	}
});

describe("TestVKeyToCosignatureV1", () => {
	it("converts a standard vkey into one that verifies cosignature/v1 signatures", () => {
		const { skey, vkey } = generateKey(undefined, "TestKey");
		const cosigner = newSignerForCosignatureV1(skey);
		const covkey = vKeyToCosignatureV1(vkey);
		const workingVKeys = [vkey, covkey];
		const n = sign({ text: "Note\n\n" }, cosigner);
		for (const k of workingVKeys) {
			const coverifier = newVerifierForCosignatureV1(k);
			expect(() => open(n, verifierList(coverifier)), `Failed to open note with verifier ${k}`).not.toThrow();
		}

		const v = newVerifier(vkey);
		// Now check that the standard vkey cannot open a cosig signature.
		expect(() => open(n, verifierList(v))).toThrow();
	});
});

// Port addition: the four upstream cases above prove acceptance (a valid
// cosignature/v1 signature opens) and reject two *malformed* inputs -- TestVerifierInvalidSig
// opens "nobbled" (not a note at all), and TestSigCoversExtensionLines modifies the note's
// final byte, which lands on the signature's base64 padding, so open() fails at base64
// decoding ("malformed note") before ever reaching the Ed25519 check. Neither exercises
// verifyCosigV1's *cryptographic* rejection: a well-formed, cleanly-decoding 72-byte
// timestamp||Ed25519-sig that simply does not verify against the message it is checked
// against. That is the exact failure mode a witness cosigning bug would take -- accepting a
// checkpoint as validly cosigned when it is not -- so this case pins it directly. See
// docs/decisions/0071-formats-note-cosigv1-partial-port.md's review notes.
describe("verifyCosigV1 rejects a well-formed but cryptographically invalid signature", () => {
	it("rejects a genuine cosignature/v1 signature once the signed message is altered", () => {
		const { skey } = generateKey(undefined, "test");
		const s = newSignerForCosignatureV1(skey);

		const msg = "test\n123\nf+7CoKgXKE/tNys9TTXcr/ad6U/K3xvznmzew9y6SP0=\n";
		const n = sign({ text: msg }, s);

		// Flip the first byte of the note text ('t' -> 'T'). The signature line is left
		// intact and still base64-decodes to a valid 72-byte timestamp||Ed25519-sig, so
		// open() reaches verifyCosigV1, which reconstructs the now-different cosigned
		// message; its Ed25519 check returns false because the signature no longer matches.
		n[0] = "T".charCodeAt(0);
		expect(() => open(n, verifierList(s.verifier()))).toThrow();
	});
});

// Port addition: formatCosignatureV1 counts newlines rather than splitting the message (see
// its Port note); these pin the boundary Go's `len(bytes.Split(msg, "\n")) < 3` draws.
describe("formatCosignatureV1 needs at least three lines", () => {
	it("refuses to sign or verify a note of fewer than three lines, and accepts three", () => {
		const { skey } = generateKey(undefined, "test");
		const s = newSignerForCosignatureV1(skey);
		expect(() => sign({ text: "one line\n" }, s)).toThrow("cosigned note format invalid");
		expect(() => s.sign(new TextEncoder().encode("no newline"))).toThrow("cosigned note format invalid");
		// "a\n\n" splits into "a", "" and "": three lines.
		expect(() => open(sign({ text: "a\n\n" }, s), verifierList(s.verifier()))).not.toThrow();
		expect(s.verifier().verify(new TextEncoder().encode("a\n"), new Uint8Array(72))).toBe(false);
	});
});

// Port addition: the verifier constructor refuses keys that verify signatures nobody made,
// as note.ts's newVerifier does (see the Port note in newVerifierForCosignatureV1).
describe("newVerifierForCosignatureV1 refuses unsafe Ed25519 public keys", () => {
	const vkeyFor = (alg: number, key: Uint8Array): string =>
		`w.example+00000000+${btoa(String.fromCharCode(alg, ...key))}`;
	// The identity point: small order.
	const identity = new Uint8Array(32);
	identity[0] = 1;
	// The identity point with its sign bit set: a non-canonical encoding of a point.
	const nonCanonical = new Uint8Array(identity);
	nonCanonical[31] = 0x80;

	for (const alg of [1, 4]) {
		it(`refuses a small-order key (algorithm ${alg})`, () => {
			expect(() => newVerifierForCosignatureV1(vkeyFor(alg, identity))).toThrow("small-order");
		});
		it(`refuses a non-canonical key (algorithm ${alg})`, () => {
			expect(() => newVerifierForCosignatureV1(vkeyFor(alg, nonCanonical))).toThrow(/small-order|canonical/);
		});
	}

	it("accepts a generated key", () => {
		const { vkey } = generateKey(undefined, "w.example");
		expect(() => newVerifierForCosignatureV1(vkey)).not.toThrow();
	});
});
