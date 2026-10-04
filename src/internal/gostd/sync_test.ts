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

import { afterEach, describe, expect, it, vi } from "vitest";
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

	it("never runs more operations than the limit while a permit changes hands", async () => {
		// Regression: a finishing operation used to give up its permit and only then resume
		// the next queued one, which counted itself a few microtasks later. A go() call that
		// landed in that window found a free slot and took it, so three operations ran under
		// a limit of two.
		const g = new ErrGroup();
		g.setLimit(2);
		let running = 0;
		let peak = 0;
		const enter = () => {
			running++;
			peak = Math.max(peak, running);
		};
		const leave = () => {
			running--;
		};
		// A finishes first, freeing a permit for B, which is queued behind the limit.
		g.go(async () => {
			enter();
			await null;
			leave();
		});
		// A2 calls go() for C just as B is being resumed.
		g.go(async () => {
			enter();
			await null;
			await null;
			g.go(async () => {
				enter();
				await sleep(5);
				leave();
			});
			await sleep(5);
			leave();
		});
		g.go(async () => {
			enter();
			await sleep(5);
			leave();
		});
		await g.wait();
		expect(peak).toBe(2);
	});

	it("starts queued operations in the order they were queued", async () => {
		const g = new ErrGroup();
		g.setLimit(1);
		const started: number[] = [];
		for (const i of [1, 2, 3, 4, 5]) {
			g.go(async () => {
				started.push(i);
				await sleep(1);
			});
		}
		await g.wait();
		expect(started).toEqual([1, 2, 3, 4, 5]);
	});

	it("queues go() rather than blocking the caller at the limit", async () => {
		// Go's Group.Go blocks here; the port returns at once and queues (see ErrGroup).
		const g = new ErrGroup();
		g.setLimit(1);
		const started: string[] = [];
		g.go(async () => {
			started.push("first");
			await sleep(5);
		});
		g.go(async () => {
			started.push("second");
		});
		expect(started).toEqual(["first"]);
		await g.wait();
		expect(started).toEqual(["first", "second"]);
	});

	it("treats a negative limit as no limit", async () => {
		const g = new ErrGroup();
		g.setLimit(2);
		g.setLimit(-1);
		let running = 0;
		let peak = 0;
		for (let i = 0; i < 6; i++) {
			g.go(async () => {
				running++;
				peak = Math.max(peak, running);
				await sleep(2);
				running--;
			});
		}
		await g.wait();
		expect(peak).toBe(6);
	});

	it("accepts a negative limit even while operations are running, as Go does", async () => {
		const g = new ErrGroup();
		g.setLimit(1);
		g.go(async () => {
			await sleep(2);
		});
		expect(() => g.setLimit(-1)).not.toThrow();
		await g.wait();
	});

	it("lets a negative limit release operations queued behind a smaller one", async () => {
		const g = new ErrGroup();
		g.setLimit(1);
		const started: number[] = [];
		for (const i of [1, 2, 3]) {
			g.go(async () => {
				started.push(i);
				await sleep(5);
			});
		}
		expect(started).toEqual([1]);
		g.setLimit(-1);
		await Promise.resolve();
		expect(started).toEqual([1, 2, 3]);
		await g.wait();
	});

	it("starts no operation under a limit of zero until the limit is raised", async () => {
		const g = new ErrGroup();
		g.setLimit(0);
		let ran = 0;
		g.go(async () => {
			ran++;
		});
		g.go(async () => {
			ran++;
		});
		const settled = g.wait().then(() => "settled");
		await expect(Promise.race([settled, sleep(10).then(() => "waiting")])).resolves.toBe("waiting");
		expect(ran).toBe(0);
		// Nothing is running, so the limit may change, and it releases the queue.
		g.setLimit(1);
		await expect(settled).resolves.toBe("settled");
		expect(ran).toBe(2);
	});

	it("rejects setLimit while operations are running, as Go panics", async () => {
		const g = new ErrGroup();
		g.go(async () => {
			await sleep(1);
		});
		expect(() => g.setLimit(1)).toThrow("errgroup: modify limit while 1 goroutines in the group are still active");
		await g.wait();
	});

	it("allows setLimit once the running operations have finished, even before wait", async () => {
		// Go counts the goroutines still holding a permit, not the ones started so far.
		const g = new ErrGroup();
		g.go(async () => {});
		await sleep(5);
		expect(() => g.setLimit(3)).not.toThrow();
		await g.wait();
	});

	it("rejects a limit that is not an integer", () => {
		const g = new ErrGroup();
		expect(() => g.setLimit(Number.NaN)).toThrow(RangeError);
		expect(() => g.setLimit(1.5)).toThrow(RangeError);
		expect(() => g.setLimit(Number.POSITIVE_INFINITY)).not.toThrow();
	});

	it("aborts its signal the first time wait returns, even without an error", async () => {
		// Go's errgroup.WithContext: the derived context is cancelled when Wait returns.
		const g = new ErrGroup();
		g.go(async () => {
			await sleep(1);
		});
		expect(g.signal.aborted).toBe(false);
		await g.wait();
		expect(g.signal.aborted).toBe(true);
		expect((g.signal.reason as Error).name).toBe("AbortError");
	});

	it("aborts its signal when wait returns for a group with no operations", async () => {
		const g = new ErrGroup();
		await g.wait();
		expect(g.signal.aborted).toBe(true);
	});

	it("keeps the first error as the abort reason when wait later returns", async () => {
		const g = new ErrGroup();
		const first = new Error("first");
		g.go(async () => {
			throw first;
		});
		g.go(async () => {
			await sleep(2);
		});
		await expect(g.wait()).rejects.toBe(first);
		expect(g.signal.reason).toBe(first);
	});

	it("keeps the parent's reason when the parent aborted before wait returned", async () => {
		const parent = new AbortController();
		const g = new ErrGroup(parent.signal);
		g.go(async () => {
			await sleep(2);
		});
		const reason = new Error("parent cancelled");
		parent.abort(reason);
		await g.wait();
		expect(g.signal.reason).toBe(reason);
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
		// Aborting the now-detached parent must not disturb the completed group: wait()
		// aborted the signal itself, and the late parent abort does not replace its reason.
		const tooLate = new Error("too late");
		parent.abort(tooLate);
		expect(g.signal.aborted).toBe(true);
		expect(g.signal.reason).not.toBe(tooLate);
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

	it("does not call fn again after it failed", async () => {
		const once = new Once<number>();
		let calls = 0;
		const fn = async (): Promise<number> => {
			calls++;
			throw new Error("nope");
		};
		await expect(once.do(fn)).rejects.toThrow("nope");
		await expect(once.do(fn)).rejects.toThrow("nope");
		expect(calls).toBe(1);
	});

	it("treats a synchronous throw as done, as sync.Once treats a panic", async () => {
		const once = new Once<number>();
		let calls = 0;
		const fn = (): Promise<number> => {
			calls++;
			throw new Error("boom");
		};
		await expect(once.do(fn)).rejects.toThrow("boom");
		await expect(once.do(fn)).rejects.toThrow("boom");
		expect(calls).toBe(1);
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

	// A timer fires at once for a delay above 2^31-1 ms; Go's time.After waits the whole
	// duration, so sleep chains timers no longer than that.
	it("waits the whole of a delay longer than a timer can hold", async () => {
		vi.useFakeTimers();
		const spy = vi.spyOn(globalThis, "setTimeout");
		try {
			const max = 2 ** 31 - 1;
			const ms = 3.3e9;
			let done = false;
			const ctrl = new AbortController();
			void sleep(ms, ctrl.signal).then(() => {
				done = true;
			});
			await vi.advanceTimersByTimeAsync(max);
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(ms - max - 1);
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(done).toBe(true);
			for (const call of spy.mock.calls) {
				expect(call[1] ?? 0).toBeLessThanOrEqual(max);
			}
		} finally {
			spy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("can be aborted during a later timer of a long delay", async () => {
		vi.useFakeTimers();
		try {
			const ctrl = new AbortController();
			const p = sleep(3.3e9, ctrl.signal);
			await vi.advanceTimersByTimeAsync(2 ** 31);
			ctrl.abort(new Error("stop"));
			await expect(p).rejects.toThrow("stop");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ticker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

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

	it("rejects a period that is not positive, as time.NewTicker panics", () => {
		const ctrl = new AbortController();
		const fn = async () => {};
		expect(() => ticker(0, ctrl.signal, fn)).toThrow(RangeError);
		expect(() => ticker(-5, ctrl.signal, fn)).toThrow("non-positive interval for NewTicker");
		expect(() => ticker(Number.NaN, ctrl.signal, fn)).toThrow(RangeError);
	});

	it("fires on a fixed schedule however long the body takes", async () => {
		// Before: the loop slept a full period after each body, so a 40ms body stretched a
		// 50ms period to 90ms and the ticks drifted (50, 140, 230, ...). time.Ticker keeps
		// to start+n*period regardless.
		vi.useFakeTimers();
		const ctrl = new AbortController();
		const t0 = performance.now();
		const fired: number[] = [];
		const done = ticker(50, ctrl.signal, async () => {
			fired.push(performance.now() - t0);
			await sleep(40);
		});
		await vi.advanceTimersByTimeAsync(340);
		ctrl.abort();
		await done;
		expect(fired).toEqual([50, 100, 150, 200, 250, 300]);
	});

	it("does not make up for ticks missed while the body ran", async () => {
		// The first body outlasts four periods. time.Ticker holds one tick for the slow
		// receiver and drops the rest, so the body runs again as soon as it returns, once,
		// and then the schedule carries on from where it was, with no burst of catch-up calls.
		vi.useFakeTimers();
		const ctrl = new AbortController();
		const t0 = performance.now();
		const fired: number[] = [];
		const done = ticker(50, ctrl.signal, async () => {
			fired.push(performance.now() - t0);
			if (fired.length === 1) {
				await sleep(200);
			}
		});
		await vi.advanceTimersByTimeAsync(400);
		ctrl.abort();
		await done;
		expect(fired[0]).toBe(50);
		// The held tick is delivered the moment the first body returns, give or take the
		// one-tick yield to the event loop between back-to-back runs.
		expect(fired[1]).toBeGreaterThanOrEqual(250);
		expect(fired[1]).toBeLessThanOrEqual(251);
		// Then the fixed schedule resumes: 300, 350, 400, not a burst at 250.
		expect(fired.slice(2)).toEqual([300, 350, 400]);
	});

	it("never overlaps the body with itself", async () => {
		vi.useFakeTimers();
		const ctrl = new AbortController();
		let running = 0;
		let peak = 0;
		let calls = 0;
		const done = ticker(10, ctrl.signal, async () => {
			calls++;
			running++;
			peak = Math.max(peak, running);
			await sleep(35);
			running--;
		});
		await vi.advanceTimersByTimeAsync(300);
		ctrl.abort();
		// Let the body that is still running finish.
		await vi.advanceTimersByTimeAsync(100);
		await done;
		expect(calls).toBeGreaterThan(3);
		expect(peak).toBe(1);
	});

	it("starts nothing once the signal aborts while it waits for a tick", async () => {
		vi.useFakeTimers();
		const ctrl = new AbortController();
		let calls = 0;
		const done = ticker(50, ctrl.signal, async () => {
			calls++;
		});
		await vi.advanceTimersByTimeAsync(20);
		ctrl.abort();
		await done;
		await vi.advanceTimersByTimeAsync(200);
		expect(calls).toBe(0);
	});

	it("finishes a body that is running when the signal aborts, and starts no more", async () => {
		vi.useFakeTimers();
		const ctrl = new AbortController();
		let calls = 0;
		let finished = false;
		const done = ticker(50, ctrl.signal, async () => {
			calls++;
			await sleep(100);
			finished = true;
		});
		await vi.advanceTimersByTimeAsync(60);
		ctrl.abort();
		await vi.advanceTimersByTimeAsync(100);
		await done;
		expect(finished).toBe(true);
		expect(calls).toBe(1);
	});
});
