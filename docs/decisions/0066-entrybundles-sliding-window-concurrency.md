# ADR-0066: `entryBundles`' bounded read-ahead is a sliding window of promises, not a channel/goroutine translation

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** client contributor
- **Upstream reference:** `client/stream.go` (`EntryBundles`)

## Context

Go's `EntryBundles` bounds its concurrent fetches to `numWorkers` using a background
goroutine, a buffered channel of `func() bundleOrErr` closures, and a token-bucket channel:

```go
bundles := make(chan func() bundleOrErr, numWorkers)
exit := make(chan struct{})
go func() {
	defer close(bundles)
	treeSize, err := getSize(ctx)
	...
	tokens := make(chan struct{}, numWorkers)
	for range numWorkers { tokens <- struct{}{} }
	for ri := range layout.Range(fromEntry, fromEntry+N, treeSize) {
		select {
		case <-exit: return
		case <-tokens:
		}
		c := make(chan bundleOrErr, 1)
		go func(ri layout.RangeInfo) {
			b, err := getBundle(ctx, ri.Index, ri.Partial)
			c <- bundleOrErr{b: Bundle{RangeInfo: ri, Data: b}, err: err}
		}(ri)
		f := func() bundleOrErr {
			b := <-c
			tokens <- struct{}{}  // token returned once the consumer retrieves this item
			return b
		}
		bundles <- f
	}
}()
return func(yield func(Bundle, error) bool) {
	defer close(exit)
	for f := range bundles {
		b := f()
		if !yield(b.b, b.err) { return }
		if b.err != nil { return }
	}
}
```

The mission brief for this work package calls this out directly: "Read the numWorkers
concurrent-fetch-with-ordered-yield logic carefully; it's easy to accidentally yield
bundles out of order or drop error propagation when parallelising. Use `ErrGroup`/`Mutex`
... but check whether it can stay simpler first" (paraphrasing
`docs/decisions/0004-errors-context-and-concurrency.md`'s general guidance, which this ADR
applies to a concrete case for the first time in this port).

The properties that actually matter, observably, are: (1) at most `numWorkers` fetches are
ever in flight at once, (2) bundles are yielded to the consumer in strict dispatch order
regardless of which underlying fetch resolves first, and (3) an error from any fetch stops
the stream at that point, exactly as if the iterator had been asked to stop. None of those
three properties inherently requires goroutines or channels — they are properties of *a
bounded pipeline*, which JavaScript's `Promise` and `async function*` already express
directly.

## Decision

`entryBundles` (`src/client/stream.ts`) uses a plain array as a sliding window of up to
`numWorkers` in-flight `Promise<Bundle>` values, oldest-dispatched-first:

```ts
const window: Promise<Bundle>[] = [];
const fillWindow = (): void => {
	while (window.length < numWorkers) {
		const next = infos.next();
		if (next.done === true) return;
		const ri = next.value;
		const pending = getBundle(ri.index, ri.partial, signal).then((data) => ({ rangeInfo: ri, data }));
		pending.catch(() => {}); // mark handled without consuming the rejection; see below
		window.push(pending);
	}
};
fillWindow();
while (window.length > 0) {
	const next = window.shift() as Promise<Bundle>;
	const bundle = await next;
	fillWindow();
	yield bundle;
}
```

`fillWindow()` dispatches new fetches immediately once a slot frees — right after
`await`ing the oldest one, before yielding to the consumer — which is the same point at
which upstream's token is returned (inside `f()`, called by the consumer loop before its
`yield`). This preserves the same "up to `numWorkers` ahead of what has actually been
retrieved" prefetch behaviour, not merely the same eventual throughput.

Ordering is guaranteed structurally: `window.shift()` always removes the oldest-dispatched
promise, and `await`ing it blocks until *that* fetch settles regardless of whether a later
one in the window has already settled — the same guarantee Go's per-item channel `c` (one
per dispatched fetch, retrieved in dispatch order via the outer buffered `bundles`
channel) provides.

Error propagation is automatic: if `await next` rejects, the exception propagates out of
the `async function*` at that point. By `async function*` semantics, a generator that has
thrown is done — a subsequent `.next()` call cannot resume it — which is exactly Go's
"yield the error, then return" behaviour, expressed as a language guarantee instead of an
explicit `return` after the `yield`.

One subtlety `Promise` adds over Go's channels: a fetch that is dispatched *ahead* in the
window can reject while an *earlier* fetch is still in flight, so its rejected promise sits
in `window` for a while before `window.shift()` reaches it and awaits it. Correctness is
unaffected — the error is still surfaced in strict order and never swallowed — but during
that gap the host runtime would see an unhandled rejection (Node's `unhandledRejection`, a
browser's `onunhandledrejection`, a Worker's error log), which Go's channel-parked error
never produces. Attaching a no-op `pending.catch(() => {})` at dispatch time marks the
promise handled without consuming the rejection: the `await window.shift()` that reaches it
later still throws the original error. This keeps the port as quiet as Go under a
mid-stream fetch failure.

Early consumer termination (`for await...of` `break`, or the consumer never calling
`.next()` again) needs no explicit signalling (Go's `exit` channel): a suspended
`async function*` simply never resumes past its current `yield`, so `fillWindow()` for
further items is never reached. There is no `exit`-channel equivalent to write because
there is nothing left running in the background to tell to stop — unlike Go's detached
goroutine, nothing here executes except in response to being asked to.

## Consequences

- No `ErrGroup`, `Mutex`, channel, or token-bucket primitive appears in `stream.ts`. This
  is a deliberate reading of ADR-0004's "check whether it can stay simpler first" rather
  than an oversight — a reviewer expecting a direct `ErrGroup`-based translation should
  read this ADR before flagging it as a fidelity gap.
- The *shape* of the code (a `while` loop over an array, not a channel-select loop) looks
  less like the Go source line-for-line than most of this port. The properties it
  preserves (bound, order, error-stops-stream, eager-as-soon-as-a-slot-frees prefetch) are
  the ones that are actually observable and testable; `stream_test.ts`'s "bounds
  concurrent fetches to numWorkers" case asserts the bound directly via an instrumented
  `getBundle`, the "propagates a getBundle error and stops the stream" case asserts
  ordering-before-the-error with `numWorkers=1` for determinism, and (added at review) two
  hand-driven-resolution cases assert strict in-order delivery and error-in-order even when
  a *later* index settles first — the race the numWorkers=1 case cannot reach.
- If a future revision needs true goroutine-style fire-and-forget dispatch that keeps
  producing *even while the consumer is not asking for more* (which this design does not
  do — it only refills once the oldest item has been awaited, i.e. once the consumer's
  `for await` loop is actively pulling), that would be a different, more complex design
  and would need its own ADR.

## Alternatives considered

- **A literal channel/goroutine translation using `ErrGroup`, an array as a bounded
  buffer, and manual signalling for early exit.** Rejected per ADR-0004's explicit
  guidance to check for a simpler translation first: it would need to reimplement, by
  hand, exactly the ordering and backpressure guarantees a sliding window of promises
  already gets from `Promise` and `async function*` for free, at several times the code
  size and with new opportunities to get the ordering subtly wrong (the risk the mission
  brief calls out directly).
- **`Promise.all` over the whole requested range, then yield in order.** Rejected: it
  removes the bound entirely (every fetch starts immediately, unbounded), which is exactly
  the "unbounded amount of resources" upstream's own comment says the token bucket exists
  to prevent, and it cannot yield anything until every fetch in the entire range has
  settled, defeating the point of streaming.
- **Materialise `layout.range`'s output into an array up front instead of pulling one
  `RangeInfo` at a time from the generator.** Considered and rejected as an unnecessary
  simplification: `range` is a pure, side-effect-free generator (already exhaustively
  fixture-tested in `paths_fixtures_test.ts`), so pulling lazily one item at a time via
  `infos.next()` inside `fillWindow` costs nothing and stays one step closer to Go's
  `for ri := range layout.Range(...)` loop structure.

## Review

- **Reviewer:** Client Reviewer
- **Verdict:** approved (with a fix applied during review)
- **Notes:** Diffed `entryBundles` against `client/stream.go`'s goroutine/channel/token-bucket
  implementation line by line. Verified the three properties that matter: (1) concurrency is
  bounded at `numWorkers` — `fillWindow` only tops the array up to that length, confirmed by the
  new hand-driven test seeing all-and-only-`numWorkers` dispatches; (2) delivery is strict
  dispatch order — `window.shift()` + `await` on the oldest promise, confirmed by a test that
  resolves *later* indices first and still observes `[0,1,2]`; (3) an error stops the stream in
  order and is not swallowed — confirmed by a test that rejects an ahead index while a behind one
  is in flight and sees the error surface only after the behind bundle, unchanged. During review I
  found the pre-fix code produced a host-level unhandled-rejection when an ahead fetch rejected
  before its turn (Go's channel-parked error never does this). Fixed with `pending.catch(() => {})`
  at dispatch — verified it does **not** swallow the real rejection (the ordered `await` still
  throws it) and eliminates the runtime warning. Decision snippet and Consequences updated to match.

## Update (2026-10-02): when fetching starts

The Decision says the window preserves "the same 'up to `numWorkers` ahead of what has actually been
retrieved' prefetch behaviour". That holds once the caller starts iterating, not before. Go's producer
goroutine starts when `EntryBundles` is called: `getSize` and the first `numWorkers` fetches begin
whether or not the iterator is ever ranged over (observed at the pinned commit: three calls within
200ms of `EntryBundles(ctx, 2, ...)`, never iterated). An async generator runs only when asked for a
value, so the port fetches nothing until the first `next()`. The Port note on `entryBundles` says so,
and `stream_test.ts` pins it ("nothing is fetched before the first next()").

`entryBundles` is now a plain function that validates `numWorkers` (ADR-0192) and returns the
generator; the window logic is unchanged.

*Review of this update: pending.*
