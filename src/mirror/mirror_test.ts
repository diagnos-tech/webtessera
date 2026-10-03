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

// Upstream has no mirror_test.go; these tests exercise the port against real logs written by
// the appender, and pin the one divergence (docs/decisions/0173-mirror-port.md).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mirror, newSinkTarget, type Sink, type Target } from "webtessera/mirror";
import { newFsck } from "../fsck/index.ts";
import { entriesOf, newTestLog, type TestLog } from "../http/testing/testlog.ts";
import { ErrNotExist, wrapError } from "../internal/gostd/errors.ts";
import { checkpointUnsafe } from "../internal/parse/parse.ts";
import { defaultMerkleLeafHasher } from "../lifecycle.ts";
import { MemoryObjectStore } from "../storage/memory/memory.ts";
import { calcNumResources, jobString, jobs } from "./mirror.ts";
import { RetryError, retry, unrecoverable } from "./retry.ts";

let log: TestLog;

beforeAll(async () => {
	log = await newTestLog({ origin: "example.com/mirrored" });
	await log.add(entriesOf(70));
});

afterAll(async () => {
	await log.shutdown();
});

/** recordingStore is a MemoryObjectStore that remembers the order of its puts. */
class recordingStore extends MemoryObjectStore {
	readonly puts: string[] = [];
	override put(key: string, data: Uint8Array): Promise<void> {
		this.puts.push(key);
		return super.put(key, data);
	}
}

/** publicKeys returns the store's tlog-tiles resources, leaving out the driver's state. */
function publicKeys(store: MemoryObjectStore): string[] {
	return store.keys().filter((k) => !k.startsWith(".state/"));
}

describe("jobs", () => {
	it("walks each level from the target size to the source size, tile-aligned after the first job", () => {
		const got = [...jobs(70000n, 300n, 512n)].map(jobString);
		expect(got.slice(0, 3)).toEqual([
			"Level: 0, Range: [300, 512)",
			"Level: 0, Range: [512, 1024)",
			"Level: 0, Range: [1024, 1536)",
		]);
		expect(got.filter((s) => s.startsWith("Level: 1,"))).toEqual([
			"Level: 1, Range: [1, 256)",
			"Level: 1, Range: [256, 273)",
		]);
		expect(got.filter((s) => s.startsWith("Level: 2,"))).toEqual(["Level: 2, Range: [0, 1)"]);
	});

	it("counts the tiles and bundles a run will copy", () => {
		// The spec's example: a tree of 70,000 has 273 full level-0 tiles and one partial,
		// one full level-1 tile and one partial, and one partial level-2 tile.
		expect(calcNumResources(70000n, 0n, 256n * 30n)).toBe(274n * 2n + 2n + 1n);
	});
});

describe("Mirror", () => {
	it("copies a log, checkpoint last, into anything with a put", async () => {
		const store = new recordingStore();
		const m = new Mirror({ numWorkers: 4, source: log.reader, target: newSinkTarget(store) });
		await m.run();

		expect(store.puts[store.puts.length - 1]).toBe("checkpoint");
		expect(store.puts.filter((k) => k === "checkpoint")).toHaveLength(1);
		for (const k of publicKeys(store)) {
			expect(await store.get(k), k).toEqual(await log.store.get(k));
		}
		const { totalResources, resourcesFetched } = m.progress();
		expect(resourcesFetched).toBe(totalResources);
		// 70 entries: one partial level-0 tile and its bundle.
		expect(totalResources).toBe(2n);

		// The copy is a complete, verifiable log.
		const target = newSinkTarget(store);
		await newFsck(log.origin, log.verifier, target, defaultMerkleLeafHasher, { n: 2 }).check();
	});

	it("resumes from the checkpoint it last wrote and copies only what is new", async () => {
		const store = new recordingStore();
		const target = newSinkTarget(store, { prefix: "mirrors/a/" });
		await new Mirror({ numWorkers: 2, source: log.reader, target }).run();

		const grown = await newTestLog({ origin: log.origin, keys: { skey: log.skey, vkey: log.vkey }, store: log.store });
		try {
			await grown.add(entriesOf(400, 70));
			store.puts.length = 0;
			const m = new Mirror({ numWorkers: 3, source: grown.reader, target });
			await m.run();
			expect(store.puts.every((k) => k.startsWith("mirrors/a/"))).toBe(true);
			expect(store.puts[store.puts.length - 1]).toBe("mirrors/a/checkpoint");
			// The partial tile and bundle at the old size are not copied again; the full
			// ones replacing them are.
			expect(store.puts).not.toContain("mirrors/a/tile/0/000.p/70");
			expect(store.puts).toContain("mirrors/a/tile/0/000");
			expect(checkpointUnsafe((await store.get("mirrors/a/checkpoint")) as Uint8Array).size).toBe(470n);
			await newFsck(log.origin, log.verifier, target, defaultMerkleLeafHasher, { n: 2 }).check();

			// Nothing new: nothing to do.
			store.puts.length = 0;
			await new Mirror({ source: grown.reader, target }).run();
			expect(store.puts).toEqual([]);
		} finally {
			await grown.shutdown();
		}
	});

	it("finishes when the source is fewer entries ahead than there are workers", async () => {
		// Upstream computes a stride of zero here, and from a tile-aligned target size (an
		// empty mirror, say) jobs() then yields empty jobs forever.
		const small = await newTestLog({ origin: "example.com/small" });
		try {
			await small.add(entriesOf(5));
			const store = new MemoryObjectStore();
			const target = newSinkTarget(store);
			await new Mirror({ numWorkers: 30, source: small.reader, target }).run();
			expect(checkpointUnsafe((await store.get("checkpoint")) as Uint8Array).size).toBe(5n);
			await newFsck(small.origin, small.verifier, target, defaultMerkleLeafHasher, { n: 2 }).check();
		} finally {
			await small.shutdown();
		}
	});

	it("copies the whole log again when the sink cannot read back, harmlessly", async () => {
		const objects = new Map<string, Uint8Array>();
		const writeOnly: Sink = { put: async (k, d) => void objects.set(k, d) };
		await new Mirror({ source: log.reader, target: newSinkTarget(writeOnly) }).run();
		const first = new Map(objects);
		await new Mirror({ source: log.reader, target: newSinkTarget(writeOnly) }).run();
		expect(objects).toEqual(first);
	});

	it("retries transient failures to store", async () => {
		const store = new MemoryObjectStore();
		let failures = 2;
		const flaky: Sink = {
			put: async (k, d) => {
				if (k !== "checkpoint" && failures-- > 0) {
					throw new Error("transient");
				}
				await store.put(k, d);
			},
			get: (k) => store.get(k),
		};
		await new Mirror({ numWorkers: 1, source: log.reader, target: newSinkTarget(flaky) }).run();
		expect(await store.get("checkpoint")).toEqual(await log.reader.readCheckpoint());
	});

	it("writes no checkpoint when a resource cannot be copied", async () => {
		const store = new MemoryObjectStore();
		const broken = {
			readCheckpoint: () => log.reader.readCheckpoint(),
			readTile: () => Promise.reject(unrecoverable(new Error("tile gone"))),
			readEntryBundle: (i: bigint, p: number) => log.reader.readEntryBundle(i, p),
		};
		await expect(new Mirror({ source: broken, target: newSinkTarget(store) }).run()).rejects.toThrow(
			/^failed to migrate static resources: All attempts fail:\n#1: tile gone$/,
		);
		expect(await store.get("checkpoint")).toBeUndefined();
	});

	it("reports failures to read either checkpoint as upstream does", async () => {
		const target = newSinkTarget(new MemoryObjectStore());
		const noSource = { ...log.reader, readCheckpoint: () => Promise.reject(new Error("down")) };
		await expect(new Mirror({ source: noSource, target }).run()).rejects.toThrow(
			"failed to fetch source checkpoint size: down",
		);
		const badTarget: Target = {
			...target,
			readCheckpoint: () => Promise.reject(new Error("denied")),
			writeCheckpoint: (d) => target.writeCheckpoint(d),
			writeTile: (l, i, p, d) => target.writeTile(l, i, p, d),
			writeEntryBundle: (i, p, d) => target.writeEntryBundle(i, p, d),
		};
		await expect(new Mirror({ source: log.reader, target: badTarget }).run()).rejects.toThrow(
			"failed to read checkpoint in target: denied",
		);
		const absent = { ...badTarget, readCheckpoint: () => Promise.reject(wrapError("nope", ErrNotExist)) };
		await expect(new Mirror({ source: log.reader, target: absent }).run()).resolves.toBeUndefined();
	});

	it("refuses a worker count it cannot use", async () => {
		const target = newSinkTarget(new MemoryObjectStore());
		await expect(new Mirror({ numWorkers: 0, source: log.reader, target }).run()).rejects.toThrow(/numWorkers/);
	});
});

describe("retry", () => {
	it("is retry-go's Do: ten attempts, every error reported, unrecoverable errors not retried", async () => {
		let n = 0;
		await expect(
			retry(
				async () => {
					n++;
					throw new Error(`fail ${n}`);
				},
				{ delayMs: 0, maxJitterMs: 0 },
			),
		).rejects.toThrow(/^All attempts fail:\n#1: fail 1\n#2: fail 2\n[\s\S]*#10: fail 10$/);
		expect(n).toBe(10);

		n = 0;
		const err = await retry(
			async () => {
				n++;
				throw unrecoverable(ErrNotExist);
			},
			{ delayMs: 0 },
		).catch((e: unknown) => e);
		expect(n).toBe(1);
		expect(err).toBeInstanceOf(RetryError);
		expect((err as RetryError).errors).toEqual([ErrNotExist]);

		n = 0;
		await expect(retry(async () => (++n < 3 ? Promise.reject(new Error("x")) : n), { delayMs: 0 })).resolves.toBe(3);
	});

	it("stops waiting when its signal aborts", async () => {
		const ac = new AbortController();
		const p = retry(() => Promise.reject(new Error("x")), { delayMs: 60_000, signal: ac.signal });
		ac.abort(new Error("stop"));
		await expect(p).rejects.toThrow(/#2: stop/);
	});
});
