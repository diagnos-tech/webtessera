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
// Byte helpers for the JSON the notary speaks. atob, btoa and WebCrypto are global in Node,
// Bun, Deno and browsers, so nothing here depends on a runtime.

/** toBase64 encodes bytes as standard base64. */
export function toBase64(b: Uint8Array): string {
	return btoa(String.fromCharCode(...b));
}

/** fromBase64 decodes standard base64, and throws on anything else. */
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
		throw new TypeError("not standard base64");
	}
	return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** toHex encodes bytes as lowercase hex. */
export function toHex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** fromHex decodes hex, and throws on anything else. */
export function fromHex(s: string): Uint8Array<ArrayBuffer> {
	if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) {
		throw new TypeError("not hex");
	}
	return Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
}

/** sha256 returns the SHA-256 digest of data. */
export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
}

/** equalBytes reports whether a and b hold the same bytes. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}
