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

import { describe, expect, it } from "vitest";
import {
	isRecoverable,
	newS3Sink,
	newSinkTarget,
	newSourceFetch,
	S3Error,
	type S3SinkOptions,
} from "webtessera/mirror";
import { FakeS3 } from "./testing/fakes3.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const secretAccessKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

function setup(overrides: Partial<S3SinkOptions> = {}, sessionToken?: string) {
	const s3 = new FakeS3("AKIAIOSFODNN7EXAMPLE", secretAccessKey, "eu-west-1", sessionToken);
	const sink = newS3Sink({
		endpoint: "http://localhost:9000",
		bucket: "logs",
		region: "eu-west-1",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey,
		...(sessionToken === undefined ? {} : { sessionToken }),
		fetch: s3.fetch,
		...overrides,
	});
	return { s3, sink };
}

describe("newS3Sink", () => {
	it("stores and reads objects with requests an independent SigV4 implementation accepts", async () => {
		const { s3, sink } = setup({ prefix: "mirrors/a/" });
		await sink.put("tile/entries/x001/234.p/7", enc("bundle"));
		expect(await sink.get("tile/entries/x001/234.p/7")).toEqual(enc("bundle"));
		expect(await sink.get("checkpoint")).toBeUndefined();
		expect([...s3.objects.keys()]).toEqual(["/logs/mirrors/a/tile/entries/x001/234.p/7"]);
		expect(s3.requests.every((r) => r.redirect === "manual" && r.credentials === "omit")).toBe(true);
	});

	it("signs with temporary credentials", async () => {
		const { s3, sink } = setup({}, "FQoGZXIvYXdzEXAMPLEtoken+/=");
		await sink.put("checkpoint", enc("cp"));
		expect(s3.requests[0]?.headers.get("x-amz-security-token")).toBe("FQoGZXIvYXdzEXAMPLEtoken+/=");
		expect(s3.requests[0]?.headers.get("authorization")).toContain("x-amz-security-token");
	});

	it("addresses virtual-hosted buckets", async () => {
		const { s3, sink } = setup({ endpoint: "https://s3.eu-west-1.amazonaws.com", addressing: "virtual-host" });
		await sink.put("tile/0/000", new Uint8Array(32));
		expect(s3.requests[0]?.url).toBe("https://logs.s3.eu-west-1.amazonaws.com/tile/0/000");
	});

	it("stores each object with the metadata tlog-tiles prescribes, and signs its body", async () => {
		const { s3, sink } = setup();
		await sink.put("checkpoint", enc("cp\n"));
		await sink.put("tile/0/x001/000", new Uint8Array(8192));
		await sink.put("tile/1/000.p/3", new Uint8Array(96));
		expect(s3.objects.get("/logs/checkpoint")).toMatchObject({
			contentType: "text/plain; charset=utf-8",
			cacheControl: "no-cache",
		});
		expect(s3.objects.get("/logs/tile/0/x001/000")).toMatchObject({
			contentType: "application/octet-stream",
			cacheControl: "public, max-age=31536000, immutable",
		});
		expect(s3.objects.get("/logs/tile/1/000.p/3")?.cacheControl).toBe("public, max-age=60");
		// The checkpoint is replaced on every run; resources never are.
		expect(s3.requests[0]?.headers.get("if-none-match")).toBeNull();
		expect(s3.requests[1]?.headers.get("if-none-match")).toBe("*");
	});

	it("accepts an immutable object that is already there only if it holds the same bytes", async () => {
		const { s3, sink } = setup();
		await sink.put("tile/0/000", enc("first"));
		await sink.put("tile/0/000", enc("first"));
		expect(s3.objects.get("/logs/tile/0/000")?.data).toEqual(enc("first"));
		for (const other of ["second", "firs", "first!"]) {
			const err = await sink.put("tile/0/000", enc(other)).catch((e: unknown) => e);
			expect(err instanceof Error ? err.message : "", other).toContain("logs/tile/0/000");
			expect(err instanceof Error ? err.message : "", other).toContain("a different object is already stored there");
			expect(isRecoverable(err), other).toBe(false);
		}
		expect(s3.objects.get("/logs/tile/0/000")?.data).toEqual(enc("first"));

		const plain = setup({ conditionalWrites: false });
		await plain.sink.put("tile/0/000", enc("first"));
		await plain.sink.put("tile/0/000", enc("second"));
		expect(plain.s3.objects.get("/logs/tile/0/000")?.data).toEqual(enc("second"));
		expect(plain.s3.requests.some((r) => r.headers.has("if-none-match"))).toBe(false);
	});

	it("keeps each object's metadata and conditional write under a mirror target's prefix", async () => {
		const { s3, sink } = setup({ prefix: "mirrors/" });
		const t = newSinkTarget(sink, { prefix: "a/" });
		await t.writeTile(0n, 1n, 0, new Uint8Array(8192));
		await t.writeEntryBundle(0n, 7, enc("bundle"));
		await t.writeCheckpoint(enc("cp\n"));
		expect(s3.objects.get("/logs/mirrors/a/tile/0/001")).toMatchObject({
			contentType: "application/octet-stream",
			cacheControl: "public, max-age=31536000, immutable",
		});
		expect(s3.objects.get("/logs/mirrors/a/tile/entries/000.p/7")?.cacheControl).toBe("public, max-age=60");
		expect(s3.objects.get("/logs/mirrors/a/checkpoint")).toMatchObject({
			contentType: "text/plain; charset=utf-8",
			cacheControl: "no-cache",
		});
		expect(s3.requests.map((r) => r.headers.get("if-none-match"))).toEqual(["*", "*", null]);
		expect(await t.readCheckpoint()).toEqual(enc("cp\n"));
		expect(await t.readEntryBundle(0n, 7)).toEqual(enc("bundle"));
	});

	it("refuses limits that are not positive integers", () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => setup({ attempts: bad }), `attempts ${bad}`).toThrow(RangeError);
			expect(() => setup({ maxObjectBytes: bad }), `maxObjectBytes ${bad}`).toThrow(RangeError);
			expect(() => newSourceFetch({ maxBytes: bad }), `maxBytes ${bad}`).toThrow(RangeError);
		}
	});

	it("retries throttling and server errors", async () => {
		const { s3, sink } = setup();
		s3.failNext = [503, 500];
		await sink.put("checkpoint", enc("cp"));
		expect(s3.requests).toHaveLength(3);

		s3.failNext = [503, 503, 503];
		const err = await sink.put("checkpoint", enc("cp")).catch((e: unknown) => e);
		expect(String(err)).toContain("S3 PUT logs/checkpoint: 503 SlowDown");
	});

	it("does not retry a refusal, and reports only its status and code", async () => {
		const { s3, sink } = setup();
		s3.failNext = [403];
		const err = await sink.put("checkpoint", enc("cp")).catch((e: unknown) => e);
		expect(s3.requests).toHaveLength(1);
		expect(err instanceof Error ? err.message : "").toContain("S3 PUT logs/checkpoint: 403 AccessDenied");
		const cause = (err as { errors?: unknown[] }).errors?.[0];
		expect(cause).toBeInstanceOf(S3Error);
		expect((cause as S3Error).code).toBe("AccessDenied");
		const text = `${String(err)} ${JSON.stringify(err)}`;
		for (const secret of [secretAccessKey, "StringToSign", "Signature=", "AWS4-HMAC-SHA256"]) {
			expect(text).not.toContain(secret);
		}
	});

	it("refuses to follow redirects", async () => {
		const { sink } = setup({
			fetch: async () => new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/" } }),
		});
		await expect(sink.put("checkpoint", enc("cp"))).rejects.toThrow(/redirect refused/);
	});

	it("rejects a wrong signature as the service would", async () => {
		const { sink } = setup({ secretAccessKey: "not-the-key" });
		await expect(sink.put("checkpoint", enc("cp"))).rejects.toThrow(/403 SignatureDoesNotMatch/);
	});

	it("caps what it reads", async () => {
		const { sink } = setup({ maxObjectBytes: 4 });
		await sink.put("checkpoint", enc("12345"));
		await expect(sink.get("checkpoint")).rejects.toThrow(/limit/);
	});

	it("refuses keys fetch would rewrite, and bad configuration", async () => {
		const { s3, sink } = setup();
		await expect(sink.put("tile/../checkpoint", enc(""))).rejects.toThrow(/invalid object key/);
		await expect(sink.get("./checkpoint")).rejects.toThrow(/invalid object key/);
		expect(s3.requests).toHaveLength(0);
		expect(() => setup({ bucket: "a/b" })).toThrow(/bucket/);
		expect(() => setup({ endpoint: "https://s3.example/?x=1" })).toThrow(/query/);
	});

	it("signs with one reading of the clock per request", async () => {
		let reads = 0;
		const { s3, sink } = setup({
			now: () => {
				reads++;
				return new Date("2026-12-31T23:59:59.999Z");
			},
		});
		await sink.put("checkpoint", enc("cp"));
		expect(reads).toBe(1);
		expect(s3.requests[0]?.headers.get("x-amz-date")).toBe("20261231T235959Z");
		expect(s3.requests[0]?.headers.get("authorization")).toContain("/20261231/eu-west-1/s3/aws4_request");
	});
});
