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

// The R2 sink against workerd's own R2 binding: the conditional writes it relies on
// (`etagDoesNotMatch: "*"` to create, `etagMatches` to swap) must behave there as the
// Node suite's fake assumes, and the metadata it sets must come back as R2 stores it.

import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newFsck } from "../fsck/index.ts";
import { DefaultCacheControl } from "../http/resources.ts";
import { entriesOf, newTestLog, type TestLog } from "../http/testing/testlog.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";
import { Mirror, type Source } from "./mirror.ts";
import { newR2Sink } from "./r2.ts";
import { isRecoverable } from "./retry.ts";
import { newSinkTarget } from "./sink.ts";

let log: TestLog;
let cp40: Uint8Array;
let cp300: Uint8Array;
let prefixes = 0;

beforeAll(async () => {
	log = await newTestLog({ origin: "example.com/r2-workers" });
	await log.add(entriesOf(40));
	cp40 = await log.reader.readCheckpoint();
	await log.add(entriesOf(260, 40));
	cp300 = await log.reader.readCheckpoint();
});

afterAll(async () => {
	await log.shutdown();
});

function at(cp: Uint8Array): Source {
	return {
		readCheckpoint: async () => cp,
		readTile: (l, i, p, s) => log.reader.readTile(l, i, p, s),
		readEntryBundle: (i, p, s) => log.reader.readEntryBundle(i, p, s),
	};
}

/** freshPrefix keeps each test's objects apart in the shared bucket. */
function freshPrefix(): string {
	return `t${++prefixes}/`;
}

describe("newR2Sink in workerd", () => {
	it("publishes a log that verifies, with tlog-tiles metadata", async () => {
		const prefix = freshPrefix();
		const target = newSinkTarget(newR2Sink(env.BUCKET), { prefix });
		await new Mirror({ source: at(cp300), target, numWorkers: 2 }).run();

		const checkpoint = await env.BUCKET.head(`${prefix}checkpoint`);
		expect(checkpoint?.httpMetadata).toMatchObject({
			contentType: "text/plain; charset=utf-8",
			cacheControl: DefaultCacheControl.checkpoint,
		});
		const full = await env.BUCKET.head(`${prefix}tile/0/000`);
		expect(full?.httpMetadata?.cacheControl).toBe(DefaultCacheControl.full);
		const partial = await env.BUCKET.head(`${prefix}tile/0/001.p/44`);
		expect(partial?.httpMetadata?.cacheControl).toBe(DefaultCacheControl.partial);

		await newFsck(log.origin, log.verifier, target, defaultMerkleLeafHasher, { n: 2 }).check();
	});

	it("never moves the checkpoint back, and swaps it forward", async () => {
		const prefix = freshPrefix();
		const sink = newR2Sink(env.BUCKET, { prefix });
		await sink.put("checkpoint", cp300);
		await sink.put("checkpoint", cp40);
		expect(new Uint8Array(await (await env.BUCKET.get(`${prefix}checkpoint`))!.arrayBuffer())).toEqual(cp300);

		const other = freshPrefix();
		const forward = newR2Sink(env.BUCKET, { prefix: other });
		await forward.put("checkpoint", cp40);
		await forward.put("checkpoint", cp300);
		expect(new Uint8Array(await (await env.BUCKET.get(`${other}checkpoint`))!.arrayBuffer())).toEqual(cp300);
	});

	it("creates immutable objects once, and refuses different bytes under an existing key", async () => {
		const sink = newR2Sink(env.BUCKET, { prefix: freshPrefix() });
		const tile = new Uint8Array(32 * 3).fill(9);
		await sink.put("tile/0/000.p/3", tile);
		await sink.put("tile/0/000.p/3", tile);
		const err = await sink
			.put(
				"tile/0/000.p/3",
				tile.map((b) => b ^ 1),
			)
			.catch((e: unknown) => e);
		expect(String(err)).toMatch(/a different object is already stored there/);
		expect(isRecoverable(err)).toBe(false);
	});
});
