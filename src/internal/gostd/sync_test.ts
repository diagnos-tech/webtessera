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

import { describe, expect, it, vi } from "vitest";
import { ErrGroup, Mutex, Once, sleep, ticker, WaitGroup } from "./sync.ts";

describe("Mutex", () => {
	it("serialises critical sections that span an await", async () => {
		const mu = new Mutex();
		// Without the lock this interleaves to [enter,enter,exit,exit]; with it, each
		// section runs to completion. This is the whole reason the type exists.
		const events: string[] = [];
		const section = async (id: number) => {
			await mu.do(async () => {
				events.push(`enter-${id}`);
				await sleep(1);
				events.push(`exit-${id}`);
			});
		};
		await Promise.all([section(1), section(2)]);
		expect(events).toEqual(["enter-1", "exit-1", "enter-2", "exit-2"]);
	});

	it("serves waiters in arrival order", async () => {
		const mu = new Mutex();
		const order: number[] = [];
		await Promise.all(
			[1, 2, 3, 4].map((id) =>
				mu.do(async () => {
					order.push(id);
					await sleep(1);
				}),
			),
		);
		expect(order).toEqual([1, 2, 3, 4]);
	});

	it("releases the lock when the critical section throws", async () => {
		const mu = new Mutex();
		await expect(
			mu.do(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// If the failing section had leaked the lock, this would hang.
		await expect(mu.do(async () => "ok")).resolves.toBe("ok");
	});

	it("ignores a double release", async () => {
		const mu = new Mutex();
		const unlock = await mu.lock();
		unlock();
		unlock();
		await expect(mu.do(async () => "ok")).resolves.toBe("ok");
	});
});

describe("WaitGroup", () => {
	it("waits for every operation to finish", async () => {
		const wg = new WaitGroup();
		let done = 0;
		for (let i = 0; i < 3; i++) {
			wg.add();
			void (async () => {
				await sleep(1);
				done++;
				wg.done();
			})();
		}
		await wg.wait();
		expect(done).toBe(3);
	});

	it("returns immediately when the counter is already zero", async () => {
		await expect(new WaitGroup().wait()).resolves.toBeUndefined();
	});

	it("rejects a negative counter, as Go panics on one", () => {
		const wg = new WaitGroup();
		expect(() => wg.done()).toThrow("negative WaitGroup counter");
	});
});

describe("ErrGroup", () => {
	it("waits for all operations and reports no error on success", async () => {
		const g = new ErrGroup();
		const seen: number[] = [];
		for (const i of [1, 2, 3]) {
			g.go(async () => {
				await sleep(1);
				seen.push(i);
			});
		}
		await expect(g.wait()).resolves.toBeUndefined();
		expect(seen.sort()).toEqual([1, 2, 3]);
	});

	it("reports the first error and aborts its signal", async () => {
		const g = new ErrGroup();
		g.go(async () => {
			throw new Error("first");
		});
		g.go(async () => {
			await sleep(5);
			throw new Error("second");
		});
		await expect(g.wait()).rejects.toThrow("first");
		expect(g.signal.aborted).toBe(true);
	});

	it("honours setLimit", async () => {
		const g = new ErrGroup();
		g.setLimit(2);
		let running = 0;
		let peak = 0;
		for (let i = 0; i < 8; i++) {
			g.go(async () => {
				running++;
				peak = Math.max(peak, running);
				await sleep(2);
				running--;
			});
		}
		await g.wait();
		expect(peak).toBe(2);
	});

	it("rejects setLimit once operations are in flight, as Go panics", async () => {
		const g = new ErrGroup();
		g.go(async () => {
			await sleep(1);
		});
		expect(() => g.setLimit(1)).toThrow("tasks in flight");
		await g.wait();
	});

	it("aborts when the parent signal aborts", async () => {
		const parent = new AbortController();
		const g = new ErrGroup(parent.signal);
		expect(g.signal.aborted).toBe(false);
		parent.abort(new Error("parent cancelled"));
		expect(g.signal.aborted).toBe(true);
		await g.wait();
	});

	it("starts already aborted if the parent signal is", async () => {
		const parent = new AbortController();
		parent.abort(new Error("already gone"));
		expect(new ErrGroup(parent.signal).signal.aborted).toBe(true);
	});

	it("removes its parent-abort listener once wait resolves", async () => {
		// A long-lived parent signal must not keep a finished group reachable through its
		// listener list. wait() removes the listener it registered in the constructor.
		const parent = new AbortController();
		const removeSpy = vi.spyOn(parent.signal, "removeEventListener");
		const g = new ErrGroup(parent.signal);
		g.go(async () => {
			await sleep(1);
		});
		await g.wait();
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
		// Aborting the now-detached parent must not disturb the completed group.
		parent.abort(new Error("too late"));
		expect(g.signal.aborted).toBe(false);
	});

	it("waits for operations started by other operations", async () => {
		const g = new ErrGroup();
		let inner = false;
		g.go(async () => {
			await sleep(1);
			g.go(async () => {
				await sleep(1);
				inner = true;
			});
		});
		await g.wait();
		expect(inner).toBe(true);
	});
});

describe("Once", () => {
	it("runs the function exactly once and shares its result", async () => {
		const once = new Once<number>();
		let calls = 0;
		const fn = async () => {
			calls++;
			await sleep(1);
			return 42;
		};
		const results = await Promise.all([once.do(fn), once.do(fn), once.do(fn)]);
		expect(results).toEqual([42, 42, 42]);
		expect(calls).toBe(1);
	});

	it("shares a failure with every caller", async () => {
		const once = new Once<number>();
		const fn = async () => {
			throw new Error("nope");
		};
		await expect(once.do(fn)).rejects.toThrow("nope");
		await expect(once.do(fn)).rejects.toThrow("nope");
	});
});

describe("sleep", () => {
	it("rejects when the signal aborts while sleeping", async () => {
		const ctrl = new AbortController();
		const p = sleep(1000, ctrl.signal);
		ctrl.abort(new Error("cancelled"));
		await expect(p).rejects.toThrow("cancelled");
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort(new Error("gone"));
		await expect(sleep(1000, ctrl.signal)).rejects.toThrow("gone");
	});
});

describe("ticker", () => {
	it("runs until the signal aborts", async () => {
		const ctrl = new AbortController();
		let ticks = 0;
		const done = ticker(1, ctrl.signal, async () => {
			ticks++;
			if (ticks === 3) {
				ctrl.abort();
			}
		});
		await done;
		expect(ticks).toBe(3);
	});

	it("keeps ticking after the body throws, reporting via onError", async () => {
		const ctrl = new AbortController();
		const errors: unknown[] = [];
		let ticks = 0;
		await ticker(
			1,
			ctrl.signal,
			async () => {
				ticks++;
				if (ticks === 3) {
					ctrl.abort();
					return;
				}
				throw new Error(`tick-${ticks}`);
			},
			(err) => errors.push(err),
		);
		expect(ticks).toBe(3);
		expect(errors).toHaveLength(2);
	});
});
