// Copyright 2025 The Tessera authors. All Rights Reserved.
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
// Ported from tessera/internal/future/future.go @ 4a6d9f9
//
// Port note: storage/internal/queue.go needs this package directly
// (`future.NewFutureErr[tessera.Index]()`), so it is ported here in full. It is
// self-contained: it imports nothing else from this port.
// See docs/decisions/0056-future-ported-ahead-of-schedule.md.

/**
 * FutureErr is a future which resolves to a value or an error.
 *
 * Port note: Go builds this on `sync.WaitGroup` in preference to a channel because it is
 * lighter on allocation — a Go-specific performance concern about goroutine scheduling
 * that has no TypeScript counterpart. A native `Promise` already *is* the future/deferred
 * primitive Go is emulating here (and gostd's own `WaitGroup` is itself built on one), so
 * this port uses a `Promise` directly rather than routing through `WaitGroup` a second
 * time. The observable contract is unchanged: `get()` blocks (awaits) until the future is
 * resolved, exactly once, and the first resolution wins. See
 * docs/decisions/0056-future-ported-ahead-of-schedule.md.
 */
export class FutureErr<T> {
	readonly #promise: Promise<T>;

	/** @internal Use newFutureErr to construct a linked future/resolver pair. */
	constructor(promise: Promise<T>) {
		this.#promise = promise;
	}

	/**
	 * get resolves the future, returning either a valid T or throwing an error.
	 *
	 * This function will block until the future has had its value set.
	 *
	 * Port note: Go's `Get() (T, error)` returns the value even alongside an error. A
	 * rejected Promise carries only the error, so a value set together with an error is
	 * not observable here; no caller in Tessera reads the value when the error is non-nil.
	 * See docs/decisions/0056-future-ported-ahead-of-schedule.md.
	 */
	async get(): Promise<T> {
		return this.#promise;
	}
}

/**
 * newFutureErr creates a new future which resolves to a T or an error.
 *
 * Returns the future, and a function which is used to set the future's value/error.
 * Calls to the future's get function will block until this function is called.
 *
 * Port note: Go returns `(*FutureErr[T], func(T, error))`; the two values are of
 * unmistakably different shapes (an object and a function), so there is no transposition
 * risk of the kind docs/decisions/0031-multi-value-returns.md guards against, and a tuple
 * is the direct equivalent of Go's `f, set := NewFutureErr[T]()`.
 */
export function newFutureErr<T>(): readonly [FutureErr<T>, (t: T, err: unknown) => void] {
	let resolveFn!: (t: T) => void;
	let rejectFn!: (err: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolveFn = resolve;
		rejectFn = reject;
	});
	// Port note: a Go future set with an error that nobody ever reads is simply garbage.
	// A rejected Promise that nobody awaits is instead reported as an unhandled rejection
	// (and fails the process under some runtimes' defaults), which is what happens to every
	// queued entry whose future was never called when a batch fails, e.g. during shutdown.
	// Marking the promise handled here keeps Go's semantics; get() still rethrows the error.
	promise.catch(() => undefined);

	// Port note: Go guards the setter with `sync.Once` so only the first call takes
	// effect. That critical section is synchronous (no `await` inside it), so per
	// docs/decisions/0004-errors-context-and-concurrency.md it needs no lock at all — a
	// plain boolean flag is sufficient and is what the equivalent "idempotent action"
	// elsewhere in this port (gostd/sync.ts's Mutex.lock release function) already does.
	let done = false;
	const set = (t: T, err: unknown): void => {
		if (done) {
			return;
		}
		done = true;
		// Port note: Go's `err != nil` test. `null` is the other spelling of Go's nil a caller
		// can reach for, so it means success here exactly as `undefined` does.
		if (err !== undefined && err !== null) {
			rejectFn(err);
		} else {
			resolveFn(t);
		}
	};

	return [new FutureErr<T>(promise), set];
}
