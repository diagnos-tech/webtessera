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

// Tests for AsyncSigner and signAsync, which have no upstream counterpart: signAsync must
// produce exactly what sign produces, and fail exactly where it fails. See
// docs/decisions/0223-async-signers-for-notes-and-checkpoints.md. The WebCrypto-backed
// signers are checked against the Go fixtures by src/safe/testing/golden.ts.

import { describe, expect, it } from "vitest";
import { bytesEqual, fromUTF8 } from "../../internal/gostd/bytes.ts";
import {
	type AsyncSigner,
	errInvalidSigner,
	errMalformedNote,
	generateKey,
	newSigner,
	newVerifier,
	open,
	type Signer,
	sign,
	signAsync,
	verifierList,
} from "./note.ts";

const peterNeumann = "PRIVATE+KEY+PeterNeumann+c74f20a3+AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
const text = "If you think cryptography is the answer to your problem,\nthen you don't know what your problem is.\n";

/** asyncOf wraps a synchronous Signer as an AsyncSigner that signs on a later turn. */
function asyncOf(s: Signer): AsyncSigner & { readonly calls: Uint8Array[] } {
	const calls: Uint8Array[] = [];
	return {
		calls,
		name: () => s.name(),
		keyHash: () => s.keyHash(),
		sign: async (msg: Uint8Array): Promise<Uint8Array> => {
			calls.push(msg);
			await Promise.resolve();
			return s.sign(msg);
		},
	};
}

describe("note signAsync", () => {
	it("signs the upstream example byte-identically to sign", async () => {
		const s = newSigner(peterNeumann);
		const got = await signAsync({ text }, asyncOf(s));
		expect(fromUTF8(got)).toBe(
			`${text}\n— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n`,
		);
		expect(bytesEqual(got, sign({ text }, s))).toBe(true);
	});

	it("accepts synchronous and asynchronous signers together, in order", async () => {
		const a = newSigner(generateKey(undefined, "a.example").skey);
		const b = newSigner(generateKey(undefined, "b.example").skey);
		const c = newSigner(generateKey(undefined, "c.example").skey);
		const got = await signAsync({ text }, a, asyncOf(b), c);
		expect(bytesEqual(got, sign({ text }, a, b, c))).toBe(true);
	});

	it("replaces an existing signature by the same key, and keeps the others", async () => {
		const ka = generateKey(undefined, "a.example");
		const kb = generateKey(undefined, "b.example");
		const a = newSigner(ka.skey);
		const b = newSigner(kb.skey);
		const signed = sign({ text }, a, b);
		const n = open(signed, verifierList(newVerifier(ka.vkey), newVerifier(kb.vkey)));
		const got = await signAsync(n, asyncOf(a));
		expect(bytesEqual(got, sign(n, a))).toBe(true);
	});

	it("hands every signer the note's text and nothing else", async () => {
		const s = asyncOf(newSigner(peterNeumann));
		await signAsync({ text }, s);
		expect(s.calls.map(fromUTF8)).toEqual([text]);
	});

	it("rejects a note without a final newline before asking any signer", async () => {
		const s = asyncOf(newSigner(peterNeumann));
		await expect(signAsync({ text: "no newline" }, s)).rejects.toBe(errMalformedNote);
		expect(s.calls).toEqual([]);
	});

	it("rejects an invalid signer name before asking that signer, after the ones before it", async () => {
		const good = asyncOf(newSigner(peterNeumann));
		const bad = { ...asyncOf(newSigner(peterNeumann)), name: (): string => "has space" };
		await expect(signAsync({ text }, good, bad)).rejects.toBe(errInvalidSigner);
		expect(good.calls.length).toBe(1);
		expect(bad.calls).toEqual([]);
		// sign fails the same way.
		const s = newSigner(peterNeumann);
		const badSync: Signer = { name: () => "has space", keyHash: () => s.keyHash(), sign: (m) => s.sign(m) };
		expect(() => sign({ text }, s, badSync)).toThrow(errInvalidSigner);
	});

	it("lets a signer's rejection through unchanged", async () => {
		const boom = new Error("hardware token unplugged");
		const failing: AsyncSigner = {
			name: () => "PeterNeumann",
			keyHash: () => 0xc74f20a3,
			sign: async () => {
				throw boom;
			},
		};
		await expect(signAsync({ text }, failing)).rejects.toBe(boom);
	});

	it("rejects a malformed existing signature as sign does, after signing", async () => {
		const s = asyncOf(newSigner(peterNeumann));
		const n = { text, sigs: [{ name: "Other", hash: 1, base64: "not base64!" }] };
		await expect(signAsync(n, s)).rejects.toBe(errMalformedNote);
		expect(() => sign(n, newSigner(peterNeumann))).toThrow(errMalformedNote);
	});
});
