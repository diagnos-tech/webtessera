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

// Tests for offline receipt verification: one test per step of tlog-proof's verification
// procedure, each with the receipt that passes it and the ones that must not.

import { describe, expect, it } from "vitest";
import { fromUTF8, toUTF8 } from "../internal/gostd/bytes.ts";
import { Checkpoint } from "../vendor/formats/log/index.ts";
import { newSignerForCosignatureV1, vKeyToCosignatureV1 } from "../vendor/formats/note/note_cosigv1.ts";
import { TLogProof } from "../vendor/formats/proof/tlog_proof.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import { Tree } from "../vendor/merkle/testonly/tree.ts";
import { generateKey, newSigner, newVerifier, open, sign, verifierList } from "../vendor/note/note.ts";
import { newWitness, newWitnessGroup, newWitnessGroupFromPolicy } from "../witness.ts";
import { parseReceipt, ReceiptError, verifyReceipt } from "./receipt.ts";

const origin = "example.com/log";
const log = generateKey(undefined, origin);
const otherLog = generateKey(undefined, origin);
const w1 = generateKey(undefined, "witness1.example");
const w2 = generateKey(undefined, "witness2.example");
const w3 = generateKey(undefined, "witness3.example");

const entries = Array.from({ length: 13 }, (_, i) => toUTF8(`entry ${i}`));
const tree = new Tree(DefaultHasher);
tree.appendData(...entries);

/** checkpointOf signs the tree's checkpoint with the log key, then cosigns it with each witness. */
function checkpointOf(skey: string, ...witnessSkeys: string[]): Uint8Array {
	const text = fromUTF8(new Checkpoint({ origin, size: tree.size(), hash: tree.hash() }).marshal());
	let cp = sign({ text }, newSigner(skey));
	for (const w of witnessSkeys) {
		const n = open(cp, verifierList(newVerifier(log.vkey)));
		cp = sign(n, newSignerForCosignatureV1(w));
	}
	return cp;
}

/** withProof copies a proof with some of its fields replaced. */
function withProof(p: TLogProof, change: { index?: bigint; hashes?: Uint8Array[] }): TLogProof {
	return new TLogProof({ index: change.index ?? p.index, hashes: change.hashes ?? p.hashes, checkpoint: p.checkpoint });
}

function proofFor(index: bigint, cp: Uint8Array, extraData?: Uint8Array): TLogProof {
	return new TLogProof({
		index,
		hashes: tree.inclusionProof(index, tree.size()),
		checkpoint: cp,
		...(extraData === undefined ? {} : { extraData }),
	});
}

function failure(fn: () => unknown): ReceiptError {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ReceiptError);
		return err as ReceiptError;
	}
	throw new Error("expected a ReceiptError");
}

describe("verifyReceipt", () => {
	const cp = checkpointOf(log.skey);

	it("verifies every entry's receipt, as text, bytes or a TLogProof, from data or leaf hash", () => {
		for (let i = 0n; i < tree.size(); i++) {
			const proof = proofFor(i, cp);
			const data = entries[Number(i)] as Uint8Array;
			for (const r of [proof, proof.marshal(), fromUTF8(proof.marshal())]) {
				const v = verifyReceipt(r, { vkey: log.vkey, data });
				expect(v.index).toBe(i);
				expect(v.checkpoint.size).toBe(13n);
				expect(v.checkpoint.origin).toBe(origin);
				expect(v.cosignedBy).toEqual([]);
			}
			expect(verifyReceipt(proof, { vkey: newVerifier(log.vkey), leafHash: tree.leafHash(i) }).index).toBe(i);
		}
	});

	it("verifies a Receipt made by another copy of the library through its text", () => {
		const foreign = { index: 2n, text: fromUTF8(proofFor(2n, cp).marshal()), proof: {} };
		expect(verifyReceipt(foreign as never, { vkey: log.vkey, data: entries[2] as Uint8Array }).index).toBe(2n);
		expect(() => verifyReceipt({} as never, { vkey: log.vkey, data: entries[2] as Uint8Array })).toThrow(
			"verifyReceipt takes a Receipt",
		);
	});

	it("returns the extra data, unauthenticated, as the proof carries it", () => {
		const extra = toUTF8("context");
		expect(
			verifyReceipt(proofFor(3n, cp, extra), { vkey: log.vkey, data: entries[3] as Uint8Array }).extraData,
		).toEqual(extra);
	});

	describe("step 1: the leaf hash", () => {
		it("needs exactly one of data and leafHash", () => {
			const proof = proofFor(0n, cp);
			expect(() => verifyReceipt(proof, { vkey: log.vkey })).toThrow(TypeError);
			expect(() =>
				verifyReceipt(proof, { vkey: log.vkey, data: entries[0] as Uint8Array, leafHash: tree.leafHash(0n) }),
			).toThrow("exactly one of data");
			expect(() => verifyReceipt(proof, { vkey: log.vkey, leafHash: new Uint8Array(31) })).toThrow("32-byte");
			expect(() => verifyReceipt(proof, { vkey: log.vkey, dataInExtra: false })).toThrow(/or dataInExtra: true/);
		});

		describe("with dataInExtra, from the extra line", () => {
			const entry = entries[6] as Uint8Array;
			const carrying = proofFor(6n, cp, entry);

			it("takes the entry from the extra line, and returns it once the inclusion proof binds it", () => {
				for (const r of [carrying, carrying.marshal(), fromUTF8(carrying.marshal())]) {
					const v = verifyReceipt(r, { vkey: log.vkey, dataInExtra: true });
					expect([v.index, v.data, v.extraData]).toEqual([6n, entry, entry]);
				}
				// Without dataInExtra the same receipt verifies as before, and data is not set.
				expect(verifyReceipt(carrying, { vkey: log.vkey, data: entry }).data).toBeUndefined();
			});

			it("checks the extra line against the data or leaf hash the verifier holds", () => {
				expect(verifyReceipt(carrying, { vkey: log.vkey, data: entry, dataInExtra: true }).data).toEqual(entry);
				expect(
					verifyReceipt(carrying, { vkey: log.vkey, leafHash: tree.leafHash(6n), dataInExtra: true }).data,
				).toEqual(entry);
				const other = failure(() =>
					verifyReceipt(carrying, { vkey: log.vkey, data: entries[7] as Uint8Array, dataInExtra: true }),
				);
				expect(other.reason).toBe("extra");
				expect(other.message).toMatch(
					/does not hold the entry it is checked against; it is the receipt of another entry/,
				);
				const otherHash = failure(() =>
					verifyReceipt(carrying, { vkey: log.vkey, leafHash: tree.leafHash(7n), dataInExtra: true }),
				);
				expect(otherHash.reason).toBe("extra");
				expect(otherHash.message).toMatch(/does not have the leaf hash it is checked against/);
				expect(() =>
					verifyReceipt(carrying, { vkey: log.vkey, data: entry, leafHash: tree.leafHash(6n), dataInExtra: true }),
				).toThrow(/at most one of data and leafHash/);
			});

			it("refuses a receipt with no extra line, and extra data that is not the logged entry", () => {
				const none = failure(() => verifyReceipt(proofFor(6n, cp), { vkey: log.vkey, dataInExtra: true }));
				expect(none.reason).toBe("extra");
				expect(none.message).toMatch(/has no extra line, but dataInExtra says it carries the entry/);

				// An extra line that is not the entry at that index: the proof cannot bind it.
				const swapped = failure(() =>
					verifyReceipt(proofFor(6n, cp, entries[7]), { vkey: log.vkey, dataInExtra: true }),
				);
				expect(swapped.reason).toBe("inclusion");
				// Changing one bit of the extra data is the same.
				const altered = proofFor(
					6n,
					cp,
					entry.map((b, i) => (i === 0 ? b ^ 1 : b)),
				);
				expect(failure(() => verifyReceipt(altered, { vkey: log.vkey, dataInExtra: true })).reason).toBe("inclusion");
				// And an extra line signed by no one is no better than the checkpoint it comes with.
				const forged = proofFor(6n, checkpointOf(otherLog.skey), entry);
				expect(failure(() => verifyReceipt(forged, { vkey: log.vkey, dataInExtra: true })).reason).toBe("signature");
				expect(() => verifyReceipt(carrying, { vkey: log.vkey, dataInExtra: "yes" as never })).toThrow(
					"dataInExtra must be true or false",
				);
			});
		});
	});

	describe("step 2: the log's origin and signature", () => {
		it("rejects a checkpoint signed by another key with the same name", () => {
			const err = failure(() =>
				verifyReceipt(proofFor(0n, checkpointOf(otherLog.skey)), { vkey: log.vkey, data: entries[0] as Uint8Array }),
			);
			expect(err.reason).toBe("signature");
			expect(err.message).toMatch(
				/not a checkpoint of example\.com\/log signed by .*verifying with the log's own vkey/,
			);
		});

		it("rejects a checkpoint of another origin", () => {
			const err = failure(() =>
				verifyReceipt(proofFor(0n, cp), {
					vkey: log.vkey,
					origin: "example.com/other",
					data: entries[0] as Uint8Array,
				}),
			);
			expect(err.reason).toBe("signature");
			expect(err.message).toContain('got Origin "example.com/log" but expected "example.com/other"');
		});

		it("rejects a checkpoint whose text was altered after signing", () => {
			const tampered = toUTF8(fromUTF8(cp).replace("\n13\n", "\n12\n"));
			const err = failure(() =>
				verifyReceipt(proofFor(0n, tampered), { vkey: log.vkey, data: entries[0] as Uint8Array }),
			);
			expect(err.reason).toBe("signature");
		});

		it("rejects a malformed vkey and a malformed receipt with what to fix", () => {
			expect(() => verifyReceipt(proofFor(0n, cp), { vkey: "nonsense", data: entries[0] as Uint8Array })).toThrow(
				/is not a note verifier key/,
			);
			const err = failure(() => verifyReceipt("not a proof", { vkey: log.vkey, data: entries[0] as Uint8Array }));
			expect(err.reason).toBe("malformed");
			expect(err.message).toContain("tlog proof missing expected header");
		});
	});

	describe("step 3: witness cosignatures and policy", () => {
		const cosigned = checkpointOf(log.skey, w1.skey, w2.skey);
		const data = entries[5] as Uint8Array;

		it("accepts a checkpoint that satisfies a k-of-n policy, and names its cosigners", () => {
			const v = verifyReceipt(proofFor(5n, cosigned), {
				vkey: log.vkey,
				data,
				witnesses: { threshold: 2, witnesses: [vKeyToCosignatureV1(w1.vkey), w2.vkey, w3.vkey] },
			});
			expect(v.cosignedBy).toEqual(["witness1.example", "witness2.example"]);
		});

		it("rejects a checkpoint that does not satisfy the policy, saying who cosigned", () => {
			const err = failure(() =>
				verifyReceipt(proofFor(5n, cosigned), {
					vkey: log.vkey,
					data,
					witnesses: { threshold: 3, witnesses: [w1.vkey, w2.vkey, w3.vkey] },
				}),
			);
			expect(err.reason).toBe("witnesses");
			expect(err.message).toContain("cosigned by witness1.example, witness2.example");
			const none = failure(() =>
				verifyReceipt(proofFor(5n, cp), { vkey: log.vkey, data, witnesses: { threshold: 1, witnesses: [w1.vkey] } }),
			);
			expect(none.message).toContain("none of its witnesses");
		});

		it("rejects a forged cosignature by a policy witness, even when the policy is otherwise met", () => {
			// w3's signature line, naming w3's key, with signature bytes that do not verify.
			const withW3 = fromUTF8(checkpointOf(log.skey, w1.skey, w3.skey));
			const forged = toUTF8(
				withW3.replace(
					/(— witness3\.example .{12})(.)/,
					(_, head: string, c: string) => head + (c === "A" ? "B" : "A"),
				),
			);
			const err = failure(() =>
				verifyReceipt(proofFor(5n, forged), {
					vkey: log.vkey,
					data,
					witnesses: { threshold: 1, witnesses: [w1.vkey, w3.vkey] },
				}),
			);
			expect(err.reason).toBe("signature");
		});

		it("accepts the WitnessGroups of the ported API, from newWitnessGroup and from a policy file", () => {
			const group = newWitnessGroup(
				2,
				newWitness(vKeyToCosignatureV1(w1.vkey), new URL("https://w1.example/")),
				newWitness(vKeyToCosignatureV1(w2.vkey), new URL("https://w2.example/")),
			);
			expect(verifyReceipt(proofFor(5n, cosigned), { vkey: log.vkey, data, witnesses: group }).cosignedBy).toHaveLength(
				2,
			);
			const policy = newWitnessGroupFromPolicy(
				toUTF8(
					[
						`witness w1 ${vKeyToCosignatureV1(w1.vkey)} https://w1.example/`,
						`witness w3 ${vKeyToCosignatureV1(w3.vkey)} https://w3.example/`,
						"group g any w1 w3",
						"quorum g",
					].join("\n"),
				),
			);
			expect(() => verifyReceipt(proofFor(5n, cosigned), { vkey: log.vkey, data, witnesses: policy })).not.toThrow();
		});

		it("refuses a policy that is neither shape", () => {
			expect(() =>
				verifyReceipt(proofFor(5n, cosigned), { vkey: log.vkey, data, witnesses: { threshold: 1 } as never }),
			).toThrow("witnesses must be a WitnessGroup");
		});
	});

	describe("step 4: the inclusion proof", () => {
		it("rejects the wrong data, a wrong index and a tampered proof", () => {
			const proof = proofFor(4n, cp);
			const cases: [string, () => unknown][] = [
				["wrong data", () => verifyReceipt(proof, { vkey: log.vkey, data: toUTF8("entry 5") })],
				[
					"wrong index",
					() => verifyReceipt(withProof(proof, { index: 5n }), { vkey: log.vkey, data: entries[4] as Uint8Array }),
				],
				[
					"index beyond the tree",
					() => verifyReceipt(withProof(proof, { index: 13n }), { vkey: log.vkey, data: entries[4] as Uint8Array }),
				],
				[
					"tampered proof",
					() =>
						verifyReceipt(withProof(proof, { hashes: proof.hashes.map((h) => h.map((b) => b ^ 1)) }), {
							vkey: log.vkey,
							data: entries[4] as Uint8Array,
						}),
				],
				[
					"truncated proof",
					() =>
						verifyReceipt(withProof(proof, { hashes: proof.hashes.slice(1) }), {
							vkey: log.vkey,
							data: entries[4] as Uint8Array,
						}),
				],
			];
			for (const [name, fn] of cases) {
				const err = failure(fn);
				expect(err.reason, name).toBe("inclusion");
				expect(err.message, name).toContain("against the exact bytes that were logged");
			}
		});
	});
});

describe("parseReceipt", () => {
	it("decodes without verifying", () => {
		const proof = proofFor(2n, checkpointOf(otherLog.skey));
		expect(parseReceipt(fromUTF8(proof.marshal())).index).toBe(2n);
	});

	it("rejects non-canonical base64, as tlog-proof requires", () => {
		const text = fromUTF8(proofFor(2n, checkpointOf(log.skey)).marshal()).replace(/=\n\n/, "=\n\n");
		expect(() => parseReceipt(text.replace(/^(c2sp\.org\/tlog-proof@v1\n)/, "$1extra YR==\n"))).toThrow(ReceiptError);
	});
});
