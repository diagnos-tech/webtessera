# ADR-0056: `internal/future/future.go` ported ahead of the `client` work package, as a native `Promise`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal agent
- **Upstream reference:** `internal/future/future.go`

## Context

The original work plan assigns `src/internal/future/future.ts` to the *other* Wave 2 work
package: "`src/client/{client,fetcher,stream}.ts` + `src/internal/{future,fetcher}` — needs Merkle
`proof`, Note, Layout." But `storage/internal/queue.go` — squarely this work package's mission —
calls it directly:

```go
func newEntry(data *tessera.Entry) queueItem {
	f, set := future.NewFutureErr[tessera.Index]()
	e := queueItem{entry: data, f: f.Get, set: set}
	return e
}
```

`future.go` is small (56 lines), self-contained (imports only `sync`), and has no dependency on
anything Wave-3-only or on anything the `client` package specifically needs beyond the type
itself. Blocking `queue.ts` on the `client` work package landing first — for a 56-line file with
no cross-dependency — would be a worse outcome than porting it now.

## Decision

`src/internal/future/future.ts` is ported now, in full (not partially, unlike
`docs/decisions/0054-append-lifecycle-partial-port.md`'s `append_lifecycle.ts` — there is nothing
here to defer). `docs/PORTING-MAP.md`'s row moves from `not started` to `done`, naming this ADR,
so the `client` work package's agent sees it is already landed and only needs to import it.

Go's `FutureErr[T]` wraps a `sync.WaitGroup` plus `val`/`err` fields specifically because, per its
own doc comment, "This could be done with a channel, but that turns out to be heavier in terms of
memory alloc than using a waitgroup" — a Go-specific allocation trade-off between two concurrency
primitives that both exist in Go's runtime and neither of which is what a "future" fundamentally
is. TypeScript's `Promise` *is* the future/deferred primitive Go is emulating here with a
`WaitGroup` (and `gostd/sync.ts`'s own `WaitGroup` is itself built on a `Promise`), so this port
uses a native `Promise` directly:

```ts
export class FutureErr<T> {
	readonly #promise: Promise<T>;
	async get(): Promise<T> { return this.#promise; }
}

export function newFutureErr<T>(): readonly [FutureErr<T>, (t: T, err: unknown) => void] {
	let resolveFn!: (t: T) => void;
	let rejectFn!: (err: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
	let done = false;
	const set = (t: T, err: unknown): void => {
		if (done) return;
		done = true;
		if (err !== undefined) rejectFn(err); else resolveFn(t);
	};
	return [new FutureErr<T>(promise), set];
}
```

Go's `sync.Once` guard on the setter — "only the first call takes effect" — is kept, but as a
plain boolean flag rather than `gostd/sync.ts`'s `Once` class: that class memoizes an `async`
function's *return value* across repeated calls (`Once<T>.do(fn: () => Promise<T>): Promise<T>`),
a different shape from "run this synchronous side effect at most once and silently ignore later
calls." The critical section the flag guards is entirely synchronous (no `await` inside it), so
per `docs/decisions/0004-errors-context-and-concurrency.md` no lock is needed either — the same
reasoning `queue.ts`'s dropped mutexes use
(`docs/decisions/0053-queue-channel-becomes-async-drain-loop.md`).

`NewFutureErr`'s two return values (`*FutureErr[T]`, `func(T, error)`) become a plain tuple, not
the named-readonly-object treatment `docs/decisions/0031-multi-value-returns.md` prescribes for
same-typed adjacent Go returns: an object and a function are unmistakably different shapes, so
there is no transposition risk of the kind that ADR exists to prevent, and
`const [f, set] = newFutureErr<T>()` already reads exactly like Go's `f, set := NewFutureErr[T]()`.

## Consequences

- `future.go` has no upstream `future_test.go`, so `future_test.ts` is a new file (not a port),
  pinning: `get()` blocks until `set()` is called, the first `set()` wins, an error passed to
  `set()` is thrown from `get()` rather than returned, and every waiting `get()` call observes the
  same resolution.
- Internal mechanism (`Promise` vs. `WaitGroup`+fields) differs from Go, but the observable
  contract — block until resolved, resolve exactly once, first resolution wins, error propagates —
  is unchanged, so this is not a behavioural divergence in the sense
  `docs/decisions/0004-errors-context-and-concurrency.md`'s concurrency section already covers,
  the same way that ADR's `Mutex`/`ErrGroup` substitutions do not each need their own ADR.
- The `client` work package's agent should treat this file as landed, not re-port it, and should
  update `docs/PORTING-MAP.md` only if this row needs correction (it should not).

## Alternatives considered

- **Wait for the `client` work package to land `future.ts` first.** Rejected: blocks a small,
  self-contained, already-in-scope-for-someone dependency on an unrelated work package's schedule
  for no benefit — `queue.go` is this work package's actual mission, and `future.go` has nothing
  `client`-specific about it.
- **Reimplement `WaitGroup`+`val`+`err` fields verbatim instead of a `Promise`.** Rejected: this
  would be transliterating a Go-specific micro-optimisation (avoiding channel allocation) that has
  no TypeScript counterpart to optimise against, at the cost of hand-rolling exactly the state
  machine a `Promise` already provides for free and more robustly (unhandled-rejection tracking,
  microtask-correct ordering, etc.).
- **Use `gostd/sync.ts`'s `Once` for the setter guard.** Rejected: shape mismatch, detailed above —
  `Once.do` memoizes an async return value; the setter is a synchronous, void-returning,
  run-at-most-once side effect, which needs nothing more than a boolean.

## Review

- **Reviewer:** Client Reviewer (Opus 4.8) — as a direct dependency of the client work package
- **Verdict:** approved
- **Notes:** Verified against `internal/future/future.go`. Observable contract matches: `get()`
  blocks until resolved (awaits the stored promise), is re-awaitable with the same result, the
  first `set()` wins (boolean `done` guard, synchronous section so no lock needed per ADR-0004),
  and an error propagates by rejection instead of a second return value. Checked the one real
  consumer, `storage/internal/queue.ts` `notify`, which treats `undefined` as its no-error sentinel
  (`err === undefined`), so the setter's `err !== undefined ? reject : resolve` branch is correct
  for every actual call site — nothing ever passes `null`. One latent, non-triggered sharp edge:
  if a caller passed `null` for "no error" it would reject rather than resolve; no path does, so it
  is not a defect, but future consumers should keep using `undefined`. `newFutureErr`'s tuple
  return is fine (object + function, no transposition risk). Approved as a faithful dependency.

## Update (2026-10-02): `null` is a nil error; the value half of `Get`

The review note above records that `set(t, null)` would reject. It now resolves: Go's `err != nil`
becomes `err !== undefined && err !== null`, so either spelling of "no error" means success.

`Get() (T, error)` in Go returns the value even when the error is non-nil. A rejected Promise carries
only the error, so a value set together with an error is not observable through `get()`. No caller in
Tessera reads the value when the error is non-nil (`queue.go`'s callers check `err` first), so nothing
depends on it; `get()`'s doc comment says so.

*Review of this update: pending.*
