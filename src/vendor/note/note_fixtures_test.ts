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

// Golden-fixture tests for sumdb/note. Every expected value in fixtures/data/note.json
// was produced by running the real golang.org/x/mod/sumdb/note; see PORTING.md §5.
//
// The ported upstream tests in note_test.ts prove the port agrees with the vectors the
// Go authors wrote down. These prove it agrees with the Go implementation itself, over
// a much wider set of inputs — in particular every rejection path, which is where a
// verifier is most dangerous when it is wrong.

import { beforeAll, describe, expect, it } from "vitest";
import { bytesEqual, fromUTF8, toBase64 } from "../../internal/gostd/bytes.ts";
import { hexToBytes, loadFixture } from "../../testonly/fixtures.ts";
import {
	InvalidSignatureError,
	newEd25519VerifierKey,
	newSigner,
	newVerifier,
	open,
	type Signature,
	type Signer,
	sign,
	UnverifiedNoteError,
	type Verifier,
	verifierList,
} from "./note.ts";

interface FixtureKey {
	readonly name: string;
	readonly skey: string;
	readonly vkey: string;
	readonly keyHash: string;
	readonly keyHashHex: string;
	readonly publicKey: string;
	readonly algPublicKey: string;
	readonly seed: string;
}

interface FixtureSig {
	readonly name: string;
	readonly hash: string;
	readonly base64: string;
}

interface NoteFixture {
	readonly keys: readonly FixtureKey[];
	readonly algEd25519: number;
	readonly sigSplit: string;
	readonly sigPrefix: string;
	readonly maxSignatures: number;
	readonly keyHash: ReadonlyArray<{
		readonly name: string;
		readonly key: string;
		readonly want: string;
		readonly hex: string;
	}>;
	readonly newEd25519VerifierKey: ReadonlyArray<{
		readonly name: string;
		readonly publicKey: string;
		readonly want: string;
		readonly wantErr: boolean;
		readonly wantErrMsg: string;
	}>;
	readonly newVerifier: ReadonlyArray<{
		readonly vkey: string;
		readonly wantName: string;
		readonly wantHash: string;
		readonly wantErr: boolean;
		readonly wantErrMsg: string;
	}>;
	readonly newSigner: ReadonlyArray<{
		readonly skey: string;
		readonly wantName: string;
		readonly wantHash: string;
		readonly wantErr: boolean;
		readonly wantErrMsg: string;
	}>;
	readonly sign: ReadonlyArray<{
		readonly desc: string;
		readonly text: string;
		readonly signers: readonly string[];
		readonly existingSigs: readonly FixtureSig[];
		readonly want: string;
		readonly wantText: string;
		readonly wantErr: boolean;
		readonly wantErrMsg: string;
	}>;
	readonly open: ReadonlyArray<{
		readonly desc: string;
		readonly msg: string;
		readonly verifiers: readonly string[];
		readonly wantText: string;
		readonly wantSigs: readonly FixtureSig[];
		readonly wantUnverifiedSigs: readonly FixtureSig[];
		readonly wantErr: boolean;
		readonly wantErrMsg: string;
		readonly wantErrKind: string;
	}>;
}

/** toSignature decodes a fixture signature into the port's Signature shape. */
function toSignature(s: FixtureSig): Signature {
	return { name: s.name, hash: Number(s.hash), base64: s.base64 };
}

describe("sumdb/note golden fixtures", () => {
	let fx: NoteFixture;
	/** signerFor maps a verifier key back to a Signer, the way the fixture indexes them. */
	let signerFor: Map<string, Signer>;

	beforeAll(async () => {
		fx = await loadFixture<NoteFixture>("note");
		signerFor = new Map<string, Signer>();
		for (const k of fx.keys) {
			signerFor.set(k.vkey, newSigner(k.skey));
		}
	});

	it("agrees on the key hash preimage", () => {
		expect(fx.keyHash.length).toBeGreaterThan(0);
		for (const c of fx.keyHash) {
			// The key hash is not exported, so it is checked through the two public
			// surfaces that commit to it: the verifier key encoding and newVerifier.
			const vkey = newEd25519VerifierKey(c.name, hexToBytes(c.key).subarray(1));
			expect(vkey, c.name).toBe(`${c.name}+${c.hex}+${btoaHex(c.key)}`);
			expect(newVerifier(vkey).keyHash(), c.name).toBe(Number(c.want));
		}
	});

	it("agrees on the wire constants", () => {
		expect(fx.algEd25519).toBe(1);
		expect(fx.sigSplit).toBe("0a0a");
		expect(fx.sigPrefix).toBe("e2809420");
		expect(fx.maxSignatures).toBe(100);
	});

	it("newEd25519VerifierKey", () => {
		expect(fx.newEd25519VerifierKey.length).toBeGreaterThan(0);
		for (const c of fx.newEd25519VerifierKey) {
			const label = `${c.name}/${c.publicKey.length / 2} bytes`;
			if (c.wantErr) {
				expect(() => newEd25519VerifierKey(c.name, hexToBytes(c.publicKey)), label).toThrow(c.wantErrMsg);
				continue;
			}
			expect(newEd25519VerifierKey(c.name, hexToBytes(c.publicKey)), label).toBe(c.want);
		}
	});

	it("newVerifier", () => {
		expect(fx.newVerifier.length).toBeGreaterThan(0);
		for (const c of fx.newVerifier) {
			if (c.wantErr) {
				expect(() => newVerifier(c.vkey), c.vkey).toThrow(c.wantErrMsg);
				continue;
			}
			const v = newVerifier(c.vkey);
			expect(v.name(), c.vkey).toBe(c.wantName);
			expect(v.keyHash(), c.vkey).toBe(Number(c.wantHash));
		}
	});

	it("newSigner", () => {
		expect(fx.newSigner.length).toBeGreaterThan(0);
		for (const c of fx.newSigner) {
			if (c.wantErr) {
				expect(() => newSigner(c.skey), c.skey).toThrow(c.wantErrMsg);
				continue;
			}
			const s = newSigner(c.skey);
			expect(s.name(), c.skey).toBe(c.wantName);
			expect(s.keyHash(), c.skey).toBe(Number(c.wantHash));
		}
	});

	it("sign produces byte-identical output", () => {
		expect(fx.sign.length).toBeGreaterThan(0);
		for (const c of fx.sign) {
			const signers = c.signers.map((vkey) => {
				const s = signerFor.get(vkey);
				expect(s, `${c.desc}: fixture references unknown signer ${vkey}`).toBeDefined();
				return s as Signer;
			});
			const note = {
				text: c.text,
				sigs: c.existingSigs.map(toSignature),
			};

			if (c.wantErr) {
				expect(() => sign(note, ...signers), c.desc).toThrow(c.wantErrMsg);
				continue;
			}

			const got = sign(note, ...signers);
			expect(bytesEqual(got, hexToBytes(c.want)), `${c.desc}:\n${fromUTF8(got)}`).toBe(true);
			// The fixture also carries the message as text, which pins the UTF-8
			// round trip independently of the hex.
			expect(fromUTF8(got), c.desc).toBe(c.wantText);
		}
	});

	it("open accepts and rejects exactly what Go does", () => {
		expect(fx.open.length).toBeGreaterThan(0);
		for (const c of fx.open) {
			const verifiers = verifierList(...c.verifiers.map((vkey): Verifier => newVerifier(vkey)));
			const msg = hexToBytes(c.msg);

			if (!c.wantErr) {
				const n = open(msg, verifiers);
				expect(n.text, c.desc).toBe(c.wantText);
				expect(n.sigs ?? [], c.desc).toEqual(c.wantSigs.map(toSignature));
				expect(n.unverifiedSigs ?? [], c.desc).toEqual(c.wantUnverifiedSigs.map(toSignature));
				continue;
			}

			let thrown: unknown;
			try {
				open(msg, verifiers);
			} catch (e) {
				thrown = e;
			}
			expect(thrown, `${c.desc}: expected a rejection`).toBeDefined();
			expect((thrown as Error).message, c.desc).toBe(c.wantErrMsg);

			switch (c.wantErrKind) {
				case "UnverifiedNoteError": {
					expect(thrown, c.desc).toBeInstanceOf(UnverifiedNoteError);
					// The note has to be reachable through the error, with the
					// unverified signatures the log's clients need in order to see who
					// signed something they cannot check.
					const n = (thrown as UnverifiedNoteError).note;
					expect(n.text, c.desc).toBe(c.wantText);
					expect(n.sigs ?? [], c.desc).toEqual([]);
					expect(n.unverifiedSigs ?? [], c.desc).toEqual(c.wantUnverifiedSigs.map(toSignature));
					break;
				}
				case "InvalidSignatureError":
					expect(thrown, c.desc).toBeInstanceOf(InvalidSignatureError);
					break;
				default:
					// A plain error: it must not be one of the structured ones, or a
					// caller switching on the type would take the wrong branch.
					expect(thrown, c.desc).not.toBeInstanceOf(UnverifiedNoteError);
					expect(thrown, c.desc).not.toBeInstanceOf(InvalidSignatureError);
					break;
			}
		}
	});

	it("covers every rejection path the fixture records", () => {
		// A guard against the fixture being regenerated with the negative cases
		// dropped: the value of this file is almost entirely in them.
		const rejections = fx.open.filter((c) => c.wantErr).length;
		expect(rejections).toBeGreaterThanOrEqual(20);
	});
});

/** btoaHex re-encodes a hex-encoded key as the base64 a verifier key carries. */
function btoaHex(hex: string): string {
	return toBase64(hexToBytes(hex));
}
