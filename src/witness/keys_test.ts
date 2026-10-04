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

// Tests for cosignerVkey: the vkey it derives is the one the ported key functions give for
// the same key pair, and the one the witness's cosignatures verify with.

import { describe, expect, it } from "vitest";
import {
	cosignerVkey,
	newSignerForCosignatureV1,
	newVerifierForCosignatureV1,
	vKeyToCosignatureV1,
} from "webtessera/witness";
import { fromBase64, toBase64 } from "../internal/gostd/bytes.ts";
import { generateKey, open, sign, verifierList } from "../vendor/note/note.ts";
import { newWitness, newWitnessGroup, newWitnessGroupFromPolicy } from "../witness.ts";

describe("cosignerVkey", () => {
	it("derives from the signer key the cosignature/v1 vkey of its key pair", () => {
		for (const name of ["witness.example/w1", "w"]) {
			const { skey, vkey } = generateKey(undefined, name);
			const derived = cosignerVkey(skey);
			expect(derived).toBe(vKeyToCosignatureV1(vkey));
			// Algorithm 0x04, the form witness policies require.
			expect(fromBase64(derived.split("+").slice(2).join("+"))[0]).toBe(4);
		}
	});

	it("verifies the cosignatures that newSignerForCosignatureV1 makes with the same key", () => {
		const { skey } = generateKey(undefined, "witness.example/w1");
		const signer = newSignerForCosignatureV1(skey);
		const verifier = newVerifierForCosignatureV1(cosignerVkey(skey));
		expect([verifier.name(), verifier.keyHash()]).toEqual([signer.name(), signer.keyHash()]);
		const cosigned = sign({ text: "example.com/log\n1\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n" }, signer);
		expect(open(cosigned, verifierList(verifier)).sigs).toHaveLength(1);

		// It is also what a log's witness configuration, or its policy file, names the witness by.
		expect(() => newWitnessGroup(1, newWitness(cosignerVkey(skey), new URL("https://w.example/")))).not.toThrow();
		const policy = `witness w ${cosignerVkey(skey)} https://w.example/\nquorum w\n`;
		expect(newWitnessGroupFromPolicy(new TextEncoder().encode(policy)).satisfied(cosigned)).toBe(true);
	});

	it("refuses what is not an Ed25519 signer key, without quoting it", () => {
		const { skey, vkey } = generateKey(undefined, "witness.example/w1");
		const otherAlgorithm = `PRIVATE+KEY+w+00000000+${toBase64(new Uint8Array(33).fill(9, 0, 1))}`;
		const cases: [string, unknown, RegExp][] = [
			["a verifier key", vkey, /not an Ed25519 note signer key \(malformed signer id\)/],
			["a truncated key", skey.slice(0, -4), /malformed signer id/],
			["another algorithm", otherAlgorithm, /unknown signer algorithm/],
			["not a string", 42, /takes a note signer key string/],
		];
		for (const [name, input, want] of cases) {
			let err: Error | undefined;
			try {
				cosignerVkey(input as string);
			} catch (e) {
				err = e as Error;
			}
			expect(err?.message, name).toMatch(want);
			expect(err?.message, name).not.toContain(skey.slice(-20));
		}
	});
});
