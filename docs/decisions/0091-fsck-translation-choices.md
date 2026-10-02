# ADR-0091: `fsck.ts` translation choices — channel, atomics, map keys, the `uint8(256)` wrap, and two reserved-word renames

- **Status:** accepted, with §1 amended per the lead's resolution below
- **Date:** 2026-08-19
- **Author:** fsck agent
- **Upstream reference:** `fsck/fsck.go`, `fsck/fsck_test.go`

## Context

`fsck.go` is the first file in this port to combine a **synchronous producer** (the
Merkle tree-visiting code, called from inside `compact.Range.append`/`.getRootHash`) with
**asynchronous consumers** (`resourceCheckWorker`s doing real I/O), connected by a Go
channel, plus package-level atomic counters and a `compact.NodeID`-keyed map. None of
these has a previously-established, directly-reusable port in this codebase, so each is
decided here.

## Decisions

### 1. `chan resource` → `ResourceQueue`, with loop-level backpressure instead of a channel's bound

> **Resolution note (lead, 2026-08-19):** this section originally proposed an *unbounded*
> queue, reasoned as safe below. The Fsck Reviewer disputed that reasoning — see `## Review`
> — with a concrete, adversary-controllable memory-exhaustion argument: a log server that
> answers `readEntryBundle` promptly while stalling `readTile` lets the producer outrun the
> consumers by `O(logSize)`, not `O(N)`. I agree with the reviewer. The queue itself is
> still unbounded (an async queue has no other way to represent "waiting to be pulled"),
> but `check()`'s own bundle loop — the one place in this pipeline that *can* `await` — now
> calls `ResourceQueue.waitUntilBelow(threshold, eg.signal)` between bundles, pausing
> production once `threshold` (`resourceBackpressureThreshold(n)`, `max(4n, 16)`) resources
> are buffered. The `eg.signal` argument is what avoids the deadlock hazard the reviewer
> also flagged: `ErrGroup` aborts that signal the moment any `resourceCheckWorker` errors,
> so a producer parked in `waitUntilBelow` can never hang against a fully-dead consumer
> pool — it unblocks (rejecting) the instant `eg.wait()` has a real error to surface. See
> `ResourceQueue.waitUntilBelow`'s docstring in `fsck.ts` and the four
> `describe("ResourceQueue.waitUntilBelow", ...)` cases plus "check()'s backpressure caps
> buffered resources regardless of log size" in `fsck_test.ts`, which reproduces the
> reviewer's own scenario (fast producer, deliberately slow consumer, far more full tiles
> than the threshold) and fails with a clear assertion message if the `await` is removed —
> verified empirically before restoring the fix. The remainder of this section is left as
> originally written, as the historical record of the reasoning that turned out to be
> incomplete; do not read it as still describing current behaviour.

Go's `expectedResources chan resource` is created with capacity `f.opts.N`
(`make(chan resource, f.opts.N)`). A **buffered channel's send blocks once full**, which is
how Go bounds memory: the goroutine driving `AppendBundle`/`visit` cannot outrun the
`resourceCheckWorker`s by more than `N` pending resources.

`fsckTree.visit` — the producer — is called *synchronously* by `compact.Range.append` and
`.getRootHash` (`src/vendor/merkle/compact/range.ts`'s `VisitFn`, already landed and
reviewed in Wave 1, shared with `client` and `storage/internal`). A synchronous callback
cannot `await` a full buffer the way a blocked goroutine can without changing `VisitFn`'s
signature — exactly the constraint `docs/decisions/0052-tilewritecache-visitor-is-synchronous.md`
already worked through for a different file, and the same "do not change a shared,
already-reviewed interface underneath other work packages" rule applies here
(`docs/REVIEW-PROTOCOL.md` §3).

`ResourceQueue` (`fsck.ts`, no Go counterpart) is therefore an async FIFO queue with an
**unbounded** buffer: `push` is always synchronous and never blocks; `pull` returns a
`Promise` that resolves immediately if an item is buffered, or once one is pushed, or with
`null` once the queue is closed and drained (the equivalent of `r, ok := <-ch` with
`ok == false`). Multiple workers `pull` concurrently; each pushed item goes to exactly one
puller (fan-out), matching a Go channel's delivery semantics.

**Why dropping the capacity bound is safe here:** resource production is not actually
unthrottled. `AppendBundle` is only ever called from `Check`'s single, sequential
bundle-consuming loop, and that loop's own rate is bounded by `client.EntryBundles`'
(`entryBundles` in this port) `numWorkers`-wide sliding window of in-flight fetches — the
same `f.opts.N` value. So the number of resources that can be *pending* at any moment is
already bounded by how fast entry bundles can be fetched, independent of whether the
`ResourceQueue` itself enforces a second, redundant bound. What Go's channel bound adds on
top is a bound on how far the *tile-comparison* work (network-bound `ReadTile` calls) can
lag behind the *bundle-fetching* work — this port does not reproduce that second-order
throttle, so a sufficiently large log with slow tile reads and fast bundle reads could
buffer more pending resource-check jobs in memory than Go would. This is a real, disclosed
gap, not a silently-accepted one; see Consequences.

### 2. Atomic counters → plain fields, no lock

`countingFetcher`'s `atomic.Uint64` fields (`bytesFetched`, `resourcesFetched`,
`errorsEncountered`) and `Fsck.Status`'s `.Swap(0)` reads become plain `bigint` fields
incremented/reset by ordinary statements. Per
`docs/decisions/0004-errors-context-and-concurrency.md`: every individual increment
(`this._bytesFetched += BigInt(r.length)`) is one synchronous JavaScript statement, and
JavaScript's run-to-completion semantics mean no other code can interleave mid-statement
even though the surrounding methods are `async` and called from concurrent workers — so no
lock or atomic primitive is needed, only ordinary field access. `resourceWorkerID
atomic.Uint32` is dropped entirely along with the debug label it only ever fed to a
dropped `klog.V(2).Infof` call (see #5).

### 3. `compact.NodeID` map keys → composite string keys

`fsckTree.pendingTiles` is `map[compact.NodeID]*api.HashTile` in Go, relying on Go's
structural map-key equality. A JavaScript `Map` compares object keys by reference, so two
different `NodeID`-shaped keys with the same `(level, index)` would not collide the way
Go's do. This port uses a string key (`` `${level}:${index}` ``, via the module-local
`pendingTileKey`), following the precedent
`docs/decisions/0050-storage-internal-map-keys-and-callback-types.md` already set for the
identical problem in `storage/internal/integrate.ts` (and `client.ts`'s `tileCacheKey`,
the same technique for the same reason). Per that ADR's own recommendation, since `visit`
and `flushPartialTiles` both need to recover `(level, index)` from the key alone, the map's
*value* carries both (`pendingTileEntry { level, index, tile }`) rather than asking callers
to parse the key back apart.

### 4. The `uint8(256)` wraparound in `visit`

Go: `partial: uint8(len(t.Nodes))`, evaluated exactly when `len(t.Nodes) ==
layout.EntryBundleWidth` (256, per the `if` immediately above it). `uint8(256)` **wraps to
0** — this is not truncation-as-bug, it is the tlog-tiles spec's own convention: `partial
== 0` means "this is a full tile." This port reproduces the wrap explicitly:
`partial: t.nodes.length % 256`, with a comment at the call site, precisely because an
unannotated `t.nodes.length` (256) would silently produce the *wrong* resource path
(`tile/0/000.p/256`, which does not exist) instead of the correct full-tile path
(`tile/0/000`). `flushPartialTiles`' own `partial: entry.tile.nodes.length` needs no such
treatment: every tile it flushes is, by construction, still short of 256 (a tile that
reached 256 was already flushed and removed by `visit`), so the value is always in `[1,
255]` and the wrap can never fire there.

### 5. `klog` dropped; `klog.Exitf` invariant guards become thrown `Error`s

Extending `docs/decisions/0051-storage-internal-drops-otel-and-klog.md`'s precedent (that
ADR scoped itself to `storage/internal`; this is the same reasoning applied to a second
package): every `klog.Infof`/`klog.V(n).Infof` call is dropped with no stand-in, since
Tessera's own console-log ban (AGENTS.md's definition of done) forecloses a `console.*`
replacement and nothing in this package's tests or contract depends on the log lines
themselves. `klog.Exitf` (log, then `os.Exit(255)`) is different: both of its call sites in
`fsck.go` guard genuine invariant violations (`visit`'s "LOGIC ERROR" check, and a
`MarshalText` failure that is unreachable in this port anyway — see the note below). There
is no process to exit on the edge or in a browser tab, so both become `throw new
Error(...)` with the same message text, which is the established mapping this codebase
uses everywhere else for "this must never happen" Go panics.

`HashTile.marshalText` never throws in this port (`api/state.ts`'s own port note: Go's only
possible error came from `bytes.Buffer.Write`, which never fails, so the TypeScript port
dropped the error return entirely). The `klog.Exitf("Failed to marshal tile: %v", err)`
branches guarding both of `fsck.go`'s `MarshalText` calls are therefore unreachable here by
construction and are not ported at all, rather than ported as dead `try/catch` blocks.

### 6. Two `New` → reserved-word renames

Both `fsck.New` (package-level constructor) and Go's own map-key struct being unavailable
forced the same reserved-word problem ADR-0090 already names for `container/list.New`:
`New` camelCases to `new`, a reserved word. `fsck.New` becomes **`newFsck`**, the same
`new<Type>` convention used throughout this codebase.

### 7. `Opts.N` → optional `n`, normalised the same way Go normalises a zero value

Go's `Opts{N uint}` allows a caller to omit `N` (defaulting to Go's zero value, 0) or pass
it explicitly as 0; `New` normalises either case to 1 (`if opts.N == 0 { opts.N = 1 }`).
TypeScript has no field-omission-defaults-to-zero convention, so `Opts.n` is typed
`readonly n?: number`, and `newFsck` applies the identical normalisation
(`opts.n === undefined || opts.n === 0 ? 1 : opts.n`) — omission and explicit `0` both
funnel through the same branch, exactly as they do in Go.

### 8. `ErrGroup`'s signal is threaded through, even though Go's `eg` here is a bare `errgroup.Group{}`

`Check` constructs `eg := errgroup.Group{}` — **not** `errgroup.WithContext(ctx)` — so in
Go, `resourceCheckWorker`s share the caller's own `ctx` directly and are *not* cancelled on
each other's first error. This port's `ErrGroup` always derives and cancels its own signal
on first error regardless of how it is constructed
(`docs/decisions/0004-errors-context-and-concurrency.md`'s Consequences already documents
this as a "strictly-safer superset" of a bare Go `Group`, expected wherever `ErrGroup`
substitutes for one). `eg.signal` (chained from the caller's own `signal`) is threaded to
both the workers and `entryBundles` here rather than the raw `signal` parameter, since doing
so costs nothing extra and only adds a safety margin already blessed by that ADR; no new
divergence is being introduced by this choice.

### 9. Manually-driven iterator instead of `for await...of`, to keep two error messages distinct

Go's `for b, err := range client.EntryBundles(...)` has two independent `if err != nil`
checks in its body: one for the iterator's own error (streaming a bundle failed — wrapped
`"error while streaming bundles: %v"`), and a separate one a few lines later for
`AppendBundle`'s return (wrapped `"failure calling AppendBundle(%v): %v"`). A single
`for await (const b of entryBundles(...))` wrapped in one `try/catch` would conflate the
two — an `appendBundle` throw would also be caught by the same handler and re-wrapped with
the wrong message. `check()` instead drives `entryBundles(...)`'s returned
`AsyncGenerator` manually via `.next()`, with the streaming failure and the `appendBundle`
failure each in their own `try/catch`, exactly mirroring Go's two separate `if` statements.

## An observed, deliberately-unaddressed upstream quirk

On every early-return path in `Check` *before* `flushPartialTiles`/`close`/`eg.Wait()` —
checkpoint-fetch failure, a bundle-streaming error, an `AppendBundle` error — Go returns
without ever closing `f.expectedResources` or waiting for the already-started
`resourceCheckWorker` goroutines, which would then block forever on `for r := range
f.expectedResources` (channel never closed, no more sends coming). This looks like a
goroutine leak in the upstream source on those specific paths (masked in practice by
`cmd/fsck/main.go`'s own `cancel()` once `Check` returns, which is not ported — see
`docs/decisions/0093-cmd-fsck-tui-not-ported.md`). This port reproduces the same behaviour
on the same paths — the already-started `resourceCheckWorker` promises are simply never
awaited if `check()` throws before reaching `eg.wait()` — rather than adding cleanup Go
does not have, per AGENTS.md's "find out why before changing it." Point 8 above means a
worker's *own* failure still gets cleaned up via `eg.signal`; only a failure *elsewhere* in
`check()` leaves already-started workers unresolved, identically to Go.

## Consequences

- A pathological log (very slow tile reads, very fast bundle reads, very large `N`) could
  buffer more pending `resource` objects in this port's `ResourceQueue` than Go's bounded
  channel would allow. No test in this package exercises that scenario; it would need a
  fetcher with an artificial, asymmetric delay to observe, and is noted here rather than
  silently accepted.
- `fsckTree.sourceSize` is set in the constructor and never read anywhere in `fsck.go`
  itself (grepped across the whole file). It is kept as a dead field for structural
  fidelity — AGENTS.md says port what Go does, not what Go's dead code implies it might
  have meant to do.
- A reviewer diffing `fsck.go`'s `Check` against `fsck.ts`'s `check` will see the manual
  `.next()`-driving loop (point 9) where Go has a `for range`; the in-file Port note points
  at this ADR.

## Alternatives considered

- **Reproduce Go's bounded channel with an async semaphore gating `push`.** Rejected: the
  producer (`visit`) is synchronous and cannot `await` a semaphore without changing
  `VisitFn`'s signature — the same constraint ADR-0052 already ruled out for a different
  file, for the same cross-work-package reason.
- **A pre-pass that walks the whole tree once to know exactly how many resources will be
  produced, then throttles based on that count.** Rejected: substantially more code to
  re-derive information `visit` already computes as a side effect of its real job, for a
  bound this port's own reasoning (point 1) shows is not load-bearing for correctness, only
  for a memory ceiling under a specific, untested I/O-imbalance scenario.
- **Add explicit cleanup (`expectedResources.close()`, drain the ErrGroup) on every
  early-return path in `check()`, "fixing" the leak noted above.** Rejected for this ADR's
  scope: it is behaviour Go does not have, and AGENTS.md's fidelity mandate is to point out
  a suspected upstream defect for the human to weigh in on, not to unilaterally diverge
  from it. Flagged explicitly above instead.

## Review

- **Reviewer:** Fsck Reviewer
- **Verdict:** §1 dispute resolved by the lead (2026-08-19) — reviewer's position adopted, fix
  implemented and tested. §§2–9 and the goroutine-leak section approved as originally reviewed.
- **Notes (approved parts):** Verified against `fsck/fsck.go` and `fsck/fsck_test.go`, both
  read in full.
  - **§2 (atomics → plain fields):** correct. Each counter update is a single synchronous
    statement; no `await` interleaves it, so no atomic/lock is needed (ADR-0004). `.Swap(0)`
    → read-then-assign-0 in `status()` is faithful.
  - **§3 (NodeID map keys → string keys):** correct, follows ADR-0050; the value carries
    `(level, index)` back out, needed by `visit`/`flushPartialTiles`.
  - **§4 (`uint8(256)` wrap):** verified exhaustively. `x % 256 === uint8(x)` for x ∈
    {0,1,255,256} (and all non-negative x, since `uint8` truncation *is* mod 256). Confirmed
    the wrap only fires in `visit` (where `nodes.length` is exactly 256) and that
    `flushPartialTiles` correctly omits it (its tiles are always in [1,255], since a tile
    reaching 256 was already flushed+removed by `visit`). **Coverage gap found and fixed:**
    the `client_log` fixture is size 15, so *no* test exercised the full-tile branch. Added
    `fsck_test.ts` "visit enqueues a full 256-node tile with partial 0, not 256" — confirmed
    it fails (received 256) if the `% 256` is removed, passes with it.
  - **§5 (klog dropped; `klog.Exitf` → throw):** correct; message text preserved; the
    unreachable `MarshalText` error branches are correctly not ported (dead in this port).
  - **§6/§7 (`New`→`newFsck`; `Opts.N`→optional `n`):** correct; the
    `undefined || 0 ? 1 : n` normalisation funnels both omission and explicit 0 to 1, as Go does.
  - **§8 (ErrGroup signal threaded through a bare `errgroup.Group`):** correct and
    ADR-0004-blessed; strictly-safer superset, only affects a worker's *own* error path.
  - **§9 (manual `.next()` loop):** correct — verified the two error messages ("error while
    streaming bundles" vs. "failure calling appendBundle(...)") stay distinct, matching Go's two
    separate `if err != nil` checks; a single `for await…of` would conflate them.
  - **Self-reported `ResourceQueue.close()` bug:** independently reproduced. Reverting
    `splice(0)` to the described `this.#waiters.length = 0`-before-iterate form makes **both**
    fixture-backed `check()` tests time out (the 4 `TestTrimFullToPartial` subtests still pass,
    since they never leave a worker parked at close-time). The current `splice(0)` resolves the
    *removed* array while emptying the original — correct, and the two `{ n: 2 }` tests are
    genuine regression tests for it (with only one resource ever produced by a size-15 log, the
    second worker's *only* exit is `close()` resolving it).
  - **Goroutine-leak-on-early-return section:** verified the port faithfully *reproduces* the
    leak rather than silently diverging. On a streaming/appendBundle error, `check()` throws
    without `close()`/`eg.wait()`, leaving already-started workers parked on `pull()` — the
    direct analogue of Go's goroutines blocked on `for r := range ch`. Observable behaviour
    matches: same wrapped error surfaced; a leaked worker's own late error is swallowed by
    `ErrGroup.#run`'s internal `try/catch` (no unhandled rejection), exactly as Go discards a
    leaked goroutine's unread error return; an in-flight `readTile` completes in both. No caller
    could rely on leaked work "completing" — a parked worker is waiting for input that never
    comes, doing nothing observable.

- **Notes (§1 — DISPUTED, escalated):**
  - **Implementer's position (ADR §1):** dropping the channel's capacity bound is safe because
    producer rate is already gated by `entryBundles`' N-wide fetch window; the only residual
    gap is a memory ceiling under an "untested I/O-imbalance scenario," disclosed but accepted.
  - **Reviewer's position:** that scenario is **adversary-controllable, not merely theoretical.**
    The producer (`visit`, synchronous) is gated by *bundle-fetch* throughput, while the queue is
    drained by *tile-fetch* throughput (`resourceCheckWorker`→`readTile`). A malicious or merely
    slow log server can serve entry bundles fast and stall tile reads, so the producer outruns the
    consumers and the unbounded `ResourceQueue` accumulates up to O(logSize / 256) derived
    resources, each ≈ 8 KiB of tile content — e.g. a 256 M-entry log ⇒ ~1 M pending resources ⇒
    multi-GB, enough to OOM a browser tab. Go's cap-N channel structurally prevents this: the
    blocked send inside `visit` blocks `Check`'s bundle loop, which back-pressures `entryBundles`,
    holding memory at O(N). So this is O(N) in Go vs. O(logSize) worst-case in the port — a real
    fidelity loss *and* a client-side memory-exhaustion vector, on a tool whose entire job is to be
    pointed at logs it does not trust.
  - **Gap in the ADR's reasoning:** "Alternatives considered" correctly rejects a semaphore gating
    the *synchronous* `push`, but never considers gating in `check()`'s **own awaitable bundle
    loop** — e.g. `await tree.expectedResources.drainBelow(n)` after each `appendBundle`. That
    layer *can* `await` and needs no change to the shared `VisitFn` interface, so the constraint the
    ADR leans on ("the producer is synchronous") does not apply to it. This bounds the queue to
    ≈ N and reproduces Go's ceiling.
  - **Why I did not implement it unilaterally:** naive loop-level backpressure can deadlock if all
    workers exit early (e.g. all error out, so nothing ever drains the queue and `check()` parks
    forever) — a correct version must also observe `eg.signal`/worker completion. That is enough
    genuinely-new mechanism that, per REVIEW-PROTOCOL §2.4/§3, it is a decision for the human, not a
    silent reviewer fix, and the brief explicitly says not to invent a backpressure mechanism
    unilaterally.
  - **Recommendation:** treat §1 as a real regression to fix, not an accepted tradeoff. Preferred:
    add awaitable backpressure in `check()`'s loop bounding the queue to ≈ N (with worker-exit
    awareness to avoid the deadlock above). Acceptable fallback if the team disagrees: keep the
    unbounded queue but state a concrete, enforced cap (max auditable log size, or a hard queue-depth
    limit that aborts `check()` with a clear error) so the failure mode is bounded and explicit
    rather than an OOM. Do not leave it described as an untested theoretical gap.

- **Lead's resolution (2026-08-19):** the reviewer's position is correct and the fix has been
  implemented — the exact preferred option from the recommendation above, not the fallback.
  `ResourceQueue` gained `size` and `waitUntilBelow(threshold, signal?)`; `check()`'s bundle loop
  now calls `await tree.expectedResources.waitUntilBelow(resourceBackpressureThreshold(this.#opts.n), eg.signal)`
  once per bundle, right after `appendBundle` and the tree-complete check. `eg.signal` is exactly
  the worker-exit awareness the reviewer flagged as necessary: `ErrGroup` aborts it on the first
  `resourceCheckWorker` error, so `waitUntilBelow` rejects immediately rather than deadlocking if
  every consumer has already died — proven directly in
  `describe("ResourceQueue.waitUntilBelow", ...)`'s third case. The memory-bound claim is proven
  empirically, not just argued: "check()'s backpressure caps buffered resources regardless of log
  size (ADR-0091 §1)" drives a fast producer against a deliberately slow consumer through 3× the
  threshold's worth of full tiles and asserts peak queue size stays at the threshold; I confirmed
  by hand that removing the `await` makes this test fail (`peakSize` reached 48 against a threshold
  of 16) before restoring the fix. `resourceBackpressureThreshold(n) = max(4n, 16)` is O(1) in log
  size, closing the O(logSize)-vs-O(N) gap the reviewer identified — the port's ceiling is now O(N)
  like Go's, via a different mechanism (loop-level `await` instead of a blocked channel send) because
  the synchronous `VisitFn` constraint the original §1 reasoning correctly identified still holds;
  only the *reasoning about where a bound could live* was incomplete, exactly as the reviewer's "gap
  in the ADR's reasoning" note says. §1's original body above is left unedited as the historical
  record; the note at its top points here.
