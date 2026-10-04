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
// Verifies a notarization offline: with the receipt, the document and the notary's verifier
// key, and nothing else. No network, no notary, no log. It imports webtessera/browser, which
// holds no secrets, so the same function verifies receipts in a browser too.

import { ReceiptError, verifyReceipt } from "webtessera/browser";
import { equalBytes, sha256, toBase64 } from "./encoding.ts";
import { decodeRecord, signedStatement } from "./record.ts";
import { verifyEd25519 } from "./submission.ts";

/**
 * NotarizationError says why a notarization does not hold:
 *
 *   - "receipt": the receipt is not a proof from this notary's log (forged, altered, or for
 *     another log);
 *   - "document": the receipt is genuine, but for a different document;
 *   - "signature": the logged signature does not verify (never true of a record this
 *     notary logged, since it checks every signature before logging);
 *   - "signer": the document was notarized, but not by the expected key.
 */
export class NotarizationError extends Error {
	readonly reason: "receipt" | "document" | "signature" | "signer";

	constructor(reason: NotarizationError["reason"], message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "NotarizationError";
		this.reason = reason;
	}
}

/** Notarization is what a verified receipt proves. */
export interface Notarization {
	/** index is the record's position in the notary's log. */
	readonly index: bigint;
	/** notarizedAt is when the notary logged it, by the notary's clock. */
	readonly notarizedAt: Date;
	/** signer is the submitter's Ed25519 public key, base64. */
	readonly signer: string;
	/** logSize is the size of the signed checkpoint the receipt is proven against. */
	readonly logSize: bigint;
}

/** VerifyNotarizationInput is what verifyNotarization checks, against what. */
export interface VerifyNotarizationInput {
	readonly receipt: string | Uint8Array;
	readonly document: Uint8Array;
	/** vkey is the notary log's published verifier key. */
	readonly vkey: string;
	/** signer, if given, is the base64 public key the document must have been notarized by. */
	readonly signer?: string;
}

/** verifyNotarization checks a receipt for a document, and throws a NotarizationError if it does not hold. */
export async function verifyNotarization(input: VerifyNotarizationInput): Promise<Notarization> {
	let index: bigint;
	let logSize: bigint;
	let recordBytes: Uint8Array;
	try {
		// The one check that makes the extra data trustworthy: dataInExtra takes the record from
		// the receipt's extra line and proves that the log's signed checkpoint commits to exactly
		// these bytes as entry `index`. Remove the record, or change one bit of it, the proof,
		// the index or the checkpoint, and this throws.
		({
			index,
			checkpoint: { size: logSize },
			data: recordBytes,
		} = verifyReceipt(input.receipt, { vkey: input.vkey, dataInExtra: true }));
	} catch (err) {
		if (err instanceof ReceiptError) {
			throw new NotarizationError("receipt", `${err.reason}: ${err.message}`, { cause: err });
		}
		throw err;
	}

	const record = decodeRecord(recordBytes);
	if (!equalBytes(await sha256(input.document), record.digest)) {
		throw new NotarizationError("document", "the document's SHA-256 is not the digest this receipt notarized");
	}
	const message = signedStatement(record.digest);
	if (!(await verifyEd25519(new Uint8Array(record.publicKey), new Uint8Array(record.signature), message))) {
		throw new NotarizationError("signature", "the logged signature does not verify with the logged public key");
	}
	const signer = toBase64(record.publicKey);
	if (input.signer !== undefined && input.signer !== signer) {
		throw new NotarizationError("signer", `the document was notarized by ${signer}, not ${input.signer}`);
	}
	return { index, notarizedAt: new Date(Number(record.notarizedAt)), signer, logSize };
}
