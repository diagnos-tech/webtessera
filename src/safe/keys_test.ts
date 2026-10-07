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

// Tests for key custody on Node, whose WebCrypto API supports Ed25519 from Node 22. The same
// golden suite runs in Chromium and workerd.

import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64, fromUTF8, toBase64, toUTF8 } from "../internal/gostd/bytes.ts";
import { generateKey, newSigner, newVerifier, open, sign, signAsync, verifierList } from "../vendor/note/note.ts";
import { WebtesseraError } from "./errors.ts";
import {
	assertLogKey,
	checkOrigin,
	fromCryptoKeyPair,
	generateLogKey,
	importSignerKey,
	isDurable,
	webCryptoEd25519,
} from "./keys.ts";
import { describeWebCryptoGolden } from "./testing/golden.ts";

describeWebCryptoGolden("Node");

/** secretsOf returns the strings a leak of skey could show up as. */
function secretsOf(skey: string): string[] {
	const key64 = skey.split("+").slice(4).join("+");
	return [skey, key64, key64.slice(4, 24)].filter((s) => s.length > 0);
}

describe("generateLogKey", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("generates a non-extractable WebCrypto key whose signatures its vkey verifies", async () => {
		expect(await webCryptoEd25519()).toBe(true);
		const key = await generateLogKey("example.com/log");
		expect(key.backend).toBe("webcrypto");
		expect(key.extractable).toBe(false);
		expect(key.origin).toBe("example.com/log");
		expect(key.name()).toBe("example.com/log");
		const v = newVerifier(key.vkey);
		expect(v.keyHash()).toBe(key.keyHash());
		const msg = toUTF8("hello\n");
		expect(v.verify(msg, await key.sign(msg))).toBe(true);
		const signed = await signAsync({ text: "hello\n" }, key);
		expect(open(signed, verifierList(key.verifier())).text).toBe("hello\n");
	});

	it("generates an extractable WebCrypto key only when asked to", async () => {
		const key = await generateLogKey("example.com/log", { extractable: true });
		expect(key.backend).toBe("webcrypto");
		expect(key.extractable).toBe(true);
	});

	it("falls back to @noble/curves, and says so, where WebCrypto has no Ed25519", async () => {
		vi.stubGlobal("crypto", { subtle: undefined, getRandomValues: crypto.getRandomValues.bind(crypto) });
		expect(await webCryptoEd25519()).toBe(false);
		const key = await generateLogKey("example.com/log");
		expect(key.backend).toBe("noble");
		expect(key.extractable).toBe(true);
		const msg = toUTF8("hello\n");
		expect(key.verifier().verify(msg, await key.sign(msg))).toBe(true);
	});

	it('refuses to fall back when fallback is "error", and says why', async () => {
		vi.stubGlobal("crypto", { subtle: undefined, getRandomValues: crypto.getRandomValues.bind(crypto) });
		await expect(generateLogKey("example.com/log", { fallback: "error" })).rejects.toThrow(
			/cannot hold an Ed25519 key .*Pass fallback: "noble"/,
		);
	});

	it("does not trust a WebCrypto implementation that signs wrongly", async () => {
		const real = crypto.subtle;
		const wrong = {
			importKey: real.importKey.bind(real),
			sign: async (): Promise<ArrayBuffer> => new ArrayBuffer(64),
		} as unknown as SubtleCrypto;
		vi.stubGlobal("crypto", { subtle: wrong, getRandomValues: crypto.getRandomValues.bind(crypto) });
		expect(await webCryptoEd25519()).toBe(false);
	});

	const badOrigins: { origin: unknown; want: RegExp }[] = [
		{ origin: "", want: /cannot be a log origin/ },
		{ origin: "has space", want: /cannot be a log origin/ },
		{ origin: "a+b", want: /cannot be a log origin/ },
		{ origin: "tab\there", want: /cannot be a log origin/ },
		{ origin: "PRIVATE+KEY+example.com+00000000+AAAA", want: /looks like a private signer key/ },
		{ origin: 42, want: /the origin must be a string/ },
	];
	for (const c of badOrigins) {
		it(`refuses the origin ${JSON.stringify(c.origin)}`, async () => {
			await expect(generateLogKey(c.origin as string)).rejects.toThrow(c.want);
		});
	}

	it("refuses an unknown fallback", async () => {
		await expect(generateLogKey("example.com/log", { fallback: "maybe" as "noble" })).rejects.toThrow(
			'fallback must be "noble" or "error"',
		);
	});
});

describe("importSignerKey", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("imports a note signer key into a non-extractable WebCrypto key that signs as newSigner does", async () => {
		const { skey, vkey } = generateKey(undefined, "example.com/log");
		const key = await importSignerKey(skey);
		expect(key.backend).toBe("webcrypto");
		expect(key.extractable).toBe(false);
		expect(key.vkey).toBe(vkey);
		const text = "example.com/log\n1\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n";
		expect(fromUTF8(await signAsync({ text }, key))).toBe(fromUTF8(sign({ text }, newSigner(skey))));
	});

	it("imports with @noble/curves where WebCrypto has no Ed25519", async () => {
		const { skey, vkey } = generateKey(undefined, "example.com/log");
		vi.stubGlobal("crypto", { subtle: undefined, getRandomValues: crypto.getRandomValues.bind(crypto) });
		const key = await importSignerKey(skey);
		expect(key.backend).toBe("noble");
		expect(key.vkey).toBe(vkey);
		await expect(importSignerKey(skey, { fallback: "error" })).rejects.toThrow(/cannot hold an Ed25519 key/);
	});

	it("never shows the secret: not in toString, JSON, inspect or the object's keys", async () => {
		const { skey } = generateKey(undefined, "example.com/log");
		for (const key of [await importSignerKey(skey), await importSignerKey(skey, {})]) {
			const shown = [`${key}`, String(key), JSON.stringify(key), inspect(key, { depth: 10, showHidden: true })];
			for (const s of shown) {
				for (const secret of secretsOf(skey)) {
					expect(s).not.toContain(secret);
				}
			}
			expect(Object.keys(key).sort()).toEqual(["backend", "extractable", "origin", "vkey"]);
			expect(JSON.parse(JSON.stringify(key))).toEqual({
				origin: "example.com/log",
				vkey: key.vkey,
				backend: "webcrypto",
				extractable: false,
			});
		}
	});

	const malformed: { name: string; mangle: (skey: string) => string; want: string }[] = [
		{ name: "a verifier key", mangle: (s) => s.slice("PRIVATE+KEY+".length), want: "malformed verifier id" },
		{ name: "a wrong hash", mangle: (s) => s.replace(/\+[0-9a-f]{8}\+/, "+00000000+"), want: "invalid verifier hash" },
		{ name: "a truncated key", mangle: (s) => s.slice(0, -4), want: "malformed verifier id" },
		{
			name: "an unknown algorithm",
			mangle: (s) => {
				const fields = s.split("+");
				const key = fromBase64(fields.slice(4).join("+"));
				key[0] = 2;
				return [...fields.slice(0, 4), toBase64(key)].join("+");
			},
			want: "unknown verifier algorithm",
		},
	];
	for (const c of malformed) {
		it(`rejects ${c.name} without quoting any of it`, async () => {
			const { skey } = generateKey(undefined, "example.com/log");
			const bad = c.mangle(skey);
			const err = await importSignerKey(bad).then(
				() => undefined,
				(e: unknown) => e as Error,
			);
			expect(err).toBeInstanceOf(Error);
			expect(err?.message).toMatch(/^importLogKey: not a valid note signer key/);
			expect(err?.message).toContain(c.want);
			for (const secret of secretsOf(skey)) {
				expect(err?.message).not.toContain(secret);
				expect(String(err?.stack)).not.toContain(secret);
			}
		});
	}

	it("refuses a missing key, naming how to make one", async () => {
		for (const skey of [undefined, ""]) {
			const err = await importSignerKey(skey).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(WebtesseraError);
			expect((err as WebtesseraError).code).toBe("INVALID_ARGUMENT");
			expect((err as Error).message).toMatch(/^importLogKey: no key \((undefined|an empty string)\)/);
			expect((err as Error).message).toContain("npx webtessera keygen");
		}
	});

	it("refuses anything but a string", async () => {
		await expect(importSignerKey(new Uint8Array(33) as unknown as string)).rejects.toThrow(
			"importLogKey takes a note signer key string",
		);
	});
});

describe("fromCryptoKeyPair", () => {
	it("wraps an application's Ed25519 key pair, which counts as durable", async () => {
		const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
		const key = await fromCryptoKeyPair("example.com/log", pair);
		expect(key.backend).toBe("webcrypto");
		expect(key.extractable).toBe(false);
		expect(isDurable(key)).toBe(true);
		const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
		expect(key.vkey.endsWith(toBase64(new Uint8Array([1, ...raw])))).toBe(true);
	});

	it("refuses a pair whose halves do not belong together", async () => {
		const a = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
		const b = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
		await expect(
			fromCryptoKeyPair("example.com/log", { privateKey: a.privateKey, publicKey: b.publicKey }),
		).rejects.toThrow("do not belong together");
	});

	it("refuses keys that are not Ed25519 signing keys", async () => {
		const ecdsa = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
			"sign",
			"verify",
		])) as CryptoKeyPair;
		await expect(fromCryptoKeyPair("example.com/log", ecdsa)).rejects.toThrow("needs an Ed25519 key pair");
		await expect(fromCryptoKeyPair("example.com/log", {} as CryptoKeyPair)).rejects.toThrow("takes a CryptoKeyPair");
	});
});

describe("assertLogKey", () => {
	it("refuses a private key string, saying how to import one", () => {
		const { skey } = generateKey(undefined, "example.com/log");
		expect(() => assertLogKey(skey, "openServerLog")).toThrow(/not a string.*importLogKey\(skey\)/);
		try {
			assertLogKey(skey, "openServerLog");
		} catch (err) {
			for (const secret of secretsOf(skey)) {
				expect((err as Error).message).not.toContain(secret);
			}
		}
	});

	it("refuses a note Signer and look-alikes, which are not LogKeys", async () => {
		const { skey } = generateKey(undefined, "example.com/log");
		const real = await generateLogKey("example.com/log");
		expect(() => assertLogKey(newSigner(skey), "x")).toThrow(/must be a LogKey made by/);
		expect(() => assertLogKey({ ...real.toJSON() }, "x")).toThrow(/must be a LogKey made by/);
		expect(() => assertLogKey(undefined, "x")).toThrow(/got undefined/);
		expect(() => assertLogKey(real, "x")).not.toThrow();
	});
});

describe("checkOrigin", () => {
	it("accepts the origins tlog-checkpoint recommends", () => {
		for (const o of ["example.com/log", "log.example", "árvore.example/exames"]) {
			expect(() => checkOrigin(o, "x")).not.toThrow();
		}
	});
});
