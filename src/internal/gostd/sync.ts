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

// This file is not a port of a Tessera file. It stands in for Go's `sync`,
// `sync/atomic`, `time.Ticker` and `golang.org/x/sync/errgroup`, which Tessera uses
// throughout its lifecycle, storage and client code.
//
// Port note: Go's concurrency is pre-emptive across OS threads; JavaScript's is
// cooperative on a single thread. That difference makes this translation *safer*, not
// harder — there is no data race on a plain field, because no two lines of JavaScript
// run at once. What JavaScript does have is *interleaving at every `await`*, so a
// critical section spanning an `await` still needs a lock. That is exactly what `Mutex`
// below is for, and it is the only reason any of these primitives exist.
//
// Every one of these is deliberately minimal. They exist to make the ported code read
// like the Go original, not to be a general-purpose concurrency library.

/**
 * Mutex is an async mutual-exclusion lock, standing in for `sync.Mutex`.
 *
 * Use it wherever the Go code holds a mutex across an operation that becomes `await` in
 * TypeScript. Where the Go critical section is purely synchronous, a mutex is not needed
 * at all — JavaScript's run-to-completion semantics already guarantee it — and the port
 * should simply drop the lock and say so in a `// Port note:` comment.
 */
export class Mutex {
	// Tail of the queue of waiters. Each `lock` chains onto the previous one, so waiters
	// are served strictly in arrival order, matching Go's starvation-avoiding behaviour
	// closely enough for our purposes.
	#tail: Promise<void> = Promise.resolve();

	/** lock acquires the mutex, returning the function that releases it. */
	async lock(): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.#tail;
		this.#tail = this.#tail.then(() => next);
		await previous;
		let released = false;
		return () => {
			// Releasing twice would let two holders through; make it a no-op instead of a
			// silent corruption.
			if (released) {
				return;
			}
			released = true;
			release();
		};
	}

	/**
	 * do runs fn while holding the lock and always releases it, which is the equivalent of
	 * Go's `mu.Lock(); defer mu.Unlock()`. Prefer this over `lock` — the `defer` shape is
	 * much harder to get wrong.
	 */
	async do<T>(fn: () => T | Promise<T>): Promise<T> {
		const unlock = await this.lock();
		try {
			return await fn();
		} finally {
			unlock();
		}
	}
}

/**
 * WaitGroup waits for a collection of operations to finish, standing in for
 * `sync.WaitGroup`.
 */
export class WaitGroup {
	#count = 0;
	#waiters: (() => void)[] = [];

	/** add increments the counter by delta. */
	add(delta = 1): void {
		this.#count += delta;
		if (this.#count < 0) {
			throw new Error("sync: negative WaitGroup counter");
		}
		this.#release();
	}

	/** done decrements the counter by one. */
	done(): void {
		this.add(-1);
	}

	/** wait blocks until the counter is zero. */
	async wait(): Promise<void> {
		if (this.#count === 0) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.#waiters.push(resolve);
		});
	}

	#release(): void {
		if (this.#count !== 0) {
			return;
		}
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const w of waiters) {
			w();
		}
	}
}

/**
 * ErrGroup stands in for `golang.org/x/sync/errgroup.Group` as Tessera uses it, through
 * `errgroup.WithContext`: it runs a set of operations, waits for them all, and reports the
 * first error.
 *
 * `signal` plays the part of the derived `context.Context`. As in `WithContext`, it is
 * aborted the first time an operation fails or the first time `wait` returns, whichever
 * happens first, and it is also aborted when the optional parent signal aborts. Use
 * `setLimit` to bound concurrency, which Tessera does for its bundle-fetching and migration
 * workers.
 *
 * Port note: Go's `Group.Go` blocks the calling goroutine until the new goroutine fits
 * under the limit. A JavaScript caller cannot be suspended in the middle of a synchronous
 * call, so `go` returns immediately and queues the operation instead; queued operations
 * start in the order they were queued, as running ones finish. The limit therefore bounds
 * how many operations run at once, not how far ahead a producer can get. Go's bare
 * `errgroup.Group` never cancels anything; this class always has a signal, which is a
 * superset of that. See docs/decisions/0004-errors-context-and-concurrency.md.
 */
export class ErrGroup {
	#limit = Number.POSITIVE_INFINITY;
	// Operations that have started and not yet finished: the permits currently held.
	#active = 0;
	// Operations waiting for a permit, in arrival order. This is non-empty only while
	// #active >= #limit, because a permit is handed to the head of the queue in the same
	// synchronous step that frees it (see #startPending) and when the limit is raised.
	#pending: (() => void)[] = [];
	#tasks: Promise<void>[] = [];
	#firstError: unknown;
	#controller = new AbortController();
	#parent?: AbortSignal | undefined;
	#parentAbort?: (() => void) | undefined;

	/**
	 * @param parent an optional signal; aborting it aborts the group, the way a parent
	 *   `context.Context` cancels an `errgroup` derived from it.
	 */
	constructor(parent?: AbortSignal) {
		if (parent) {
			if (parent.aborted) {
				this.#controller.abort(parent.reason);
			} else {
				this.#parent = parent;
				this.#parentAbort = () => this.#controller.abort(parent.reason);
				parent.addEventListener("abort", this.#parentAbort, { once: true });
			}
		}
	}

	/**
	 * signal is aborted the first time an operation fails or the first time `wait`
	 * returns, whichever happens first, and when the parent signal aborts.
	 */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/**
	 * setLimit limits the number of operations running at once to at most n. A negative
	 * value means no limit. A limit of zero means no operation may start: operations
	 * passed to `go` stay queued, and `wait` does not settle, until a later `setLimit`
	 * raises the limit (Go's `Go` blocks forever in the same situation).
	 *
	 * As in Go, a non-negative limit must not be set while any operation in the group is
	 * running, and doing so throws. Operations that have finished, or that are only
	 * queued, are not running.
	 *
	 * Port note: n must be an integer, as Go's `int` is; a fractional or NaN limit throws
	 * a RangeError instead of silently admitting one operation too many or none at all.
	 */
	setLimit(n: number): void {
		if (Number.isNaN(n) || (Number.isFinite(n) && !Number.isInteger(n))) {
			throw new RangeError(`errgroup: limit must be an integer, got ${n}`);
		}
		if (n < 0) {
			this.#limit = Number.POSITIVE_INFINITY;
		} else {
			if (this.#active !== 0) {
				throw new Error(`errgroup: modify limit while ${this.#active} goroutines in the group are still active`);
			}
			this.#limit = n;
		}
		this.#startPending();
	}

	/**
	 * go calls fn as a new operation of the group, once the limit allows it. The first
	 * operation that rejects cancels `signal`, and its error is the one `wait` throws.
	 *
	 * Port note: unlike Go's `Go`, this never blocks the caller; see the class comment.
	 */
	go(fn: () => Promise<void>): void {
		this.#tasks.push(this.#run(fn));
	}

	async #run(fn: () => Promise<void>): Promise<void> {
		if (this.#active < this.#limit) {
			this.#active++;
		} else {
			// The permit is counted as ours by whoever resumes us (see #startPending), so
			// no go() call that arrives in the meantime can take the slot first.
			await new Promise<void>((resolve) => {
				this.#pending.push(resolve);
			});
		}
		try {
			await fn();
		} catch (err) {
			// Only the first error is reported, matching errgroup.
			if (this.#firstError === undefined) {
				this.#firstError = err;
				this.#controller.abort(err);
			}
		} finally {
			this.#active--;
			this.#startPending();
		}
	}

	// startPending hands free permits to queued operations, oldest first. The permit is
	// counted before the operation is resumed, in the same synchronous step that freed it,
	// so a go() call cannot slip between the release and the resume and push the number of
	// running operations past the limit.
	#startPending(): void {
		while (this.#active < this.#limit) {
			const next = this.#pending.shift();
			if (next === undefined) {
				return;
			}
			this.#active++;
			next();
		}
	}

	/**
	 * wait blocks until every operation has finished, then throws the first error if there
	 * was one. It is the equivalent of `if err := g.Wait(); err != nil { return err }`.
	 *
	 * The first time it returns, it also aborts `signal`, as Go's `WithContext` cancels
	 * the derived context when `Wait` returns.
	 */
	async wait(): Promise<void> {
		// Tasks may start further tasks, so drain until the list stops growing.
		while (this.#tasks.length > 0) {
			const inFlight = this.#tasks;
			this.#tasks = [];
			await Promise.all(inFlight);
		}
		if (this.#parent && this.#parentAbort) {
			// Nothing to cancel any more; remove the listener so an abort on a long-lived
			// parent signal cannot hold a reference to this group alive after wait() returns.
			this.#parent.removeEventListener("abort", this.#parentAbort);
			this.#parent = undefined;
			this.#parentAbort = undefined;
		}
		// Go: g.cancel(g.err). A no-op once the signal is already aborted, so the first
		// error (or the parent) keeps being the reason. With no error the reason is the
		// default AbortError, the analogue of context.Canceled.
		this.#controller.abort(this.#firstError);
		if (this.#firstError !== undefined) {
			throw this.#firstError;
		}
	}
}

/**
 * Once runs a function exactly once, standing in for `sync.Once`. Later calls wait for
 * and observe the first call's outcome, including its error.
 */
export class Once<T> {
	#promise?: Promise<T>;

	/**
	 * do calls fn the first time it is called and returns its result; every later call
	 * returns that same result without calling fn again.
	 *
	 * Port note: Go's `Once.Do` treats an f that panics as having returned, so f is never
	 * called again. Here a synchronous throw is memoised exactly like a rejection, so fn
	 * runs once whichever way it fails. Every caller then observes the failure, as
	 * `sync.OnceFunc` and `sync.OnceValue` do by panicking again on each call; `Once.Do`
	 * itself panics only in the first caller.
	 */
	do(fn: () => Promise<T>): Promise<T> {
		if (this.#promise === undefined) {
			try {
				this.#promise = fn();
			} catch (err) {
				this.#promise = Promise.reject(err);
			}
		}
		return this.#promise;
	}
}

/**
 * maxTimerDelay is the longest delay a JavaScript timer honours: 2^31-1 milliseconds, about
 * 24.8 days. setTimeout treats a longer one as zero and fires at once.
 */
const maxTimerDelay = 2 ** 31 - 1;

/**
 * sleep resolves after ms milliseconds, rejecting instead if the signal aborts first.
 * It is the equivalent of a `select` on `time.After` and `ctx.Done()`.
 *
 * Port note: a delay longer than a timer can hold (maxTimerDelay) is waited out in
 * successive timers of at most that length, so it lasts as long as Go's time.After does
 * instead of resolving at once.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		let remaining = ms;
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const wait = (): void => {
			const step = Math.min(remaining, maxTimerDelay);
			timer = setTimeout(() => {
				remaining -= step;
				if (remaining > 0) {
					wait();
					return;
				}
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, step);
		};
		wait();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * ticker runs fn every periodMs until the signal aborts, standing in for the
 * `time.NewTicker` + `for { select { case <-t.C: ... case <-ctx.Done(): ... } }` loop that
 * Tessera uses for checkpoint publication, republication and garbage collection.
 *
 * Like `time.Ticker`, ticks sit on a fixed schedule: the first is one period after the
 * call, and the n-th is n periods after it, however long fn takes. fn never overlaps
 * itself. If fn is still running when a tick is due, that tick is held and fn runs again
 * as soon as it returns; any further ticks that fall due in the meantime are dropped, as
 * `time.Ticker` drops them for a slow receiver, so a long stall is not made up with a burst
 * of calls. A fn that takes longer than the period therefore runs back to back.
 * An error thrown by fn is passed to onError and does not stop the loop; Tessera's tick
 * bodies log and continue.
 *
 * The returned promise resolves once the signal has aborted and any call to fn in
 * progress has returned; no call starts after the abort. It throws a RangeError, rather
 * than returning a rejected promise, when periodMs is not positive, as `time.NewTicker`
 * panics for a non-positive interval.
 *
 * Port note: ticks are timed on `performance.now()`, and a JavaScript timer fires late
 * by an amount the platform decides (a background tab may be throttled to once a second),
 * so a tick can be delivered late. A late tick does not move the ones after it. Between
 * back-to-back runs the loop still yields to the event loop once, so a fn that never
 * really suspends cannot starve timers and I/O.
 * See docs/decisions/0004-errors-context-and-concurrency.md.
 */
export function ticker(
	periodMs: number,
	signal: AbortSignal,
	fn: () => Promise<void>,
	onError?: (err: unknown) => void,
): Promise<void> {
	if (!(periodMs > 0)) {
		throw new RangeError("non-positive interval for NewTicker");
	}
	return tickerLoop(periodMs, signal, fn, onError);
}

async function tickerLoop(
	periodMs: number,
	signal: AbortSignal,
	fn: () => Promise<void>,
	onError: ((err: unknown) => void) | undefined,
): Promise<void> {
	// The time the next tick falls due.
	let next = performance.now() + periodMs;
	while (!signal.aborted) {
		try {
			await sleep(Math.max(0, next - performance.now()), signal);
		} catch {
			return;
		}
		if (signal.aborted) {
			return;
		}
		// Timers can fire a little early as well as late; never treat the tick as received
		// before it was due, or it would be delivered twice.
		const received = Math.max(performance.now(), next);
		try {
			await fn();
		} catch (err) {
			onError?.(err);
		}
		// The next tick is the first one on the schedule after the one just received. Ticks
		// that came due while fn ran were buffered or dropped by Go's channel (capacity one),
		// and never accumulate, so they are skipped here rather than replayed.
		next += periodMs * (Math.floor((received - next) / periodMs) + 1);
		while (next <= received) {
			next += periodMs;
		}
	}
}
