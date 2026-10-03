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
// One entry of a session log: a record of one exchange between the browser and the server. The
// browser writes it; the server and any auditor read it.
//
// It holds digests of the bodies, not the bodies. The log is mirrored to a bucket and read by
// auditors, who need to know that something was sent, not what; and whoever holds a body can
// prove later that it is the one recorded, by hashing it.

/** Interaction is one request the browser made to the server, and the answer it got. */
export interface Interaction {
	/** at is when the answer arrived, by the browser's clock (ISO 8601). */
	readonly at: string;
	readonly method: string;
	/** path is the request's path and query. */
	readonly path: string;
	readonly status: number;
	/** request is the SHA-256 of the request body, base64; of the empty string if it had none. */
	readonly request: string;
	/** response is the SHA-256 of the response body, base64. */
	readonly response: string;
}

const version = "webtessera-example-session/v1";

/**
 * encodeInteraction returns the entry for an interaction: JSON, with the keys always in the
 * same order, so that the same interaction always makes the same bytes.
 */
export function encodeInteraction(i: Interaction): Uint8Array {
	const { at, method, path, status, request, response } = i;
	return new TextEncoder().encode(JSON.stringify({ v: version, at, method, path, status, request, response }));
}

/** decodeInteraction parses an entry, and throws if it is not an interaction. */
export function decodeInteraction(entry: Uint8Array): Interaction {
	const o = JSON.parse(new TextDecoder().decode(entry)) as Record<string, unknown>;
	const { v, at, method, path, status, request, response } = o;
	if (
		v !== version ||
		typeof at !== "string" ||
		typeof method !== "string" ||
		typeof path !== "string" ||
		typeof status !== "number" ||
		typeof request !== "string" ||
		typeof response !== "string"
	) {
		throw new TypeError("not a session interaction entry");
	}
	return { at, method, path, status, request, response };
}

/** bodyDigest returns the base64 SHA-256 of a body, as an interaction records it. */
export async function bodyDigest(body: Uint8Array): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body)));
	return btoa(String.fromCharCode(...d));
}
