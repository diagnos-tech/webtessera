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

// This file has no upstream counterpart. A witness publishes the verifier key of the key it
// cosigns with, and runs from the signer key alone; this derives the one from the other by
// composing the ported note and formats/note functions. See docs/decisions/0171-witness-server.md
// (its 2026-10-04 update).

import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBase64 } from "../internal/gostd/bytes.ts";
import { cut } from "../internal/gostd/strings.ts";
import { newSignerForCosignatureV1, vKeyToCosignatureV1 } from "../vendor/formats/note/note_cosigv1.ts";
import { newEd25519VerifierKey } from "../vendor/note/note.ts";

/**
 * cosignerVkey returns the verifier key of the cosigner that `newSignerForCosignatureV1(skey)`
 * builds: the cosignature/v1 (type 0x04) vkey that a witness publishes, that log operators
 * put in their witness policies, and that newWitness and verifyReceipt's witness policies
 * take. A witness therefore needs only its signer key, kept secret, to start and to say
 * which key its cosignatures verify with.
 *
 * skey is an Ed25519 note signer key (`PRIVATE+KEY+<name>+<hash>+<key>`, as generateKey
 * from webtessera/note makes it), checked exactly as newSignerForCosignatureV1 checks it.
 * The error for one that is not names what is wrong, never the key.
 *
 * ```ts
 * const witness = newWitnessServer({ signer: newSignerForCosignatureV1(env.WITNESS_SKEY), store, logs });
 * publish(cosignerVkey(env.WITNESS_SKEY)); // "witness.example/w1+5ab8c3d2+BOt…"
 * ```
 */
export function cosignerVkey(skey: string): string {
	if (typeof skey !== "string") {
		throw new TypeError("cosignerVkey takes a note signer key string (PRIVATE+KEY+…)");
	}
	let name: string;
	try {
		name = newSignerForCosignatureV1(skey).name();
	} catch (err) {
		// The formats/note errors are fixed strings ("malformed signer id", ...) that never
		// quote the key.
		throw new Error(
			`cosignerVkey: not an Ed25519 note signer key (${err instanceof Error ? err.message : "unknown error"}); ` +
				"expected PRIVATE+KEY+<name>+<hash>+<key>, as generateKey from webtessera/note produces",
			{ cause: err },
		);
	}
	// PRIVATE+KEY+<name>+<hash>+<key>: newSignerForCosignatureV1 has checked every field and
	// that the key is an algorithm byte and a 32-byte Ed25519 seed. The base64 key may itself
	// contain "+", so the first four separators are cut as it cuts them.
	const [, afterPriv1] = cut(skey, "+");
	const [, afterPriv2] = cut(afterPriv1, "+");
	const [, afterName] = cut(afterPriv2, "+");
	const [, key64] = cut(afterName, "+");
	const key = fromBase64(key64);
	try {
		return vKeyToCosignatureV1(newEd25519VerifierKey(name, ed25519.getPublicKey(key.subarray(1))));
	} finally {
		key.fill(0);
	}
}
