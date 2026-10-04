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

// This file has no upstream counterpart. Receipts are C2SP tlog-proof proofs
// (https://c2sp.org/tlog-proof), encoded and decoded by the port of
// transparency-dev/formats/proof, and verified offline by composing the ported checks the
// spec's verification steps name: the log's signature and origin (formats/log's
// parseCheckpoint, over sumdb/note), the witness cosignatures and policy (Tessera's
// WitnessGroup, over formats/note's cosignature/v1 verifiers), and the inclusion proof
// (merkle/proof's verifyInclusion). Nothing here re-implements a check. See
// docs/decisions/0225-receipts-are-tlog-proofs.md.

import { bytesEqual, fromUTF8, toUTF8 } from "../internal/gostd/bytes.ts";
import {
	type Checkpoint,
	ParseCheckpointError,
	type ParsedCheckpoint,
	parseCheckpoint,
} from "../vendor/formats/log/index.ts";
import { newVerifierForCosignatureV1 } from "../vendor/formats/note/note_cosigv1.ts";
import { TLogProof } from "../vendor/formats/proof/tlog_proof.ts";
import { verifyInclusion } from "../vendor/merkle/proof/verify.ts";
import { DefaultHasher } from "../vendor/merkle/rfc6962/rfc6962.ts";
import { newVerifier, type Verifier } from "../vendor/note/note.ts";
import { newWitnessGroup, Witness, WitnessGroup } from "../witness.ts";

/**
 * Receipt proves, offline, that an entry is in a log: it is a C2SP tlog-proof
 * (https://c2sp.org/tlog-proof) holding the entry's index, an inclusion proof, and the
 * log's signed checkpoint with any witness cosignatures.
 *
 * `text` is the encoding to store (in a `.tlog-proof` file, as the spec recommends) or
 * send; anyone holding the log's vkey and the entry can check it with verifyReceipt.
 *
 * ```ts
 * const receipt = await log.append(entry);
 * await save(`${receipt.index}.tlog-proof`, receipt.text);
 * ```
 */
export interface Receipt {
	/** index is the entry's index in the log. */
	readonly index: bigint;
	/** checkpoint is the signed checkpoint the proof is relative to, already verified. */
	readonly checkpoint: LogCheckpoint;
	/** proof is the decoded tlog-proof, for code that works with the format directly. */
	readonly proof: TLogProof;
	/** text is the tlog-proof encoding of the receipt. */
	readonly text: string;
}

/**
 * LogCheckpoint is a checkpoint whose log signature has been verified: the log's origin,
 * its size, its root hash, and the signed note it came from, cosignatures included.
 *
 * ```ts
 * const { size } = await log.latestCheckpoint();
 * ```
 */
export interface LogCheckpoint {
	readonly origin: string;
	readonly size: bigint;
	readonly hash: Uint8Array;
	/** signed is the checkpoint as the log published it: a signed note. */
	readonly signed: Uint8Array;
}

/**
 * WitnessPolicy is the simplest witness policy: at least `threshold` of `witnesses` must
 * have cosigned the checkpoint. Each witness is given by its verifier key, a
 * cosignature/v1 vkey or the Ed25519 vkey it is derived from. For anything more
 * elaborate, pass a WitnessGroup from `newWitnessGroupFromPolicy` or `newWitnessGroup`
 * (package `webtessera`) instead.
 *
 * ```ts
 * verifyReceipt(text, { vkey, data, witnesses: { threshold: 2, witnesses: [w1, w2, w3] } });
 * ```
 */
export interface WitnessPolicy {
	readonly threshold: number;
	readonly witnesses: readonly string[];
}

/**
 * VerifyReceiptOptions says what verifyReceipt checks a receipt against.
 *
 * ```ts
 * { vkey: "example.com/log+1a2b3c4d+AQ…", leafHash: DefaultHasher.hashLeaf(entry) }
 * ```
 */
export interface VerifyReceiptOptions {
	/** vkey is the log's verifier key, or a note Verifier for it. */
	readonly vkey: string | Verifier;
	/** origin is the log's checkpoint origin. It defaults to the key's name, which is the origin of every log webtessera writes. */
	readonly origin?: string;
	/** data is the entry the receipt is for. Give it, or its leafHash, or set dataInExtra. */
	readonly data?: Uint8Array;
	/** leafHash is the RFC 6962 leaf hash of the entry, for a verifier that holds only the hash. */
	readonly leafHash?: Uint8Array;
	/**
	 * dataInExtra says that the proof's `extra` line carries the entry itself, as a receipt
	 * from `append(data, { extraData: data })` does. Alone, it takes the entry from the extra
	 * line; with `data` or `leafHash`, it also checks that the extra line holds that entry.
	 * Either way the inclusion proof then binds the extra data to the log, and it is returned
	 * as `data`: authenticated, unlike `extraData`.
	 */
	readonly dataInExtra?: boolean;
	/** witnesses is the witness policy the checkpoint must satisfy. By default no cosignature is required. */
	readonly witnesses?: WitnessGroup | WitnessPolicy;
}

/**
 * VerifiedReceipt is what verifyReceipt returns once every check has passed.
 *
 * ```ts
 * const { index, checkpoint, cosignedBy } = verifyReceipt(text, { vkey, data });
 * ```
 */
export interface VerifiedReceipt {
	readonly index: bigint;
	readonly checkpoint: LogCheckpoint;
	/** cosignedBy lists the policy's witnesses whose cosignatures verified, by name. */
	readonly cosignedBy: readonly string[];
	/**
	 * extraData is the proof's opaque extra data. The spec is explicit: "Applications MUST
	 * NOT implicitly trust the extra data, as it is not authenticated."
	 */
	readonly extraData: Uint8Array | undefined;
	/**
	 * data is the logged entry when dataInExtra took it from, or checked it against, the
	 * extra line: the same bytes as extraData, but proven to be the entry at index of the
	 * checkpoint. It is undefined without dataInExtra.
	 */
	readonly data: Uint8Array | undefined;
}

/**
 * ReceiptError is thrown by verifyReceipt when a receipt does not prove what it is checked
 * against. `reason` says which check failed; the message says what that usually means.
 * `extra` is the one that is not a step of the spec's verification: with dataInExtra, the
 * proof's extra line is missing, or is not the entry it was checked against.
 *
 * ```ts
 * try {
 *   verifyReceipt(text, { vkey, data });
 * } catch (err) {
 *   if (err instanceof ReceiptError && err.reason === "inclusion") {
 *     // the data is not what was logged at that index
 *   }
 * }
 * ```
 */
export class ReceiptError extends Error {
	readonly reason: "malformed" | "signature" | "witnesses" | "inclusion" | "extra";

	constructor(reason: ReceiptError["reason"], message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ReceiptError";
		this.reason = reason;
	}
}

/**
 * parseReceipt decodes a tlog-proof, as text or bytes, without verifying anything. It
 * throws a ReceiptError with reason "malformed" if it is not one.
 *
 * ```ts
 * const proof = parseReceipt(await file.text());
 * proof.index; // the entry's index, unverified
 * ```
 */
export function parseReceipt(receipt: string | Uint8Array): TLogProof {
	const p = new TLogProof();
	try {
		p.unmarshal(typeof receipt === "string" ? toUTF8(receipt) : receipt);
	} catch (err) {
		throw new ReceiptError("malformed", `receipt: not a c2sp.org/tlog-proof@v1 proof: ${messageOf(err)}`, {
			cause: err,
		});
	}
	return p;
}

/**
 * verifyReceipt checks a receipt offline, following the verification steps of
 * https://c2sp.org/tlog-proof, and returns what it proves, or throws a ReceiptError:
 *
 *   1. the leaf hash is the RFC 6962 hash of `data`, or `leafHash` as given, or, with
 *      dataInExtra, the hash of the proof's extra data, which must then match `data` or
 *      `leafHash` if either is given;
 *   2. the checkpoint's origin is the log's, and the log's key signed it;
 *   3. every cosignature by a witness in the policy verifies, and the policy is satisfied;
 *   4. the inclusion proof binds the leaf hash at the receipt's index to the checkpoint's
 *      root hash.
 *
 * It is synchronous and needs nothing but its arguments: no network, no log.
 *
 * ```ts
 * const { index, checkpoint } = verifyReceipt(receiptText, { vkey: logVkey, data: entry });
 * const { data } = verifyReceipt(carrying, { vkey: logVkey, dataInExtra: true }); // the entry, proven
 * ```
 */
export function verifyReceipt(
	receipt: Receipt | TLogProof | string | Uint8Array,
	options: VerifyReceiptOptions & { readonly dataInExtra: true },
): VerifiedReceipt & { readonly data: Uint8Array };
export function verifyReceipt(
	receipt: Receipt | TLogProof | string | Uint8Array,
	options: VerifyReceiptOptions,
): VerifiedReceipt;
export function verifyReceipt(
	receipt: Receipt | TLogProof | string | Uint8Array,
	options: VerifyReceiptOptions,
): VerifiedReceipt {
	const proof = toProof(receipt);
	const verifier = typeof options.vkey === "string" ? verifierOf(options.vkey) : options.vkey;
	const origin = options.origin ?? verifier.name();
	const { leafHash, data } = leafHashOf(options, proof);
	const policy = options.witnesses === undefined ? undefined : witnessGroupOf(options.witnesses);
	const witnessVerifiers = policy === undefined ? [] : policyVerifiers(policy);

	// "Check that the checkpoint origin line is acceptable, and that the checkpoint is signed
	// by a log public key configured for that origin line." and "Verify all cosignatures for
	// witnesses known to the verifier": parseCheckpoint opens the note with the log's key and
	// every policy witness's, which throws on a signature by any of them that does not verify.
	let parsed: ParsedCheckpoint;
	try {
		parsed = parseCheckpoint(proof.checkpoint, origin, verifier, ...witnessVerifiers);
	} catch (err) {
		if (!(err instanceof ParseCheckpointError)) {
			throw err;
		}
		throw new ReceiptError(
			"signature",
			`receipt: the checkpoint is not a checkpoint of ${origin} signed by ${verifier.name()}+${hex8(verifier.keyHash())} ` +
				`(${err.message}); check that you are verifying with the log's own vkey`,
			{ cause: err },
		);
	}

	// "Which subsets of witnesses are considered strong enough, is determined by application
	// policy."
	const cosignedBy = (parsed.note.sigs ?? [])
		.filter((s) => !(s.name === verifier.name() && s.hash === verifier.keyHash()))
		.map((s) => s.name);
	if (policy !== undefined && !policy.satisfied(proof.checkpoint)) {
		throw new ReceiptError(
			"witnesses",
			`receipt: the checkpoint does not satisfy the witness policy (cosigned by ${
				cosignedBy.length === 0 ? "none of its witnesses" : cosignedBy.join(", ")
			}); it may predate the witnesses' cosignatures, or the log may not be witnessed by them`,
		);
	}

	// "Check that the inclusion proof is valid, to bind the leaf hash computed in step 1 to
	// the the root hash of the signed checkpoint."
	const cp = parsed.checkpoint;
	try {
		verifyInclusion(DefaultHasher, proof.index, cp.size, leafHash, proof.hashes, cp.hash);
	} catch (err) {
		throw new ReceiptError(
			"inclusion",
			`receipt: the entry is not at index ${proof.index} of the log at size ${cp.size} (${messageOf(err)}); ` +
				"check that you are verifying the receipt against the exact bytes that were logged",
			{ cause: err },
		);
	}

	return {
		index: proof.index,
		checkpoint: logCheckpointOf(cp, proof.checkpoint),
		cosignedBy,
		extraData: proof.extraData,
		data,
	};
}

/**
 * witnessGroupOf returns the WitnessGroup a policy describes.
 *
 * @internal Shared with the log factories, which verify their own receipts.
 */
export function witnessGroupOf(w: WitnessGroup | WitnessPolicy): WitnessGroup {
	if (w instanceof WitnessGroup) {
		return w;
	}
	if (typeof w !== "object" || w === null || !Array.isArray(w.witnesses) || !Number.isInteger(w.threshold)) {
		throw new TypeError("witnesses must be a WitnessGroup or { threshold: number, witnesses: vkey[] }");
	}
	// A Witness's URL is where an appender sends it checkpoints. A policy used only to check
	// cosignatures never sends anything, so the witnesses here have none.
	return newWitnessGroup(w.threshold, ...w.witnesses.map((vkey) => new Witness(newVerifierForCosignatureV1(vkey), "")));
}

/**
 * policyVerifiers returns the cosignature verifier of every witness in a policy.
 *
 * @internal Shared with the log factories.
 */
export function policyVerifiers(group: WitnessGroup): Verifier[] {
	const out: Verifier[] = [];
	const walk = (g: WitnessGroup): void => {
		for (const c of g.components) {
			if (c instanceof Witness) {
				out.push(c.key);
			} else if (c instanceof WitnessGroup) {
				walk(c);
			}
		}
	};
	walk(group);
	return out;
}

/**
 * logCheckpointOf turns a parsed checkpoint and its signed note into a LogCheckpoint.
 *
 * @internal Shared with the log factories.
 */
export function logCheckpointOf(cp: Checkpoint, signed: Uint8Array): LogCheckpoint {
	return { origin: cp.origin, size: cp.size, hash: cp.hash, signed };
}

/**
 * newReceipt assembles a Receipt from a proof whose checkpoint has been verified.
 *
 * @internal Shared with the log factories.
 */
export function newReceipt(proof: TLogProof, checkpoint: LogCheckpoint): Receipt {
	return { index: proof.index, checkpoint, proof, text: fromUTF8(proof.marshal()) };
}

function toProof(receipt: Receipt | TLogProof | string | Uint8Array): TLogProof {
	if (typeof receipt === "string" || receipt instanceof Uint8Array) {
		return parseReceipt(receipt);
	}
	if (receipt instanceof TLogProof) {
		return receipt;
	}
	if (typeof receipt === "object" && receipt !== null && receipt.proof instanceof TLogProof) {
		return receipt.proof;
	}
	// A Receipt from another copy of this library (two versions in one bundle, say) has
	// another TLogProof class, but the same text.
	if (typeof receipt === "object" && receipt !== null && typeof (receipt as { text?: unknown }).text === "string") {
		return parseReceipt((receipt as { text: string }).text);
	}
	throw new TypeError("verifyReceipt takes a Receipt, a TLogProof, or the text or bytes of a tlog-proof");
}

function verifierOf(vkey: string): Verifier {
	try {
		return newVerifier(vkey);
	} catch (err) {
		throw new TypeError(
			`verifyReceipt: ${JSON.stringify(vkey)} is not a note verifier key (${messageOf(err)}); expected ` +
				"<origin>+<hash>+<key>, the log's published vkey",
		);
	}
}

/**
 * leafHashOf performs step 1, "Compute the leaf hash", which the spec leaves to the
 * application: from the data or leaf hash the verifier holds, or, with dataInExtra, from
 * the proof's extra line, which the spec names as one of the inputs to this step
 * ("additional data necessary to reconstruct the record hash"). It returns the entry too
 * when it came from the extra line, for verifyReceipt to hand back once step 4 has bound it
 * to the checkpoint.
 */
function leafHashOf(
	options: VerifyReceiptOptions,
	proof: TLogProof,
): { leafHash: Uint8Array; data: Uint8Array | undefined } {
	const { data, leafHash, dataInExtra } = options;
	if (dataInExtra !== undefined && typeof dataInExtra !== "boolean") {
		throw new TypeError("verifyReceipt: dataInExtra must be true or false");
	}
	if (dataInExtra === true) {
		if (data !== undefined && leafHash !== undefined) {
			throw new TypeError(
				"verifyReceipt with dataInExtra takes the entry from the extra line, and checks it against at most one of " +
					"data and leafHash",
			);
		}
		const expected = data === undefined ? undefined : checkData(data);
		const expectedHash = leafHash === undefined ? undefined : checkLeafHash(leafHash);
		const extra = proof.extraData;
		if (extra === undefined) {
			throw new ReceiptError(
				"extra",
				"receipt: it has no extra line, but dataInExtra says it carries the entry; it is not a receipt that " +
					"carries its entry, or its extra line was removed",
			);
		}
		if (expected !== undefined && !bytesEqual(extra, expected)) {
			throw new ReceiptError(
				"extra",
				"receipt: its extra line does not hold the entry it is checked against; it is the receipt of another " +
					"entry, or its extra line was altered",
			);
		}
		const extraHash = DefaultHasher.hashLeaf(extra);
		if (expectedHash !== undefined && !bytesEqual(extraHash, expectedHash)) {
			throw new ReceiptError(
				"extra",
				"receipt: the entry in its extra line does not have the leaf hash it is checked against; it is the " +
					"receipt of another entry, or its extra line was altered",
			);
		}
		return { leafHash: extraHash, data: extra };
	}
	if ((data === undefined) === (leafHash === undefined)) {
		throw new TypeError(
			"verifyReceipt needs exactly one of data (the logged entry) and leafHash (its RFC 6962 leaf hash), or " +
				"dataInExtra: true for a receipt that carries its entry",
		);
	}
	if (data !== undefined) {
		return { leafHash: DefaultHasher.hashLeaf(checkData(data)), data: undefined };
	}
	return { leafHash: checkLeafHash(leafHash), data: undefined };
}

function checkData(data: unknown): Uint8Array {
	if (!(data instanceof Uint8Array)) {
		throw new TypeError("verifyReceipt: data must be the logged entry's bytes, as a Uint8Array");
	}
	return data;
}

function checkLeafHash(leafHash: unknown): Uint8Array {
	if (!(leafHash instanceof Uint8Array) || leafHash.length !== DefaultHasher.size()) {
		throw new TypeError(`verifyReceipt: leafHash must be a ${DefaultHasher.size()}-byte RFC 6962 leaf hash`);
	}
	return leafHash;
}

function hex8(v: number): string {
	return v.toString(16).padStart(8, "0");
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
