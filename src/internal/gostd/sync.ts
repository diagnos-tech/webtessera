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
 * ErrGroup is `golang.org/x/sync/errgroup.Group`: it runs a set of operations, waits for
 * them all, and reports the first error.
 *
 * As in Go, the first error cancels the group's signal, so operations that honour it stop
 * early. Use `setLimit` to bound concurrency, which Tessera does for its bundle-fetching
 * and migration workers.
 */
export class ErrGroup {
	#limit = Number.POSITIVE_INFINITY;
	#running = 0;
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

	/** signal is aborted when the group is cancelled or the first error occurs. */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/**
	 * setLimit caps the number of operations running at once. It must be called before
	 * any call to `go`, as in Go.
	 */
	setLimit(n: number): void {
		if (this.#tasks.length > 0) {
			throw new Error("errgroup: modify limit while there are tasks in flight");
		}
		this.#limit = n <= 0 ? Number.POSITIVE_INFINITY : n;
	}

	/** go starts fn, respecting the concurrency limit. */
	go(fn: () => Promise<void>): void {
		this.#tasks.push(this.#run(fn));
	}

	async #run(fn: () => Promise<void>): Promise<void> {
		if (this.#running >= this.#limit) {
			await new Promise<void>((resolve) => {
				this.#pending.push(resolve);
			});
		}
		this.#running++;
		try {
			await fn();
		} catch (err) {
			// Only the first error is reported, matching errgroup.
			if (this.#firstError === undefined) {
				this.#firstError = err;
				this.#controller.abort(err);
			}
		} finally {
			this.#running--;
			this.#pending.shift()?.();
		}
	}

	/**
	 * wait blocks until every operation has finished, then throws the first error if there
	 * was one. It is the equivalent of `if err := g.Wait(); err != nil { return err }`.
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

	do(fn: () => Promise<T>): Promise<T> {
		this.#promise ??= fn();
		return this.#promise;
	}
}

/**
 * sleep resolves after ms milliseconds, rejecting instead if the signal aborts first.
 * It is the equivalent of a `select` on `time.After` and `ctx.Done()`.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * ticker runs fn every periodMs until the signal aborts, standing in for the
 * `time.NewTicker` + `for { select { case <-t.C: ... case <-ctx.Done(): ... } }` loop that
 * Tessera uses for checkpoint publication, republication and garbage collection.
 *
 * Unlike `setInterval`, a slow fn delays the next tick rather than letting invocations
 * pile up — which matches Go's behaviour here, since Tessera's tick bodies are sequential.
 * An error thrown by fn is passed to onError and does not stop the loop; Tessera's tick
 * bodies log and continue.
 */
export async function ticker(
	periodMs: number,
	signal: AbortSignal,
	fn: () => Promise<void>,
	onError?: (err: unknown) => void,
): Promise<void> {
	while (!signal.aborted) {
		try {
			await sleep(periodMs, signal);
		} catch {
			return;
		}
		if (signal.aborted) {
			return;
		}
		try {
			await fn();
		} catch (err) {
			onError?.(err);
		}
	}
}
