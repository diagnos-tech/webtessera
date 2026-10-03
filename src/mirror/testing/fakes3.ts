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

// A test-only, in-memory S3 endpoint that checks every request's SigV4 signature with an
// independent implementation (aws4fetch) before acting on it, and the body against the
// signed x-amz-content-sha256. Not part of the published build.

import { sha256 } from "@noble/hashes/sha2.js";
import { AwsV4Signer } from "aws4fetch";
import type { FetchFn } from "../../client/fetcher.ts";
import { toHex } from "../../internal/gostd/bytes.ts";

/** StoredObject is an object the fake holds, with the metadata it was written with. */
export interface StoredObject {
	readonly data: Uint8Array;
	readonly contentType: string | null;
	readonly cacheControl: string | null;
}

/** RecordedRequest is what the fake saw of one request. */
export interface RecordedRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Headers;
	readonly redirect: RequestRedirect | undefined;
	readonly credentials: RequestCredentials | undefined;
}

/** FakeS3 is an in-memory, path-style or virtual-hosted S3 endpoint. */
export class FakeS3 {
	readonly objects = new Map<string, StoredObject>();
	readonly requests: RecordedRequest[] = [];
	/** failNext answers the next requests with these statuses (and an S3 error document) instead. */
	failNext: number[] = [];

	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly region: string;
	readonly sessionToken: string | undefined;

	constructor(accessKeyId: string, secretAccessKey: string, region: string, sessionToken?: string) {
		this.accessKeyId = accessKeyId;
		this.secretAccessKey = secretAccessKey;
		this.region = region;
		this.sessionToken = sessionToken;
	}

	/** fetch is the endpoint, to hand to newS3Sink. */
	readonly fetch: FetchFn = async (input, init) => {
		const headers = new Headers(init?.headers);
		this.requests.push({
			method: init?.method ?? "GET",
			url: input,
			headers,
			redirect: init?.redirect,
			credentials: init?.credentials,
		});
		const failure = this.failNext.shift();
		if (failure !== undefined) {
			return errorResponse(failure, failure === 403 ? "AccessDenied" : "SlowDown");
		}
		const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(0);
		if (!(await this.#signatureValid(input, init?.method ?? "GET", headers))) {
			return errorResponse(403, "SignatureDoesNotMatch");
		}
		if (headers.get("x-amz-content-sha256") !== toHex(sha256(body))) {
			return errorResponse(400, "XAmzContentSHA256Mismatch");
		}
		const key = new URL(input).pathname;
		if (init?.method === "PUT") {
			if (headers.get("if-none-match") === "*" && this.objects.has(key)) {
				return errorResponse(412, "PreconditionFailed");
			}
			this.objects.set(key, {
				data: new Uint8Array(body),
				contentType: headers.get("content-type"),
				cacheControl: headers.get("cache-control"),
			});
			return new Response(null, { status: 200 });
		}
		const o = this.objects.get(key);
		return o === undefined ? errorResponse(404, "NoSuchKey") : new Response(o.data as BodyInit, { status: 200 });
	};

	async #signatureValid(url: string, method: string, headers: Headers): Promise<boolean> {
		const auth = headers.get("authorization") ?? "";
		const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
		const toSign: Record<string, string> = {};
		for (const h of signed) {
			if (h !== "host" && h !== "x-amz-date" && h !== "x-amz-security-token") {
				toSign[h] = headers.get(h) ?? "";
			}
		}
		const oracle = new AwsV4Signer({
			method,
			url,
			headers: toSign,
			accessKeyId: this.accessKeyId,
			secretAccessKey: this.secretAccessKey,
			...(this.sessionToken === undefined ? {} : { sessionToken: this.sessionToken }),
			service: "s3",
			region: this.region,
			datetime: headers.get("x-amz-date") ?? "",
			allHeaders: true,
		});
		const want = (await oracle.sign()).headers.get("Authorization");
		return (
			want === auth && (this.sessionToken === undefined || headers.get("x-amz-security-token") === this.sessionToken)
		);
	}
}

function errorResponse(status: number, code: string): Response {
	// Real S3 error documents echo the string to sign and the canonical request; the sink
	// must not pass those on.
	const xml =
		`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>m</Message>` +
		"<StringToSign>AWS4-HMAC-SHA256 secret-ish</StringToSign><CanonicalRequest>PUT /x</CanonicalRequest></Error>";
	return new Response(xml, { status, headers: { "Content-Type": "application/xml" } });
}
