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
// The notary's log entry: one fixed-length binary record per notarization. Fixed-length fields
// need no parser that could disagree with another implementation's: a verifier in any language
// rebuilds the exact bytes the log's leaf hash covers.
//
//   offset  size  field
//        0     1  version, 1
//        1     8  notarizedAt: milliseconds since the Unix epoch, big-endian (the notary's claim)
//        9    32  digest: the SHA-256 of the document
//       41    32  publicKey: the submitter's Ed25519 public key
//       73    64  signature: the submitter's Ed25519 signature over signedStatement(digest)
//      137        end

/** RecordLength is the size of every record, in bytes. */
export const RecordLength = 137;

const version = 1;

/** NotaryRecord is one notarization: who vouched for which digest, and when the notary logged it. */
export interface NotaryRecord {
	readonly notarizedAt: bigint;
	readonly digest: Uint8Array;
	readonly publicKey: Uint8Array;
	readonly signature: Uint8Array;
}

// statementPrefix separates the notary's signatures from any other use of the submitter's key:
// a signature made here cannot be passed off as one over some other message, nor the reverse.
const statementPrefix = new TextEncoder().encode("webtessera-example-notary/v1\n");

/** signedStatement returns the bytes a submitter signs to vouch for a digest. */
export function signedStatement(digest: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(statementPrefix.length + digest.length);
	out.set(statementPrefix);
	out.set(digest, statementPrefix.length);
	return out;
}

/** encodeRecord returns the record's bytes, the entry the notary appends to its log. */
export function encodeRecord(r: NotaryRecord): Uint8Array<ArrayBuffer> {
	checkLength("digest", r.digest, 32);
	checkLength("publicKey", r.publicKey, 32);
	checkLength("signature", r.signature, 64);
	const out = new Uint8Array(RecordLength);
	out[0] = version;
	new DataView(out.buffer).setBigUint64(1, r.notarizedAt);
	out.set(r.digest, 9);
	out.set(r.publicKey, 41);
	out.set(r.signature, 73);
	return out;
}

/** decodeRecord parses a record, and throws if b is not one. */
export function decodeRecord(b: Uint8Array): NotaryRecord {
	if (b.length !== RecordLength || b[0] !== version) {
		throw new TypeError(`not a version ${version} notary record of ${RecordLength} bytes`);
	}
	return {
		notarizedAt: new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(1),
		digest: b.slice(9, 41),
		publicKey: b.slice(41, 73),
		signature: b.slice(73, 137),
	};
}

function checkLength(name: string, b: Uint8Array, want: number): void {
	if (b.length !== want) {
		throw new TypeError(`${name} must be ${want} bytes, got ${b.length}`);
	}
}
