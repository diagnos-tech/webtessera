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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newLogHandler } from "webtessera/http";
import {
	newS3Sink,
	newSinkTarget,
	newSourceFetch,
	newVerifiedMirror,
	newVerifyingSource,
	type Sink,
	type Source,
} from "webtessera/mirror";
import type { FetchFn } from "../client/fetcher.ts";
import { newFsck } from "../fsck/index.ts";
import { entriesOf, fetchVia, newTestLog, type TestLog } from "../http/testing/testlog.ts";
import { checkpointUnsafe } from "../internal/parse/parse.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { generateKey, newSigner, open, sign, verifierList } from "../vendor/note/note.ts";
import { FakeS3 } from "./testing/fakes3.ts";

// A log of 600 entries (two full level-0 tiles, a partial of 88, a partial level-1 tile of 2)
// whose checkpoint at that size is kept after it grows to 768 (three full tiles).
let log: TestLog;
let cp600: Uint8Array;

beforeAll(async () => {
	log = await newTestLog({ origin: "example.com/verified" });
	await log.add(entriesOf(600));
	cp600 = await log.reader.readCheckpoint();
	await log.add(entriesOf(168, 600));
});

afterAll(async () => {
	await log.shutdown();
});

/** at600 is the log as it was at size 600, read from storage that has since grown. */
function at600(overrides: Partial<Source> = {}): Source {
	return {
		readCheckpoint: async () => cp600,
		readTile: (l, i, p, s) => log.reader.readTile(l, i, p, s),
		readEntryBundle: (i, p, s) => log.reader.readEntryBundle(i, p, s),
		...overrides,
	};
}

function flip(b: Uint8Array, at = 0): Uint8Array {
	const c = new Uint8Array(b);
	c[at] = (c[at] as number) ^ 1;
	return c;
}

/** mirror runs a verified mirror of source into store, returning the error, if any. */
async function mirror(source: Source | string, store: MemoryObjectStore, fetch?: FetchFn): Promise<unknown> {
	const m = newVerifiedMirror({
		source,
		target: store,
		origin: log.origin,
		verifier: log.verifier,
		numWorkers: 2,
		...(fetch === undefined ? {} : { fetch }),
	});
	return m.run().then(
		() => undefined,
		(err: unknown) => err,
	);
}

describe("newVerifiedMirror", () => {
	it("mirrors a log served over tlog-tiles, verifying everything it writes", async () => {
		const store = new MemoryObjectStore();
		const fetch = fetchVia(newLogHandler({ reader: log.reader }));
		expect(await mirror("https://log.example/", store, fetch)).toBeUndefined();
		expect(checkpointUnsafe((await store.get("checkpoint")) as Uint8Array).size).toBe(768n);
		await newFsck(log.origin, log.verifier, newSinkTarget(store), defaultMerkleLeafHasher, { n: 2 }).check();
	});

	it("accepts a full tile and bundle in place of garbage-collected partial ones, and stores the partial", async () => {
		const store = new MemoryObjectStore();
		const source = at600({
			readTile: (l, i, p, s) => log.reader.readTile(l, i, l === 0n && p > 0 ? 0 : p, s),
			readEntryBundle: (i, _p, s) => log.reader.readEntryBundle(i, 0, s),
		});
		expect(await mirror(source, store)).toBeUndefined();
		expect((await store.get("tile/0/002.p/88"))?.length).toBe(88 * 32);
		await newFsck(log.origin, log.verifier, newSinkTarget(store), defaultMerkleLeafHasher, { n: 2 }).check();
	});

	// Whatever a hostile source makes the mirror refuse, everything it did write must be
	// exactly what an honest source at the same size would have produced.
	let reference: MemoryObjectStore;
	beforeAll(async () => {
		reference = new MemoryObjectStore();
		expect(await mirror(at600(), reference)).toBeUndefined();
	});

	const hostile: { name: string; source: () => Source; reason: RegExp; absent: string[] }[] = [
		{
			name: "a tampered full tile",
			source: () =>
				at600({
					readTile: async (l, i, p, s) => {
						const t = await log.reader.readTile(l, i, p, s);
						return l === 0n && i === 1n ? flip(t, 100) : t;
					},
				}),
			reason: /full tile 0\/1\/0 does not hash to its entry in the verified tile above/,
			absent: ["tile/0/001", "tile/entries/001"],
		},
		{
			name: "a tampered entry bundle",
			source: () =>
				at600({
					readEntryBundle: async (i, p, s) => {
						const b = await log.reader.readEntryBundle(i, p, s);
						return i === 0n ? flip(b, 5) : b;
					},
				}),
			reason: /does not hash to its leaf in the verified tile/,
			absent: ["tile/entries/000"],
		},
		{
			name: "a tampered partial tile",
			source: () =>
				at600({
					readTile: async (l, i, p, s) => {
						const t = await log.reader.readTile(l, i, p, s);
						return p > 0 ? flip(t) : t;
					},
				}),
			reason: /do not hash to the source checkpoint's root/,
			absent: ["tile/0/000", "tile/0/002.p/88", "tile/1/000.p/2"],
		},
		{
			name: "a bundle with entries missing",
			source: () => at600({ readEntryBundle: async () => new Uint8Array([0, 1, 7]) }),
			reason: /has 1 entries, want (256|88)/,
			absent: ["tile/entries/000", "tile/entries/001", "tile/entries/002.p/88"],
		},
		{
			name: "a checkpoint signed by another key",
			source: () => {
				const n = open(cp600, verifierList(log.verifier));
				const forged = sign({ text: n.text }, newSigner(generateKey(undefined, log.origin).skey));
				return at600({ readCheckpoint: async () => forged });
			},
			reason: /failed to verify signatures on checkpoint/,
			absent: ["tile/0/000", "tile/entries/000"],
		},
	];
	for (const h of hostile) {
		it(`writes nothing unverified, and no checkpoint, for ${h.name}`, async () => {
			const store = new MemoryObjectStore();
			const started = Date.now();
			const err = await mirror(h.source(), store);
			expect(String(err)).toMatch(h.reason);
			// Verification failures are not retried.
			expect(Date.now() - started).toBeLessThan(5000);
			expect(await store.get("checkpoint")).toBeUndefined();
			for (const k of h.absent) {
				expect(await store.get(k), k).toBeUndefined();
			}
			for (const k of store.keys()) {
				expect(await store.get(k), k).toEqual(await reference.get(k));
			}
		});
	}

	it("refuses a source whose history does not extend what was mirrored", async () => {
		const store = new MemoryObjectStore();
		expect(await mirror(at600(), store)).toBeUndefined();
		const before = await store.get("checkpoint");

		const fork = await newTestLog({ origin: log.origin, keys: { skey: log.skey, vkey: log.vkey } });
		try {
			await fork.add(entriesOf(700, 9000));
			const err = await mirror(fork.reader, store);
			expect(String(err)).toMatch(
				/source checkpoint \(size 700\) is not consistent with the mirrored one \(size 600\)/,
			);
			expect(await store.get("checkpoint")).toEqual(before);
		} finally {
			await fork.shutdown();
		}

		// The genuine continuation is accepted.
		expect(await mirror(log.reader, store)).toBeUndefined();
		expect(checkpointUnsafe((await store.get("checkpoint")) as Uint8Array).size).toBe(768n);

		// And a rollback is not.
		expect(String(await mirror(at600(), store))).toMatch(/older than the mirrored one/);
	});

	it("resumes an interrupted S3 mirror over the objects it left only if they are the same", async () => {
		const bucket = (failCheckpoint: () => boolean) => {
			const s3 = new FakeS3("AKID", "secret", "us-east-1");
			const sink = newS3Sink({
				endpoint: "http://s3.test",
				bucket: "b",
				region: "us-east-1",
				accessKeyId: "AKID",
				secretAccessKey: "secret",
				fetch: async (input, init) =>
					failCheckpoint() && init?.method === "PUT" && input.endsWith("/checkpoint")
						? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
						: s3.fetch(input, init),
			});
			return { s3, sink };
		};
		const run = (source: Source, sink: Sink) =>
			newVerifiedMirror({ source, target: sink, origin: log.origin, verifier: log.verifier, numWorkers: 2 })
				.run()
				.then(
					() => undefined,
					(err: unknown) => err,
				);

		// The same source again: the objects left behind are what it serves.
		let failing = true;
		const same = bucket(() => failing);
		expect(String(await run(at600(), same.sink))).toMatch(/403 AccessDenied/);
		expect(same.s3.objects.has("/b/checkpoint")).toBe(false);
		failing = false;
		expect(await run(at600(), same.sink)).toBeUndefined();
		await newFsck(log.origin, log.verifier, newSinkTarget(same.sink), defaultMerkleLeafHasher, { n: 2 }).check();

		// A source that has since served another history signed by the same key.
		failing = true;
		const other = bucket(() => failing);
		expect(String(await run(at600(), other.sink))).toMatch(/403 AccessDenied/);
		failing = false;
		const fork = await newTestLog({ origin: log.origin, keys: { skey: log.skey, vkey: log.vkey } });
		try {
			await fork.add(entriesOf(600, 9000));
			const started = Date.now();
			const err = await run(fork.reader, other.sink);
			expect(String(err)).toMatch(/S3 PUT b\/tile\/[^:]+: a different object is already stored there/);
			expect(Date.now() - started).toBeLessThan(5000);
			expect(other.s3.objects.has("/b/checkpoint")).toBe(false);
		} finally {
			await fork.shutdown();
		}
	});

	it("runs once at a time, verifying afresh on each run", async () => {
		const store = new MemoryObjectStore();
		const reads: number[] = [];
		const source = at600({
			readCheckpoint: async () => {
				reads.push(Date.now());
				return cp600;
			},
		});
		const m = newVerifiedMirror({ source, target: store, origin: log.origin, verifier: log.verifier, numWorkers: 2 });
		const first = m.run();
		await expect(m.run()).rejects.toThrow(/already running/);
		await first;
		await m.run();
		expect(reads).toHaveLength(2);
		await newFsck(log.origin, log.verifier, newSinkTarget(store), defaultMerkleLeafHasher, { n: 2 }).check();
	});

	it("refuses a worker count that is not a positive integer", () => {
		for (const numWorkers of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				() =>
					newVerifiedMirror({
						source: at600(),
						target: new MemoryObjectStore(),
						origin: log.origin,
						verifier: log.verifier,
						numWorkers,
					}),
				String(numWorkers),
			).toThrow(RangeError);
		}
	});

	it("does not follow redirects or accept oversized answers from the source", async () => {
		const store = new MemoryObjectStore();
		const redirecting = async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } });
		expect(String(await mirror("https://log.example/", store, redirecting))).toMatch(/refusing redirect \(302\)/);

		const fetch = newSourceFetch({ fetch: fetchVia(newLogHandler({ reader: log.reader })), maxBytes: 10 });
		await expect(fetch("https://log.example/checkpoint")).rejects.toThrow(/limit/);
	});
});

describe("VerifyingSource", () => {
	it("serves nothing before a checkpoint has been verified, nor what it does not imply", async () => {
		const v = newVerifyingSource(at600(), { origin: log.origin, verifier: log.verifier });
		await expect(v.readTile(0n, 0n, 0)).rejects.toThrow(/readCheckpoint must succeed/);
		await v.readCheckpoint();
		await expect(v.readTile(0n, 2n, 0)).rejects.toThrow(/not implied by the verified checkpoint of size 600/);
		await expect(v.readTile(0n, 2n, 87)).rejects.toThrow(/not implied/);
		await expect(v.readEntryBundle(3n, 0)).rejects.toThrow(/not implied/);
		expect((await v.readTile(0n, 2n, 88)).length).toBe(88 * 32);
		expect((await v.readTile(1n, 0n, 2)).length).toBe(64);
	});

	it("fails a read that a later readCheckpoint overtook", async () => {
		let release = (): void => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		const v = newVerifyingSource(
			at600({
				readEntryBundle: async (i, p, s) => {
					await held;
					return log.reader.readEntryBundle(i, p, s);
				},
			}),
			{ origin: log.origin, verifier: log.verifier },
		);
		await v.readCheckpoint();
		const overtaken = v.readEntryBundle(0n, 0);
		await v.readCheckpoint();
		release();
		await expect(overtaken).rejects.toThrow(/serves one mirror run at a time/);
		expect((await v.readEntryBundle(1n, 0)).length).toBeGreaterThan(0);
	});

	it("keeps what it verified out of reach of the source and of its callers", async () => {
		const served: Uint8Array[] = [];
		const v = newVerifyingSource(
			at600({
				readTile: async (l, i, p, s) => {
					const t = await log.reader.readTile(l, i, p, s);
					served.push(t);
					return t;
				},
			}),
			{ origin: log.origin, verifier: log.verifier },
		);
		await v.readCheckpoint();
		const want = await log.reader.readTile(1n, 0n, 2);
		const got = await v.readTile(1n, 0n, 2);
		expect(got).toEqual(want);
		// Changing what the source handed over, or what the caller received, changes
		// nothing the source verifies or serves next.
		for (const b of [...served, got]) {
			b.fill(0);
		}
		expect(await v.readTile(1n, 0n, 2)).toEqual(want);
		expect((await v.readTile(0n, 0n, 0)).length).toBe(256 * 32);
	});

	it("verifies the empty log", async () => {
		const empty = await newTestLog({ origin: "example.com/empty" });
		try {
			const v = newVerifyingSource(empty.reader, { origin: empty.origin, verifier: empty.verifier });
			expect(checkpointUnsafe(await v.readCheckpoint()).size).toBe(0n);
		} finally {
			await empty.shutdown();
		}
	});
});
