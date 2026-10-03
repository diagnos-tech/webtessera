// Copyright 2024 The Tessera authors. All Rights Reserved.
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
//
// Ported from tessera/storage/internal/queue_test.go @ 4a6d9f9
//
// Port note: BenchmarkQueue is not ported — see docs/decisions/0034-go-benchmarks-not-ported.md.

import { describe, expect, it } from "vitest";
import type { Index, IndexFuture } from "../../append_lifecycle.ts";
import type { Entry } from "../../entry.ts";
import { newEntry } from "../../entry.ts";
import { toUTF8 } from "../../internal/gostd/bytes.ts";
import { newQueue } from "./queue.ts";

describe("storage/internal/Queue", () => {
	describe("TestQueue", () => {
		const tests: readonly { name: string; numItems: number; maxEntries: number; maxWaitMs: number }[] = [
			{ name: "small", numItems: 100, maxEntries: 200, maxWaitMs: 1000 },
			{ name: "more items than queue space", numItems: 100, maxEntries: 20, maxWaitMs: 1000 },
			{ name: "much flushing", numItems: 100, maxEntries: 100, maxWaitMs: 0.001 },
		];

		for (const test of tests) {
			it(test.name, async () => {
				const assignedItems: (Entry | undefined)[] = new Array(test.numItems).fill(undefined);
				let assignedIndex = 0n;

				// flushFunc mimics sequencing storage - it takes entries, assigns them to
				// positions in assignedItems.
				const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
					for (const e of entries) {
						e.marshalBundleData(assignedIndex);
						assignedItems[Number(assignedIndex)] = e;
						assignedIndex++;
					}
				};

				// Create the Queue
				const q = newQueue(test.maxWaitMs, test.maxEntries, flushFunc);

				// Now submit a bunch of entries
				const adds: IndexFuture[] = new Array(test.numItems);
				const wantEntries: Entry[] = new Array(test.numItems);
				for (let i = 0; i < test.numItems; i++) {
					const d = toUTF8(`item ${i}`);
					wantEntries[i] = newEntry(d);
					adds[i] = q.add(wantEntries[i] as Entry);
				}

				for (let i = 0; i < adds.length; i++) {
					const N = await (adds[i] as IndexFuture)();
					const got = assignedItems[Number(N.index)]?.data();
					const want = (wantEntries[i] as Entry).data();
					expect(got).toEqual(want);
				}
			});
		}
	});

	describe("TestNotify", () => {
		const tests: readonly { name: string; setIdx: number; setErr: Error | undefined; wantErr: boolean }[] = [
			{ name: "just idx, no error", setIdx: 200, setErr: undefined, wantErr: false },
			{ name: "just error", setIdx: -1, setErr: new Error("expected error"), wantErr: true },
			{ name: "error and idx", setIdx: 200, setErr: new Error("expected error"), wantErr: true },
		];

		for (const test of tests) {
			it(test.name, async () => {
				// flushFunc mimics sequencing storage - it takes entries, assigns them to
				// positions in assignedItems.
				const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
					expect(entries).toHaveLength(1);
					if (test.setIdx >= 0) {
						(entries[0] as Entry).marshalBundleData(BigInt(test.setIdx));
					}
					if (test.setErr !== undefined) {
						throw test.setErr;
					}
				};

				// Create the Queue
				const q = newQueue(1000, 1, flushFunc);

				// Now submit the entry
				const added = q.add(newEntry(toUTF8(test.name)));
				let gotErr = false;
				try {
					await added();
				} catch {
					gotErr = true;
				}
				expect(gotErr).toBe(test.wantErr);
			});
		}
	});

	// Below this line are port additions, pinning behaviour the table-driven tests above
	// don't isolate directly.
	describe("port additions", () => {
		it("flushes when maxSize is reached without waiting for maxAge", async () => {
			const flushed: Entry[][] = [];
			const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
				flushed.push([...entries]);
				let i = 0n;
				for (const e of entries) {
					e.marshalBundleData(i);
					i++;
				}
			};
			const q = newQueue(60_000, 2, flushFunc);
			const f1 = q.add(newEntry(toUTF8("a")));
			const f2 = q.add(newEntry(toUTF8("b")));
			await f1();
			await f2();
			expect(flushed).toHaveLength(1);
			expect(flushed[0]).toHaveLength(2);
		});

		it("flushes after maxAge even below maxSize", async () => {
			const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
				let i = 0n;
				for (const e of entries) {
					e.marshalBundleData(i);
					i++;
				}
			};
			const q = newQueue(5, 1000, flushFunc);
			const f = q.add(newEntry(toUTF8("solo")));
			const idx = await f();
			expect(idx.index).toBe(0n);
		});

		it("preserves add() order across a flush that spans multiple batches", async () => {
			const seen: string[] = [];
			const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
				let i = 0n;
				for (const e of entries) {
					seen.push(new TextDecoder().decode(e.data()));
					e.marshalBundleData(i);
					i++;
				}
			};
			const q = newQueue(60_000, 3, flushFunc);
			const futures: IndexFuture[] = [];
			for (let i = 0; i < 9; i++) {
				futures.push(q.add(newEntry(toUTF8(`item-${i}`))));
			}
			const results: Index[] = [];
			for (const f of futures) {
				results.push(await f());
			}
			expect(seen).toEqual(Array.from({ length: 9 }, (_, i) => `item-${i}`));
			expect(results.map((r) => r.index)).toEqual([0n, 1n, 2n, 0n, 1n, 2n, 0n, 1n, 2n]);
		});

		it("processes every item exactly once when adds interleave with an in-flight flush", async () => {
			// Claim 5 (ADR-0053): the async drain loop is re-entrant-safe. Hold the first
			// flush open (await a gate) so that many further add()s pile up behind it while
			// it is in flight, then release it and assert the single drain loop processed
			// every batch exactly once, in order, with nothing dropped or double-processed.
			// If the #draining guard were removed (two overlapping drains), a batch would be
			// processed twice and `flat` would contain duplicates; if an item were dropped,
			// its future would never resolve and Promise.all would hang the test.
			const flushedBatches: string[][] = [];
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			let firstFlush = true;
			const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
				if (firstFlush) {
					firstFlush = false;
					await gate;
				}
				const batch: string[] = [];
				let i = 0n;
				for (const e of entries) {
					batch.push(new TextDecoder().decode(e.data()));
					e.marshalBundleData(i);
					i++;
				}
				flushedBatches.push(batch);
			};

			const q = newQueue(60_000, 5, flushFunc);
			const futures: IndexFuture[] = [];
			// The first 5 adds trip maxSize and start the first (held) flush.
			for (let i = 0; i < 5; i++) {
				futures.push(q.add(newEntry(toUTF8(`item-${i}`))));
			}
			// The drain loop is now parked awaiting the gate inside the first flush.
			await Promise.resolve();
			// 20 more adds arrive while that first flush is still in flight: four more
			// batches enqueued behind the one being processed.
			for (let i = 5; i < 25; i++) {
				futures.push(q.add(newEntry(toUTF8(`item-${i}`))));
			}

			release();
			await Promise.all(futures.map((f) => f()));

			const flat = flushedBatches.flat();
			expect(flat).toEqual(Array.from({ length: 25 }, (_, i) => `item-${i}`));
			expect(new Set(flat).size).toBe(25);
		});

		it("settles every pending future with the logic error, then rethrows it, when storage forgets an index", async () => {
			// Go's notify panics here, taking the process and every waiting Add() with it. The
			// port settles each future still pending with that error, then rethrows it from
			// the drain loop, where it surfaces as an unhandled rejection (ADR-0053).
			const flushed: number[] = [];
			const unhandled = await captureUnhandledRejections(async () => {
				const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
					flushed.push(entries.length);
					// Forgets to call marshalBundleData, and reports no error.
				};
				const q = newQueue(60_000, 3, flushFunc);
				const futures = [q.add(newEntry(toUTF8("a"))), q.add(newEntry(toUTF8("b"))), q.add(newEntry(toUTF8("c")))];
				for (const f of futures) {
					await expect(f()).rejects.toThrow(
						"logic error: flush complete without error, but entry was not assigned an index - did storage fail to call entry.MarshalBundleData?",
					);
				}
			});
			expect(flushed).toEqual([3]);
			expect(unhandled.map((e) => (e as Error).message)).toEqual([
				"logic error: flush complete without error, but entry was not assigned an index - did storage fail to call entry.MarshalBundleData?",
			]);
		});

		it("stops flushing once its signal is aborted", async () => {
			// Go's worker goroutine returns on ctx.Done(); queued batches are never flushed and
			// their futures never resolve.
			let flushes = 0;
			const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
				flushes++;
				for (const e of entries) {
					e.marshalBundleData(0n);
				}
			};
			const controller = new AbortController();
			const q = newQueue(60_000, 1, flushFunc, controller.signal);
			await q.add(newEntry(toUTF8("before")))();
			expect(flushes).toBe(1);

			controller.abort();
			let settled = false;
			void q
				.add(newEntry(toUTF8("after")))()
				.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
			await new Promise((r) => setTimeout(r, 20));
			expect(flushes).toBe(1);
			expect(settled).toBe(false);
		});

		it("does not resolve add() before flush is called", async () => {
			let resolved = false;
			const flushFunc = async (entries: readonly Entry[]): Promise<void> => {
				for (const e of entries) {
					e.marshalBundleData(0n);
				}
			};
			const q = newQueue(60_000, 5, flushFunc);
			const f = q.add(newEntry(toUTF8("solo")));
			void f().then(() => {
				resolved = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(resolved).toBe(false);
		});
	});
});

/** nodeProcess is the part of Node's `process` captureUnhandledRejections needs; the suite runs on Node. */
interface nodeProcess {
	listeners(event: "unhandledRejection"): ((reason: unknown) => void)[];
	removeAllListeners(event: "unhandledRejection"): void;
	on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
}

/**
 * captureUnhandledRejections runs fn with the test runner's unhandled-rejection handlers
 * replaced by one that records each reason, and returns the reasons once the rejections
 * fn provoked have had a chance to surface.
 */
async function captureUnhandledRejections(fn: () => Promise<void>): Promise<unknown[]> {
	const proc = (globalThis as unknown as { process: nodeProcess }).process;
	const saved = proc.listeners("unhandledRejection");
	const caught: unknown[] = [];
	proc.removeAllListeners("unhandledRejection");
	proc.on("unhandledRejection", (reason) => {
		caught.push(reason);
	});
	try {
		await fn();
		await new Promise((r) => setTimeout(r, 20));
	} finally {
		proc.removeAllListeners("unhandledRejection");
		for (const l of saved) {
			proc.on("unhandledRejection", l);
		}
	}
	return caught;
}
