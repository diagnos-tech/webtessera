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
// What a submitter sends the notary, and how each side checks it. The request is JSON, so that
// `curl` can submit one:
//
//     { "sha256": "<64 hex digits>", "publicKey": "<base64 Ed25519 key>", "signature": "<base64>" }
//
// The signature is Ed25519 over signedStatement(digest), checked with WebCrypto, which Node,
// Bun, Deno and current browsers all implement.

import { fromBase64, fromHex, toBase64, toHex } from "./encoding.ts";
import { signedStatement } from "./record.ts";

/** Submission is a parsed notarization request. */
export interface Submission {
	readonly digest: Uint8Array<ArrayBuffer>;
	readonly publicKey: Uint8Array<ArrayBuffer>;
	readonly signature: Uint8Array<ArrayBuffer>;
}

/** SubmissionJSON is a submission as it travels. */
export interface SubmissionJSON {
	readonly sha256: string;
	readonly publicKey: string;
	readonly signature: string;
}

/** parseSubmission reads a request body, and throws a TypeError saying what is wrong with it. */
export function parseSubmission(body: unknown): Submission {
	if (typeof body !== "object" || body === null) {
		throw new TypeError("the body must be a JSON object: { sha256, publicKey, signature }");
	}
	const { sha256, publicKey, signature } = body as Record<string, unknown>;
	return {
		digest: field("sha256", sha256, fromHex, 32),
		publicKey: field("publicKey", publicKey, fromBase64, 32),
		signature: field("signature", signature, fromBase64, 64),
	};
}

/** verifySubmission reports whether the signature is the public key's, over the digest. */
export async function verifySubmission(s: Submission): Promise<boolean> {
	return verifyEd25519(s.publicKey, s.signature, signedStatement(s.digest));
}

/** verifyEd25519 reports whether signature is publicKey's Ed25519 signature of message. */
export async function verifyEd25519(
	publicKey: Uint8Array<ArrayBuffer>,
	signature: Uint8Array<ArrayBuffer>,
	message: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
	} catch {
		return false;
	}
	return crypto.subtle.verify("Ed25519", key, signature, message);
}

/** Submitter holds a submitter's Ed25519 key pair. */
export interface Submitter {
	readonly privateKey: CryptoKey;
	readonly publicKey: Uint8Array<ArrayBuffer>;
}

/** newSubmitter generates a submitter key pair; extractable, so a CLI can save it. */
export async function newSubmitter(extractable = false): Promise<Submitter> {
	const pair = (await crypto.subtle.generateKey("Ed25519", extractable, ["sign", "verify"])) as CryptoKeyPair;
	return {
		privateKey: pair.privateKey,
		publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
	};
}

/** sign returns the request that vouches for digest. */
export async function sign(submitter: Submitter, digest: Uint8Array): Promise<SubmissionJSON> {
	const signature = await crypto.subtle.sign("Ed25519", submitter.privateKey, signedStatement(digest));
	return {
		sha256: toHex(digest),
		publicKey: toBase64(submitter.publicKey),
		signature: toBase64(new Uint8Array(signature)),
	};
}

function field(
	name: string,
	value: unknown,
	decode: (s: string) => Uint8Array<ArrayBuffer>,
	length: number,
): Uint8Array<ArrayBuffer> {
	let b: Uint8Array<ArrayBuffer>;
	try {
		b = decode(typeof value === "string" ? value : "!");
	} catch {
		throw new TypeError(`${name} must be a string: ${decode === fromHex ? "hex" : "base64"} of ${length} bytes`);
	}
	if (b.length !== length) {
		throw new TypeError(`${name} must encode ${length} bytes, got ${b.length}`);
	}
	return b;
}
