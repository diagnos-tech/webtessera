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

// This file has no upstream counterpart. See docs/decisions/0171-witness-server.md.

import { concatBytes, readUint64BE, toUTF8 } from "../internal/gostd/bytes.ts";
import type { Signer, Verifier } from "../vendor/note/note.ts";
import { echo } from "./errors.ts";

// probeText is a checkpoint-shaped message (cosignature/v1 needs at least three lines) that
// no log would publish; the witness signs it once to learn what its keys' signatures look like.
const probeText = toUTF8("webtessera/witness key separation probe\n0\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n");

// cosignatureV1Size is the size of a cosignature/v1 signature: an 8-byte timestamp and a
// 64-byte Ed25519 signature.
const cosignatureV1Size = 72;

/**
 * checkCosigner throws unless signer makes cosignature/v1 signatures
 * (https://c2sp.org/tlog-cosignature), the only kind Tessera's witness policies verify. A
 * signer of any other kind would answer add-checkpoint with signatures no log can use; a
 * plain Ed25519 note signer, worse, with what reads as the witness key's own signed note
 * over whatever text the request carried, extension lines included.
 *
 * It signs a probe once. The signature must have the cosignature/v1 shape, a positive
 * 8-byte timestamp followed by a 64-byte Ed25519 signature; and when the signer can produce
 * its verifier, as one from newSignerForCosignatureV1 can, that verifier must carry the
 * signer's name and key hash and accept the signature. A custom signer without a verifier
 * is held to the shape alone.
 */
export function checkCosigner(signer: Signer): void {
	const fault = cosignerFault(signer, signer.sign(probeText));
	if (fault !== undefined) {
		throw new Error(
			`witness signer ${echo(signer.name())} does not make cosignature/v1 signatures: ${fault}; ` +
				"build it with newSignerForCosignatureV1",
		);
	}
}

/** cosignerFault says what is wrong with sig, signer's signature over probeText, as a cosignature/v1, if anything. */
function cosignerFault(signer: Signer, sig: Uint8Array): string | undefined {
	if (sig.length !== cosignatureV1Size) {
		return `its signatures are ${sig.length} bytes, not the ${cosignatureV1Size} of a cosignature/v1`;
	}
	if (BigInt.asIntN(64, readUint64BE(sig, 0)) <= 0n) {
		return "its signature carries no valid timestamp";
	}
	const verifier = (signer as { verifier?: () => Verifier }).verifier;
	if (typeof verifier !== "function") {
		return undefined;
	}
	const v = verifier.call(signer);
	if (v.name() !== signer.name() || v.keyHash() !== signer.keyHash() || !v.verify(probeText, sig)) {
		return "its own verifier does not accept its signature";
	}
	return undefined;
}

/** probe is one signer's signature over probeText, in the forms a log verifier might check. */
interface probe {
	/** message and signature form a plain signature, as a log key makes them. */
	readonly message: Uint8Array;
	readonly signature: Uint8Array;
}

/**
 * KeySeparation detects a log key that is one of the witness's own keys.
 *
 * A witness must not witness a log that signs with its key: with one key in both roles,
 * the witness's cosignatures and the log's signatures stop being separate statements, and
 * whoever registers the witness's (public) key as a log key gets to present the witness's
 * own output as log checkpoints. Signers and verifiers are opaque, so the check is
 * behavioural: each witness signer signs a probe once, and a log verifier shares a key with
 * it if it accepts that signature. A cosignature/v1 signature is an Ed25519 signature over
 * `cosignature/v1\ntime <t>\n` followed by the note text, so the probe is offered to log
 * verifiers both as it is and as that underlying Ed25519 signature. Keys of other
 * algorithms are compared only if their signatures happen to be checkable this way.
 */
export class KeySeparation {
	readonly #probes: readonly probe[];

	constructor(signers: readonly Signer[]) {
		const probes: probe[] = [];
		for (const s of signers) {
			const sig = s.sign(probeText);
			probes.push({ message: probeText, signature: sig });
			if (sig.length === cosignatureV1Size) {
				const t = readUint64BE(sig, 0);
				probes.push({
					message: concatBytes(toUTF8(`cosignature/v1\ntime ${t}\n`), probeText),
					signature: sig.subarray(8),
				});
			}
		}
		this.#probes = probes;
	}

	/** sharesKey reports whether any of verifiers accepts a signature made by a witness key. */
	sharesKey(verifiers: readonly Verifier[]): boolean {
		return verifiers.some((v) => this.#probes.some((p) => v.verify(p.message, p.signature)));
	}
}
