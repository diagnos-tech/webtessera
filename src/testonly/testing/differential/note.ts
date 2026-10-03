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

// Differential suites for sumdb/note and formats/note keys over
// fixtures/data/differential_note_{keys,open,sign}.json (fixtures/gen/differential_note.go).

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, it } from "vitest";
import { toUTF8 } from "../../../internal/gostd/bytes.ts";
import type { Reader } from "../../../internal/gostd/io.ts";
import {
	newSignerForCosignatureV1,
	newVerifierForCosignatureV1,
	vKeyToCosignatureV1,
} from "../../../vendor/formats/note/note_cosigv1.ts";
import {
	generateKey,
	InvalidSignatureError,
	type Note,
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
} from "../../../vendor/note/note.ts";
import { hexToBytes, loadFixture } from "../../fixtures.ts";
import { attempt, DifferentialReport, messageOf, type Outcome } from "../differential.ts";

/** A constructor result as the corpus spells it: [err] or ["", name, keyHash]. */
type NameResult = readonly [err: string] | readonly [err: "", name: string, hash: number];

interface KeysCorpus {
	readonly verifier: readonly (readonly [
		vkey: string,
		note: NameResult,
		cosig: NameResult,
		toCosig: readonly [string] | readonly ["", string],
	])[];
	readonly signer: readonly (readonly [skey: string, note: NameResult, cosig: NameResult])[];
	readonly encode: readonly (readonly [name: string, key: string, err: string, vkey?: string])[];
	readonly generate: readonly (readonly [name: string, seed: string, err: string, skey?: string, vkey?: string])[];
}

type GoSig = readonly [name: string, hash: number, base64: string];

interface OpenCorpus {
	readonly verifierKeys: readonly string[];
	readonly cases: readonly (
		| readonly [msg: string, mask: number, kind: "invalid" | "other", err: string]
		| readonly [
				msg: string,
				mask: number,
				kind: "ok" | "unverified",
				err: string,
				textLen: number,
				sigs: readonly GoSig[],
				unverified: readonly GoSig[],
		  ]
	)[];
}

interface SignCorpus {
	readonly signers: readonly (readonly [name: string, seed: string, hash: number])[];
	readonly cases: readonly (readonly [
		text: string,
		sigs: readonly GoSig[],
		unverified: readonly GoSig[],
		signers: readonly number[],
		err: string,
		msg?: string,
	])[];
}

function checkNameResult(
	rep: DifferentialReport,
	rid: string,
	field: string,
	go: NameResult,
	got: Outcome<{ name(): string; keyHash(): number }>,
): void {
	if (go[0] !== "") {
		if (got.ok) {
			rep.fail(rid, `${field}: go rejected (${go[0]}), ts accepted`);
		} else {
			rep.equal(rid, `${field} err`, go[0], messageOf(got.error));
		}
		return;
	}
	if (!got.ok) {
		rep.fail(rid, `${field}: go accepted, ts rejected: ${messageOf(got.error)}`);
		return;
	}
	rep.equal(rid, `${field} name`, go[1], got.value.name());
	rep.equal(rid, `${field} keyHash`, go[2], got.value.keyHash());
}

function toGoSigs(sigs: readonly Signature[] | undefined): GoSig[] {
	return (sigs ?? []).map((s) => [s.name, s.hash, s.base64] as const);
}

function fromGoSigs(sigs: readonly GoSig[]): Signature[] {
	return sigs.map(([name, hash, base64]) => ({ name, hash, base64 }));
}

/** describeNoteDifferential registers the note key, open and sign differential tests. */
export function describeNoteDifferential(): void {
	describe("sumdb/note differential (differential_note_*.json)", () => {
		it("verifier keys: newVerifier, newVerifierForCosignatureV1 and vKeyToCosignatureV1 reach Go's verdict", async () => {
			const f = await loadFixture<KeysCorpus>("differential_note_keys");
			const rep = new DifferentialReport("verifier keys");
			for (const [vkey, noteRes, cosigRes, toCosig] of f.verifier) {
				rep.record();
				const rid = `vkey=${JSON.stringify(vkey)}`;
				checkNameResult(
					rep,
					rid,
					"newVerifier",
					noteRes,
					attempt(() => newVerifier(vkey)),
				);
				checkNameResult(
					rep,
					rid,
					"newVerifierForCosignatureV1",
					cosigRes,
					attempt(() => newVerifierForCosignatureV1(vkey)),
				);
				const tc = attempt(() => vKeyToCosignatureV1(vkey));
				if (toCosig[0] !== "") {
					rep.equal(
						rid,
						"vKeyToCosignatureV1",
						`err:${toCosig[0]}`,
						tc.ok ? `ok:${tc.value}` : `err:${messageOf(tc.error)}`,
					);
				} else {
					rep.equal(
						rid,
						"vKeyToCosignatureV1",
						`ok:${toCosig[1]}`,
						tc.ok ? `ok:${tc.value}` : `err:${messageOf(tc.error)}`,
					);
				}
			}
			rep.assertClean(3000);
		});

		it("signer keys: newSigner and newSignerForCosignatureV1 reach Go's verdict", async () => {
			const f = await loadFixture<KeysCorpus>("differential_note_keys");
			const rep = new DifferentialReport("signer keys");
			for (const [skey, noteRes, cosigRes] of f.signer) {
				rep.record();
				const rid = `skey=${JSON.stringify(skey)}`;
				checkNameResult(
					rep,
					rid,
					"newSigner",
					noteRes,
					attempt(() => newSigner(skey)),
				);
				checkNameResult(
					rep,
					rid,
					"newSignerForCosignatureV1",
					cosigRes,
					attempt(() => newSignerForCosignatureV1(skey)),
				);
			}
			rep.assertClean(800);
		});

		it("newEd25519VerifierKey and generateKey produce Go's keys", async () => {
			const f = await loadFixture<KeysCorpus>("differential_note_keys");
			const rep = new DifferentialReport("key encoders");
			for (const [name, key, err, vkey] of f.encode) {
				rep.record();
				const got = attempt(() => newEd25519VerifierKey(name, hexToBytes(key)));
				rep.equal(
					`name=${JSON.stringify(name)} key=${key}`,
					"newEd25519VerifierKey",
					err === "" ? `ok:${vkey}` : `err:${err}`,
					got.ok ? `ok:${got.value}` : `err:${messageOf(got.error)}`,
				);
			}
			for (const [name, seed, err, skey, vkey] of f.generate) {
				rep.record();
				const bytes = hexToBytes(seed);
				let off = 0;
				const reader: Reader = {
					read(p: Uint8Array): number {
						const n = Math.min(p.length, bytes.length - off);
						p.set(bytes.subarray(off, off + n));
						off += n;
						return n;
					},
				};
				const got = attempt(() => generateKey(reader, name));
				rep.equal(
					`name=${JSON.stringify(name)} seed=${seed}`,
					"generateKey",
					err === "" ? `ok:${skey} ${vkey}` : `err:${err}`,
					got.ok ? `ok:${got.value.skey} ${got.value.vkey}` : `err:${messageOf(got.error)}`,
				);
			}
			rep.assertClean(140);
		});

		it("open reaches Go's verdict, error kind and text, and signature lists", async () => {
			const f = await loadFixture<OpenCorpus>("differential_note_open");
			const rep = new DifferentialReport("note.open");
			const verifiers = f.verifierKeys.map((k) => newVerifier(k));
			for (const row of f.cases) {
				rep.record();
				const [msg, mask, kind, err] = row;
				const vs: Verifier[] = verifiers.filter((_, i) => (mask & (1 << i)) !== 0);
				if ((mask & (1 << verifiers.length)) !== 0) {
					vs.push(verifiers[0] as Verifier);
				}
				const raw = hexToBytes(msg);
				const got = attempt(() => open(raw, verifierList(...vs)));
				const rid = `msg=${msg} mask=${mask}`;
				let tsKind: string;
				let note: Note | undefined;
				if (got.ok) {
					tsKind = "ok";
					note = got.value;
				} else if (got.error instanceof UnverifiedNoteError) {
					tsKind = "unverified";
					note = got.error.note;
				} else if (got.error instanceof InvalidSignatureError) {
					tsKind = "invalid";
				} else {
					tsKind = "other";
				}
				if (!rep.equal(rid, "kind", kind, tsKind)) {
					continue;
				}
				rep.equal(rid, "err", err, got.ok ? "" : messageOf(got.error));
				if (row.length === 7 && note !== undefined) {
					const [, , , , textLen, sigs, unverified] = row;
					rep.equal(rid, "text", raw.subarray(0, textLen), toUTF8(note.text));
					rep.equal(rid, "sigs", sigs, toGoSigs(note.sigs));
					rep.equal(rid, "unverifiedSigs", unverified, toGoSigs(note.unverifiedSigs));
				}
			}
			rep.assertClean(1500);
		});

		it("sign produces Go's exact bytes or error", async () => {
			const f = await loadFixture<SignCorpus>("differential_note_sign");
			const rep = new DifferentialReport("note.sign");
			const signers: Signer[] = f.signers.map(([name, seed, hash]) => {
				const sk = hexToBytes(seed);
				return { name: () => name, keyHash: () => hash, sign: (m: Uint8Array) => ed25519.sign(m, sk) };
			});
			for (const [text, sigs, unverified, idx, err, msg] of f.cases) {
				rep.record();
				const n: Note = { text, sigs: fromGoSigs(sigs), unverifiedSigs: fromGoSigs(unverified) };
				const got = attempt(() => sign(n, ...idx.map((i) => signers[i] as Signer)));
				rep.equal(
					`text=${JSON.stringify(text)} sigs=${JSON.stringify(sigs)} unverified=${JSON.stringify(unverified)} signers=${idx}`,
					"sign",
					err === "" ? `ok:${msg}` : `err:${err}`,
					got.ok ? `ok:${toHex(got.value)}` : `err:${messageOf(got.error)}`,
				);
			}
			rep.assertClean(1400);
		});
	});
}

function toHex(b: Uint8Array): string {
	return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
}
