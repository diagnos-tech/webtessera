// Copyright 2023 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in LICENSES/BSD-3-Clause-Go.txt.
//
// Ported from github.com/transparency-dev/formats/note/note_cosigv1_test.go
// @ v0.0.0-20251017110053-404c0d5b696c
// (see note_cosigv1.ts for why this file carries the Go Authors' notice)
//
// Port note: only the 4 upstream cases that exercise newSignerForCosignatureV1 /
// newVerifierForCosignatureV1 directly are ported here. Not ported, because the
// functions they exercise are out of scope for this narrow vendor port (see
// note_cosigv1.ts's header comment and docs/decisions/0071-formats-note-cosigv1-partial-port.md):
// TestCoSigV1NewVerifier and TestVKeyToCosignatureV1 call the general `NewVerifier`
// dispatcher and `VKeyToCosignatureV1`; TestCoSigV1Timestamp calls `CoSigV1Timestamp`.

import { describe, expect, it } from "vitest";
import { generateKey, open, sign, verifierList } from "../../note/note.ts";
import { newSignerForCosignatureV1, newVerifierForCosignatureV1 } from "./note_cosigv1.ts";

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
