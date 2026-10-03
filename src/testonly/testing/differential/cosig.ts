// Copyright 2026 MedDeck. All Rights Reserved.
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

// Differential suite for formats/note cosignature/v1 over fixtures/data/differential_cosig.json
// (fixtures/gen/differential_cosig.go).

import { describe, it } from "vitest";
import {
	coSigV1Timestamp,
	newSignerForCosignatureV1,
	newVerifierForCosignatureV1,
	vKeyToCosignatureV1,
} from "../../../vendor/formats/note/note_cosigv1.ts";
import {
	InvalidSignatureError,
	newVerifier,
	open,
	UnverifiedNoteError,
	verifierList,
} from "../../../vendor/note/note.ts";
import { hexToBytes, loadFixture } from "../../fixtures.ts";
import { attempt, canonical, DifferentialReport, messageOf } from "../differential.ts";

type KeyRow = readonly [
	name: string,
	skey: string,
	vkey: string,
	cosigVKey: string,
	signerName: string,
	signerHash: number,
	verifierHash: number,
];

interface CosigCorpus {
	readonly keys: readonly KeyRow[];
	readonly sign: readonly (readonly [key: number, msg: string, unix: string, sig: string])[];
	readonly signError: readonly (readonly [key: number, msg: string, err: string])[];
	readonly verify: readonly (readonly [key: number, msg: string, sig: string, plain: number, cosig: number])[];
	readonly timestamp: readonly (readonly [b64: string, err: string, unix?: string])[];
	readonly open: readonly (readonly [
		key: number,
		msg: string,
		verifier: "cosig" | "plain",
		kind: string,
		err: string,
	])[];
}

/**
 * withClock runs f with Date.now() reading unixSeconds, the clock the cosignature/v1
 * signer stamps its signatures with.
 */
function withClock<T>(unixSeconds: bigint, f: () => T): T {
	const now = Date.now;
	Date.now = () => Number(unixSeconds) * 1000;
	try {
		return f();
	} finally {
		Date.now = now;
	}
}

/** describeCosigDifferential registers the cosignature/v1 differential tests. */
export function describeCosigDifferential(): void {
	describe("formats/note cosignature/v1 differential (differential_cosig.json)", () => {
		it("keys: signer name and key hashes, and vKeyToCosignatureV1, match Go", async () => {
			const f = await loadFixture<CosigCorpus>("differential_cosig");
			const rep = new DifferentialReport("cosignature/v1 keys");
			for (const [name, skey, vkey, cosigVKey, signerName, signerHash, verifierHash] of f.keys) {
				rep.record();
				const s = newSignerForCosignatureV1(skey);
				rep.equal(name, "signer name", signerName, s.name());
				rep.equal(name, "signer keyHash", signerHash, s.keyHash());
				rep.equal(name, "signer verifier keyHash", verifierHash, s.verifier().keyHash());
				rep.equal(name, "vKeyToCosignatureV1", cosigVKey, vKeyToCosignatureV1(vkey));
			}
			rep.assertClean(5);
		});

		it("sign: produces, at each fixed second, the one signature Go's verifier accepts", async () => {
			const f = await loadFixture<CosigCorpus>("differential_cosig");
			const rep = new DifferentialReport("cosignature/v1 sign");
			for (const [key, msg, unix, sig] of f.sign) {
				rep.record();
				const s = newSignerForCosignatureV1((f.keys[key] as KeyRow)[1]);
				const got = attempt(() => withClock(BigInt(unix), () => s.sign(hexToBytes(msg))));
				rep.equal(`key=${key} msg=${msg} t=${unix}`, "sig", sig, got.ok ? got.value : `throws ${messageOf(got.error)}`);
			}
			for (const [key, msg, err] of f.signError) {
				rep.record();
				const s = newSignerForCosignatureV1((f.keys[key] as KeyRow)[1]);
				const got = attempt(() => s.sign(hexToBytes(msg)));
				rep.equal(`key=${key} msg=${msg}`, "err", err, got.ok ? "accepted" : messageOf(got.error));
			}
			rep.assertClean(300);
		});

		it("verify: reaches Go's verdict over honest and tampered signatures, with both key encodings", async () => {
			const f = await loadFixture<CosigCorpus>("differential_cosig");
			const rep = new DifferentialReport("cosignature/v1 verify");
			const plain = f.keys.map((k) => newVerifierForCosignatureV1(k[2]));
			const cosig = f.keys.map((k) => newVerifierForCosignatureV1(k[3]));
			for (const [key, msg, sig, p, c] of f.verify) {
				rep.record();
				const m = hexToBytes(msg);
				const s = hexToBytes(sig);
				const rid = `key=${key} msg=${msg} sig=${sig}`;
				rep.equal(rid, "verify (vkey)", p === 1, plain[key]?.verify(m, s));
				rep.equal(rid, "verify (cosignature vkey)", c === 1, cosig[key]?.verify(m, s));
			}
			rep.assertClean(2500);
		});

		it("coSigV1Timestamp returns Go's int64 seconds or error", async () => {
			const f = await loadFixture<CosigCorpus>("differential_cosig");
			const rep = new DifferentialReport("coSigV1Timestamp");
			for (const [b64, err, unix] of f.timestamp) {
				rep.record();
				const got = attempt(() => coSigV1Timestamp({ name: "", hash: 0, base64: b64 }));
				rep.equal(
					`base64=${JSON.stringify(b64)}`,
					"timestamp",
					err === "" ? `ok:${unix}` : `err:${err}`,
					got.ok ? `ok:${canonical(got.value).replaceAll('"', "")}` : `err:${messageOf(got.error)}`,
				);
			}
			rep.assertClean(40);
		});

		it("cosigned notes open with the cosignature/v1 verifier and not with a plain Ed25519 one, as in Go", async () => {
			const f = await loadFixture<CosigCorpus>("differential_cosig");
			const rep = new DifferentialReport("cosigned notes");
			for (const [key, msg, which, kind, err] of f.open) {
				rep.record();
				const k = f.keys[key] as KeyRow;
				const v = which === "cosig" ? newVerifierForCosignatureV1(k[3]) : newVerifier(k[2]);
				const got = attempt(() => open(hexToBytes(msg), verifierList(v)));
				const tsKind = got.ok
					? "ok"
					: got.error instanceof UnverifiedNoteError
						? "unverified"
						: got.error instanceof InvalidSignatureError
							? "invalid"
							: "other";
				const rid = `key=${key} msg=${msg} verifier=${which}`;
				rep.equal(rid, "kind", kind, tsKind);
				rep.equal(rid, "err", err, got.ok ? "" : messageOf(got.error));
			}
			rep.assertClean(80);
		});
	});
}
