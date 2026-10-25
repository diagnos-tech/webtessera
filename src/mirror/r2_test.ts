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

import type { R2Bucket } from "@cloudflare/workers-types/index.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mirror, newR2Sink, newSinkTarget, type R2BucketLike, type Source } from "webtessera/mirror";
import { newFsck } from "../fsck/index.ts";
import { DefaultCacheControl } from "../http/resources.ts";
import { entriesOf, newTestLog, type TestLog } from "../http/testing/testlog.ts";
import { checkpointUnsafe } from "../internal/parse/parse.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";
import { isRecoverable } from "./retry.ts";
import { FakeR2 } from "./testing/faker2.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A log of 300 entries whose checkpoints at 100 and 300 are both kept.
let log: TestLog;
let cp100: Uint8Array;
let cp300: Uint8Array;

beforeAll(async () => {
	log = await newTestLog({ origin: "example.com/r2" });
	await log.add(entriesOf(100));
	cp100 = await log.reader.readCheckpoint();
	await log.add(entriesOf(200, 100));
	cp300 = await log.reader.readCheckpoint();
});

afterAll(async () => {
	await log.shutdown();
});

/** at returns the log as it was when cp was its checkpoint. */
function at(cp: Uint8Array): Source {
	return {
		readCheckpoint: async () => cp,
		readTile: (l, i, p, s) => log.reader.readTile(l, i, p, s),
		readEntryBundle: (i, p, s) => log.reader.readEntryBundle(i, p, s),
	};
}

function mirror(source: Source, bucket: R2BucketLike, prefix = "logs/a/"): Promise<void> {
	return new Mirror({ source, target: newSinkTarget(newR2Sink(bucket), { prefix }), numWorkers: 2 }).run();
}

function sizeOf(bucket: FakeR2, key: string): bigint | undefined {
	const o = bucket.objects.get(key);
	return o === undefined ? undefined : checkpointUnsafe(o.data).size;
}

describe("newR2Sink", () => {
	it("takes a Workers R2 binding as it is", () => {
		// Compile-time check: the typecheck is the test.
		const fromBinding = (b: R2Bucket): R2BucketLike => b;
		expect(fromBinding).toBeTypeOf("function");
		expect(() => newR2Sink({} as R2BucketLike)).toThrow(/R2 binding/);
		expect(() => newR2Sink(new FakeR2(), { checkpointAttempts: 0 })).toThrow(/checkpointAttempts/);
		expect(() => newR2Sink(new FakeR2(), { maxObjectBytes: 1.5 })).toThrow(/maxObjectBytes/);
	});

	it("publishes a log a mirror copies, with the metadata tlog-tiles prescribes, that verifies", async () => {
		const bucket = new FakeR2();
		await mirror(at(cp300), bucket);

		const checkpoint = bucket.objects.get("logs/a/checkpoint");
		expect(checkpoint?.data).toEqual(cp300);
		expect([checkpoint?.contentType, checkpoint?.cacheControl]).toEqual([
			"text/plain; charset=utf-8",
			DefaultCacheControl.checkpoint,
		]);
		const full = bucket.objects.get("logs/a/tile/0/000");
		expect([full?.contentType, full?.cacheControl]).toEqual(["application/octet-stream", DefaultCacheControl.full]);
		const partial = bucket.objects.get("logs/a/tile/entries/001.p/44");
		expect([partial?.contentType, partial?.cacheControl]).toEqual([
			"application/octet-stream",
			DefaultCacheControl.partial,
		]);
		// Every immutable resource was created, never overwritten.
		for (const p of bucket.puts.filter((p) => !p.key.endsWith("/checkpoint"))) {
			expect(p.onlyIf, p.key).toEqual({ etagDoesNotMatch: "*" });
		}

		const target = newSinkTarget(newR2Sink(bucket), { prefix: "logs/a/" });
		await newFsck(log.origin, log.verifier, target, defaultMerkleLeafHasher, { n: 2 }).check();
	});

	it("never replaces the checkpoint with one for a smaller tree", async () => {
		const bucket = new FakeR2();
		await mirror(at(cp300), bucket);
		const puts = bucket.puts.length;

		// A run that started from an older source, and finished after the newer one.
		await newR2Sink(bucket, { prefix: "logs/a/" }).put("checkpoint", cp100);
		expect(bucket.objects.get("logs/a/checkpoint")?.data).toEqual(cp300);
		expect(bucket.puts).toHaveLength(puts);

		// The same checkpoint again writes nothing either.
		await newR2Sink(bucket, { prefix: "logs/a/" }).put("checkpoint", cp300);
		expect(bucket.puts).toHaveLength(puts);
	});

	it("grows the checkpoint by compare-and-swap, deciding again when another writer got in first", async () => {
		const bucket = new FakeR2();
		const sink = newR2Sink(bucket);
		/** raceOnce plays another writer storing cp under the checkpoint's key, once, just before the sink's swap. */
		const raceOnce = (cp: Uint8Array): void => {
			let raced = false;
			bucket.beforePut = (key) => {
				if (key === "checkpoint" && !raced) {
					raced = true;
					bucket.store("checkpoint", cp);
				}
			};
		};

		// The first checkpoint is created only if there is none; another writer published a
		// larger one first, which this sink then leaves in place.
		raceOnce(cp300);
		await sink.put("checkpoint", cp100);
		expect(sizeOf(bucket, "checkpoint")).toBe(300n);
		expect(bucket.puts.at(-1)).toEqual({ key: "checkpoint", onlyIf: { etagDoesNotMatch: "*" }, written: false });

		// A swap over a checkpoint that another writer replaced in between fails, and the next
		// attempt swaps over what that writer stored.
		bucket.store("checkpoint", cp100);
		raceOnce(cp100);
		await sink.put("checkpoint", cp300);
		expect(sizeOf(bucket, "checkpoint")).toBe(300n);
		const swaps = bucket.puts.filter((p) => p.key === "checkpoint");
		expect(swaps.map((p) => p.written)).toEqual([false, false, true]);
		expect(swaps.at(-1)?.onlyIf).toEqual({ etagMatches: expect.stringMatching(/^etag-/) });
	});

	it("gives up, recoverably, when the checkpoint changes under every attempt", async () => {
		const bucket = new FakeR2();
		const sink = newR2Sink(bucket, { checkpointAttempts: 3 });
		bucket.store("checkpoint", cp100);
		bucket.beforePut = () => {
			bucket.store("checkpoint", cp100);
		};
		const err = await sink.put("checkpoint", cp300).catch((e: unknown) => e);
		expect(String(err)).toMatch(/changed under each of 3 attempts/);
		expect(isRecoverable(err)).toBe(true);
	});

	it("refuses to publish a checkpoint that does not parse, and replaces a stored one that does not", async () => {
		const bucket = new FakeR2();
		const sink = newR2Sink(bucket);
		await expect(sink.put("checkpoint", enc("not a checkpoint"))).rejects.toThrow();
		expect(bucket.objects.size).toBe(0);
		bucket.store("checkpoint", enc("garbage"));
		await sink.put("checkpoint", cp100);
		expect(bucket.objects.get("checkpoint")?.data).toEqual(cp100);
	});

	it("accepts an immutable object that is already there only if it holds the same bytes", async () => {
		const bucket = new FakeR2();
		const sink = newR2Sink(bucket);
		const tile = new Uint8Array(32 * 44).fill(7);
		await sink.put("tile/0/001.p/44", tile);
		await sink.put("tile/0/001.p/44", tile);

		const different = await sink
			.put(
				"tile/0/001.p/44",
				tile.map((b) => b ^ 1),
			)
			.catch((e: unknown) => e);
		expect(String(different)).toMatch(/R2 PUT tile\/0\/001\.p\/44: a different object is already stored there/);
		expect(isRecoverable(different)).toBe(false);
		const larger = await sink.put("tile/0/001.p/44", tile.subarray(0, 32)).catch((e: unknown) => e);
		expect(isRecoverable(larger)).toBe(false);

		// Deleted between the conditional write and the read back: try again.
		const vanishing: R2BucketLike = { put: async () => null, get: async () => null };
		const gone = await newR2Sink(vanishing)
			.put("tile/0/002.p/1", new Uint8Array(32))
			.catch((e: unknown) => e);
		expect(String(gone)).toMatch(/has since been deleted/);
		expect(isRecoverable(gone)).toBe(true);
	});

	it("writes keys that are no log resource as they are, and immutable ones unconditionally when told", async () => {
		const bucket = new FakeR2();
		await newR2Sink(bucket).put("README", enc("hello"));
		expect(bucket.puts.at(-1)).toMatchObject({ key: "README", onlyIf: undefined });
		expect(bucket.objects.get("README")?.contentType).toBeUndefined();

		await newR2Sink(bucket, { conditionalWrites: false }).put("tile/0/000", new Uint8Array(32 * 256));
		expect(bucket.puts.at(-1)).toMatchObject({ key: "tile/0/000", onlyIf: undefined });
		expect(bucket.objects.get("tile/0/000")?.cacheControl).toBe(DefaultCacheControl.full);
	});

	it("reads objects back, capped, and refuses keys an HTTP client would rewrite", async () => {
		const bucket = new FakeR2();
		const sink = newR2Sink(bucket, { prefix: "p/", maxObjectBytes: 4, cacheControl: { checkpoint: "max-age=5" } });
		expect(await sink.get("checkpoint")).toBeUndefined();
		bucket.store("p/small", enc("abcd"));
		bucket.store("p/large", enc("abcde"));
		expect(await sink.get("small")).toEqual(enc("abcd"));
		await expect(sink.get("large")).rejects.toThrow(/larger than the 4 bytes/);
		await expect(sink.put("../escape", enc("x"))).rejects.toThrow(/invalid object key/);
		await expect(newR2Sink(bucket).put("", enc("x"))).rejects.toThrow(/invalid object key/);

		await newR2Sink(bucket, { cacheControl: { checkpoint: "max-age=5" } }).put("checkpoint", cp100);
		expect(bucket.objects.get("checkpoint")?.cacheControl).toBe("max-age=5");
	});
});
