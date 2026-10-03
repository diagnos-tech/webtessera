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

// This file has no upstream counterpart. It signs HTTP requests with AWS Signature Version 4,
// header-based, as S3 and the services compatible with it expect them: synchronously, with
// @noble/hashes, so that it runs wherever the rest of the library does. See
// docs/decisions/0175-mirror-sinks.md.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, toUTF8 } from "../internal/gostd/bytes.ts";

/** AwsCredentials are the credentials a request is signed with. */
export interface AwsCredentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	/** sessionToken accompanies temporary credentials, and is sent as `x-amz-security-token`. */
	readonly sessionToken?: string;
}

/** SignV4Input is a request to sign. */
export interface SignV4Input {
	readonly method: string;
	readonly url: URL;
	/**
	 * headers are the headers the request will carry, besides `Host` (taken from url, as
	 * fetch sends it) and the ones signV4 adds. Every one of them is signed. A list rather
	 * than a Headers object, because repeated headers are joined differently ("a,b") in the
	 * canonical request than Headers joins them ("a, b").
	 */
	readonly headers: readonly (readonly [string, string])[];
	/**
	 * payloadHash is the lowercase hex SHA-256 of the body. S3 also accepts
	 * `UNSIGNED-PAYLOAD`; S3 sinks never use it.
	 */
	readonly payloadHash: string;
	readonly credentials: AwsCredentials;
	readonly region: string;
	readonly service: string;
	/**
	 * now is the signing time. It is read once and both the `x-amz-date` header and the
	 * credential scope's date come from it, so a request signed across midnight UTC cannot
	 * carry two different dates.
	 */
	readonly now: Date;
}

/** SignedV4 is the outcome of signing: the headers to add, and the intermediate values. */
export interface SignedV4 {
	/** headers are the headers to add to the request: `x-amz-date`, any `x-amz-security-token`, and `authorization`. */
	readonly headers: readonly (readonly [string, string])[];
	readonly canonicalRequest: string;
	readonly stringToSign: string;
	readonly signature: string;
}

/**
 * signV4 signs a request with AWS Signature Version 4, in the form S3 specifies: the path
 * URI-encoded once and not normalised ("Each path segment must be URI-encoded twice" holds
 * for every other AWS service, not for S3), the query parameters sorted by encoded name then
 * value, every header the request carries signed, and the payload hash both signed and, by
 * convention of the caller, sent as `x-amz-content-sha256`.
 *
 * The secret key never leaves this function in any form but the derived signature.
 */
export function signV4(input: SignV4Input): SignedV4 {
	const amzDate = formatAmzDate(input.now);
	const date = amzDate.slice(0, 8);
	const scope = `${date}/${input.region}/${input.service}/aws4_request`;

	const all: [string, string][] = input.headers.map(([k, v]) => [k, v]);
	all.push(["host", input.url.host], ["x-amz-date", amzDate]);
	const added: [string, string][] = [["x-amz-date", amzDate]];
	if (input.credentials.sessionToken !== undefined) {
		all.push(["x-amz-security-token", input.credentials.sessionToken]);
		added.push(["x-amz-security-token", input.credentials.sessionToken]);
	}

	const { canonical: canonicalHeaders, signed: signedHeaders } = canonicalizeHeaders(all);
	const canonicalRequest = [
		input.method.toUpperCase(),
		canonicalURI(input.url),
		canonicalQuery(input.url),
		canonicalHeaders,
		signedHeaders,
		input.payloadHash,
	].join("\n");
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, toHex(sha256(toUTF8(canonicalRequest)))].join("\n");

	let key = hmac(sha256, toUTF8(`AWS4${input.credentials.secretAccessKey}`), toUTF8(date));
	key = hmac(sha256, key, toUTF8(input.region));
	key = hmac(sha256, key, toUTF8(input.service));
	key = hmac(sha256, key, toUTF8("aws4_request"));
	const signature = toHex(hmac(sha256, key, toUTF8(stringToSign)));

	added.push([
		"authorization",
		`AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	]);
	return { headers: added, canonicalRequest, stringToSign, signature };
}

/** formatAmzDate renders a time as SigV4's ISO 8601 basic format, `YYYYMMDD'T'HHMMSS'Z'`. */
export function formatAmzDate(d: Date): string {
	return d
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

/**
 * uriEncode percent-encodes every byte of s's UTF-8 encoding except the RFC 3986 unreserved
 * characters, with uppercase hex digits, as SigV4 requires; with keepSlash, `/` is kept too.
 */
export function uriEncode(s: string, keepSlash: boolean): string {
	let out = "";
	for (const b of toUTF8(s)) {
		const c = String.fromCharCode(b);
		if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) {
			out += c;
		} else {
			out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

/**
 * canonicalURI encodes the URL's path once, segment by segment, without normalising it. The
 * WHATWG URL parser has already percent-encoded some characters and not others, so each
 * segment is decoded first and then encoded the SigV4 way.
 */
function canonicalURI(url: URL): string {
	const path = url.pathname === "" ? "/" : url.pathname;
	return path
		.split("/")
		.map((seg) => uriEncode(decode(seg), false))
		.join("/");
}

/** canonicalQuery sorts the query parameters by encoded name, then encoded value. */
function canonicalQuery(url: URL): string {
	const q = url.search.startsWith("?") ? url.search.slice(1) : url.search;
	if (q === "") {
		return "";
	}
	const pairs = q
		.split("&")
		.filter((p) => p !== "")
		.map((p): [string, string] => {
			const i = p.indexOf("=");
			const [k, v] = i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
			return [uriEncode(decode(k), false), uriEncode(decode(v), false)];
		});
	pairs.sort(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0));
	return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * canonicalizeHeaders lowercases names, trims values and collapses their inner whitespace,
 * joins repeated headers with commas in the order given, and sorts by name.
 */
function canonicalizeHeaders(headers: readonly (readonly [string, string])[]): { canonical: string; signed: string } {
	const byName = new Map<string, string[]>();
	for (const [k, v] of headers) {
		const name = k.toLowerCase();
		const value = v.trim().replace(/\s+/g, " ");
		const list = byName.get(name);
		if (list === undefined) {
			byName.set(name, [value]);
		} else {
			list.push(value);
		}
	}
	const names = [...byName.keys()].sort();
	return {
		canonical: names.map((n) => `${n}:${(byName.get(n) ?? []).join(",")}\n`).join(""),
		signed: names.join(";"),
	};
}

/** decode percent-decodes s, leaving it as it is if it is not valid percent-encoded UTF-8. */
function decode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}
