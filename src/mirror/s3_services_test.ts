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

// Runs the S3 sink, and a verified mirror into it, against a real S3-compatible service named
// by S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (MinIO in
// CI; AWS S3, Cloudflare R2, Google Cloud Storage, Backblaze B2 and others work the same).
// Every run writes under a prefix of its own and leaves its objects behind. The bucket is
// created if it does not exist and the credentials allow it. `bun run test:services` runs it;
// without the variables it fails rather than skips.

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { newS3Sink, newSinkTarget, newVerifiedMirror, signV4 } from "webtessera/mirror";
import { newFsck } from "../fsck/index.ts";
import { entriesOf, newTestLog } from "../http/testing/testlog.ts";
import { toHex } from "../internal/gostd/bytes.ts";
import { checkpointUnsafe } from "../internal/parse/parse.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const names = ["S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

interface s3Config {
	readonly endpoint: string;
	readonly bucket: string;
	readonly region: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

function config(): s3Config {
	const missing = names.filter((n) => (env[n] ?? "") === "");
	if (missing.length > 0) {
		throw new Error(
			`${missing.join(", ")} not set: point S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and ` +
				"S3_SECRET_ACCESS_KEY at an S3-compatible service (e.g. MinIO at http://127.0.0.1:9000)",
		);
	}
	return {
		endpoint: env.S3_ENDPOINT as string,
		bucket: env.S3_BUCKET as string,
		region: env.S3_REGION as string,
		accessKeyId: env.S3_ACCESS_KEY_ID as string,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
	};
}

/** ensureBucket creates the bucket, ignoring "already exists" and any refusal to create one. */
async function ensureBucket(c: s3Config): Promise<void> {
	const url = new URL(c.endpoint);
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${c.bucket}`;
	const payloadHash = toHex(sha256(new Uint8Array(0)));
	const headers: [string, string][] = [["x-amz-content-sha256", payloadHash]];
	const signed = signV4({
		method: "PUT",
		url,
		headers,
		payloadHash,
		credentials: c,
		region: c.region,
		service: "s3",
		now: new Date(),
	});
	const r = await fetch(url, { method: "PUT", headers: [...headers, ...signed.headers] as [string, string][] });
	await r.body?.cancel();
}

const prefix = `webtessera-services/${Date.now()}-${Math.random().toString(36).slice(2)}/`;

describe("S3 service", () => {
	it("is configured", () => {
		for (const n of names) {
			expect(env[n], `${n} must be set; see this file's header`).toBeTruthy();
		}
	});

	it("stores and reads objects, with tlog-tiles metadata", async () => {
		const c = config();
		await ensureBucket(c);
		const sink = newS3Sink({ ...c, prefix: `${prefix}objects/` });
		const data = new TextEncoder().encode("hello, bucket");
		await sink.put("tile/0/000.p/1", data);
		expect(await sink.get("tile/0/000.p/1")).toEqual(data);
		expect(await sink.get("tile/0/999")).toBeUndefined();
		// Writing an immutable object again succeeds whether or not the service honours
		// If-None-Match, and never corrupts it.
		await sink.put("tile/0/000.p/1", data);
		expect(await sink.get("tile/0/000.p/1")).toEqual(data);
		await sink.put("checkpoint", data);
		await sink.put("checkpoint", new TextEncoder().encode("replaced"));
		expect(new TextDecoder().decode(await sink.get("checkpoint"))).toBe("replaced");
	});

	it("receives a verified mirror of a log, and resumes it", async () => {
		const c = config();
		await ensureBucket(c);
		const log = await newTestLog({ origin: "example.com/s3-mirrored" });
		try {
			const sink = newS3Sink({ ...c, prefix: `${prefix}log/` });
			await log.add(entriesOf(300));
			const options = { source: log.reader, target: sink, origin: log.origin, verifier: log.verifier, numWorkers: 4 };
			await newVerifiedMirror(options).run();
			await log.add(entriesOf(250, 300));
			await newVerifiedMirror(options).run();

			const copy = newSinkTarget(sink);
			expect(checkpointUnsafe(await copy.readCheckpoint()).size).toBe(550n);
			await newFsck(log.origin, log.verifier, copy, defaultMerkleLeafHasher, { n: 4 }).check();
		} finally {
			await log.shutdown();
		}
	});
});
