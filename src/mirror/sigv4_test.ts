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

import { sha256 } from "@noble/hashes/sha2.js";
import { AwsV4Signer } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { toHex, toUTF8 } from "../internal/gostd/bytes.ts";
import { formatAmzDate, signV4, uriEncode } from "./sigv4.ts";
import { type SigV4SuiteCase, sigV4Suite } from "./testing/sigv4_suite.ts";

/**
 * notApplicable are the suite's cases that do not describe S3's signing, with the reason.
 * Every other case must reproduce the suite's canonical request, string to sign and
 * signature exactly.
 */
const notApplicable: Record<string, string> = {
	// Path normalisation is for services other than S3, which signs the path as sent.
	"get-relative-normalized": "normalises dot segments",
	"get-relative-relative-normalized": "normalises dot segments",
	"get-slash-dot-slash-normalized": "normalises dot segments",
	"get-slash-normalized": "collapses slashes",
	"get-slash-pointless-dot-normalized": "normalises dot segments",
	"get-slashes-normalized": "collapses slashes",
	// A WHATWG URL, and so every fetch, resolves dot segments before sending; no fetch can
	// carry these paths, so there is nothing for an S3 client to sign. The S3 sink refuses
	// keys with such segments.
	"get-relative-unnormalized": "dot segments cannot be sent by fetch",
	"get-relative-relative-unnormalized": "dot segments cannot be sent by fetch",
	"get-slash-dot-slash-unnormalized": "dot segments cannot be sent by fetch",
	"get-slash-pointless-dot-unnormalized": "dot segments cannot be sent by fetch",
	// The token is added after signing, unsigned; S3 requires every x-amz-* header signed.
	"post-sts-header-after": "leaves the session token unsigned",
};

interface parsedRequest {
	readonly method: string;
	readonly url: URL;
	readonly headers: [string, string][];
	readonly body: Uint8Array;
}

/** parseRequest reads a suite request.txt: request line, headers (with folded lines), body. */
function parseRequest(raw: string): parsedRequest {
	const blank = raw.indexOf("\n\n");
	const head = blank < 0 ? raw : raw.slice(0, blank);
	const body = blank < 0 ? "" : raw.slice(blank + 2);
	const [requestLine = "", ...lines] = head.split("\n");
	const parts = requestLine.split(" ");
	const method = parts[0] ?? "";
	const target = parts.slice(1, -1).join(" ");
	const headers: [string, string][] = [];
	for (const line of lines) {
		if (line === "") {
			continue;
		}
		const last = headers[headers.length - 1];
		if (/^\s/.test(line) && last !== undefined) {
			last[1] += `\n${line}`;
			continue;
		}
		const i = line.indexOf(":");
		headers.push([line.slice(0, i), line.slice(i + 1)]);
	}
	const host = headers.find(([k]) => k.toLowerCase() === "host")?.[1].trim() ?? "";
	return {
		method,
		url: new URL(`https://${host}${target}`),
		headers: headers.filter(([k]) => k.toLowerCase() !== "host"),
		body: toUTF8(body),
	};
}

function runCase(c: SigV4SuiteCase): ReturnType<typeof signV4> {
	const r = parseRequest(c.request);
	const payloadHash = toHex(sha256(r.body));
	const headers = c.context.sign_body
		? [...r.headers, ["x-amz-content-sha256", payloadHash] as [string, string]]
		: r.headers;
	const token = c.context.credentials.token;
	return signV4({
		method: r.method,
		url: r.url,
		headers,
		payloadHash,
		credentials: {
			accessKeyId: c.context.credentials.access_key_id,
			secretAccessKey: c.context.credentials.secret_access_key,
			...(token === undefined ? {} : { sessionToken: token }),
		},
		region: c.context.region,
		service: c.context.service,
		now: new Date(c.context.timestamp),
	});
}

describe("signV4 against the AWS SigV4 test suite", () => {
	for (const c of sigV4Suite) {
		const skip = notApplicable[c.name];
		if (skip !== undefined) {
			continue;
		}
		it(c.name, () => {
			const got = runCase(c);
			expect(got.canonicalRequest).toBe(c.canonicalRequest);
			expect(got.stringToSign).toBe(c.stringToSign);
			expect(got.signature).toBe(c.signature);
			const auth = got.headers.find(([k]) => k === "authorization")?.[1];
			expect(auth).toContain(`Signature=${c.signature}`);
		});
	}

	it("lists every case it does not run, and runs the rest", () => {
		const names = new Set(sigV4Suite.map((c) => c.name));
		for (const n of Object.keys(notApplicable)) {
			expect(names.has(n), n).toBe(true);
		}
		expect(sigV4Suite.length - Object.keys(notApplicable).length).toBeGreaterThanOrEqual(27);
	});
});

describe("signV4 against aws4fetch, for S3 requests", () => {
	const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
	const datetime = "20261002T235959Z";
	const cases: {
		name: string;
		method: string;
		url: string;
		body: string;
		token?: string;
		extra?: [string, string][];
	}[] = [
		{ name: "path-style PUT of a tile", method: "PUT", url: "http://localhost:9000/bucket/tile/0/x001/234", body: "x" },
		{
			name: "virtual-host PUT of a partial bundle",
			method: "PUT",
			url: "https://bucket.s3.eu-west-1.amazonaws.com/logs/a/tile/entries/000.p/7",
			body: "entries",
			extra: [
				["content-type", "application/octet-stream"],
				["cache-control", "public, max-age=60"],
				["if-none-match", "*"],
			],
		},
		{
			name: "GET of the checkpoint",
			method: "GET",
			url: "https://acct.r2.cloudflarestorage.com/b/checkpoint",
			body: "",
		},
		{
			name: "keys that need encoding",
			method: "PUT",
			url: `https://storage.googleapis.com/b/${encodeURIComponent("a b+c=d&e")}/${encodeURIComponent("ሴ!*'()")}`,
			body: "y",
		},
		{
			name: "a session token",
			method: "PUT",
			url: "https://s3.us-west-002.backblazeb2.com/b/checkpoint",
			body: "cp",
			token: "FQoGZXIvYXdzEXAMPLE//token+/=",
		},
		{ name: "a query", method: "GET", url: "https://h.example/b?prefix=tile%2F&list-type=2&a=", body: "" },
	];
	for (const c of cases) {
		it(c.name, async () => {
			const body = toUTF8(c.body);
			const payloadHash = toHex(sha256(body));
			const headers: [string, string][] = [["x-amz-content-sha256", payloadHash], ...(c.extra ?? [])];
			const region = "us-east-1";
			const oracle = new AwsV4Signer({
				method: c.method,
				url: c.url,
				headers: Object.fromEntries(headers),
				accessKeyId: credentials.accessKeyId,
				secretAccessKey: credentials.secretAccessKey,
				...(c.token === undefined ? {} : { sessionToken: c.token }),
				service: "s3",
				region,
				datetime,
				allHeaders: true,
			});
			const want = (await oracle.sign()).headers.get("Authorization");
			const got = signV4({
				method: c.method,
				url: new URL(c.url),
				headers,
				payloadHash,
				credentials: c.token === undefined ? credentials : { ...credentials, sessionToken: c.token },
				region,
				service: "s3",
				now: new Date("2026-10-02T23:59:59Z"),
			});
			expect(got.headers.find(([k]) => k === "authorization")?.[1]).toBe(want);
		});
	}
});

describe("signV4 helpers", () => {
	it("formats the signing time in ISO 8601 basic format", () => {
		expect(formatAmzDate(new Date("2015-08-30T12:36:00.123Z"))).toBe("20150830T123600Z");
	});

	it("takes the scope's date and x-amz-date from one reading of the clock", () => {
		const got = signV4({
			method: "GET",
			url: new URL("https://h.example/b/k"),
			headers: [],
			payloadHash: toHex(sha256(new Uint8Array(0))),
			credentials: { accessKeyId: "A", secretAccessKey: "S" },
			region: "auto",
			service: "s3",
			now: new Date("2026-12-31T23:59:59.999Z"),
		});
		expect(got.headers.find(([k]) => k === "x-amz-date")?.[1]).toBe("20261231T235959Z");
		expect(got.stringToSign).toContain("\n20261231/auto/s3/aws4_request\n");
	});

	it("never puts the secret key in what it returns", () => {
		const secretAccessKey = "sEcReT/KEY+do-not-leak";
		const got = signV4({
			method: "PUT",
			url: new URL("https://h.example/b/k"),
			headers: [],
			payloadHash: "UNSIGNED-PAYLOAD",
			credentials: { accessKeyId: "A", secretAccessKey },
			region: "r",
			service: "s3",
			now: new Date(0),
		});
		expect(JSON.stringify(got)).not.toContain(secretAccessKey);
	});

	it("encodes everything but the unreserved characters, once", () => {
		expect(uriEncode("a-b_c.d~e f/g%h+ሴ", false)).toBe("a-b_c.d~e%20f%2Fg%25h%2B%E1%88%B4");
		expect(uriEncode("tile/entries/000.p/7", true)).toBe("tile/entries/000.p/7");
	});
});
