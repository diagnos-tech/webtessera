# ADR-0083: Structural mappings for `NewAppender`, the `sync.Cond` awaiter, and the concurrency drops

- **Status:** accepted; item 8's reasoning about `terminator` is corrected by its 2026-10-02 update
- **Date:** 2026-08-19
- **Author:** append-lifecycle contributor
- **Upstream reference:** `append_lifecycle.go` (`NewAppender`, `terminator`, `AppendOptions`),
  `await.go` (`PublicationAwaiter`)

## Context

Beyond the OTel drop (ADR-0080) and the witness wiring (ADR-0082), completing this file forced a
cluster of smaller Go→TS structural decisions, each individually minor but collectively worth a
record so a reviewer is not surprised.

## Decision

**1. Multi-value returns → named readonly objects (per ADR-0031).**
`NewAppender` returns `(*Appender, func(ctx) error, LogReader, error)`; the driver's `Appender`
method returns `(*Appender, LogReader, error)`. These become `NewAppenderResult`
(`{appender, shutdown, reader}`) and `AppenderInit` (`{appender, reader}`), with the trailing error
thrown (ADR-0004). Both interface names are new (Go's returns are positional/anonymous), additive,
and exported so drivers have a name to implement against.

**2. Go's local `appendLifecycle` interface + type assertion.**
Go does `lc, ok := d.(appendLifecycle)` against an unexported interface local to `NewAppender`.
TypeScript has no method-set type assertion, so this becomes an exported `AppendLifecycle` interface
plus an `isAppendLifecycle(d)` runtime guard (`typeof d.appender === "function"`). The `%T` in
`"driver %T does not implement Appender lifecycle"` becomes a best-effort `typeName(d)` (constructor
name / `typeof`); no test asserts the exact rendering.

**3. `newCP` is synchronous.** Go's `newCP func(ctx, size, hash) ([]byte, error)` does only
synchronous work (checkpoint marshal + `note.Sign`); its `ctx` fed only the dropped tracer span. Per
`PORTING.md` §3.7 (hashing/signing is synchronous), the field is
`(size: bigint, hash: Uint8Array) => Uint8Array`, throwing instead of returning an error.

**4. `opts` nullability.** `NewAppender`'s `opts *AppendOptions` is typed `AppendOptions | null` so
the `"opts cannot be nil"` guard is reachable and faithful, rather than being made unreachable by a
non-null type.

**5. `AppendOptions` zero value folded into the constructor.** Go's `NewAppendOptions()` sets the
non-zero defaults and the struct's bare zero value has `nil` func fields. TypeScript class fields
must all be initialised, and the func fields cannot be `nil`, so the `NewAppendOptions` defaults are
applied in the constructor and `newAppendOptions()` is `new AppendOptions()`. Go callers always go
through `NewAppendOptions`, so no behaviour depends on the distinct bare zero value.

**6. Field visibility.** Per `docs/decisions/0010`: `entriesPath` is `_entriesPath` (public,
`@internal`) because the accessor `entriesPath()` collides with it *and* ct_only.ts's future
`WithCTLayout` overrides it cross-module; `bundleIDHasher`/`addDecorators`/`followers` are public
plain because module-level `newAppender` or cross-module ct_only.ts read them; everything purely
class-internal (`newCP`, `batchMaxAge`, …, `witnesses`, `witnessOpts`) is `#private`, and the
accessor/field name collision it would otherwise cause is avoided because `#name` and `name()` live
in different namespaces.

**7. `PublicationAwaiter`: `sync.Cond` → broadcast/wait.** Go coordinates the poll loop and blocked
`Await` callers with a `sync.Cond`. JavaScript cannot block a thread, so `Cond.Wait`/`Broadcast`
become a list of pending resolvers woken on each poll update; the loop guard re-checks the condition
after each wake exactly as `Cond.Wait` requires. No lock guards `size`/`checkpoint`/`err` because
every access is synchronous (ADR-0004). Cancellation is handled Go's way — the `Await` loop guard
re-checks `signal.aborted`, and the poll loop issues a final broadcast when its own `sleep` is
cancelled — rather than registering a per-wait abort listener, which would both churn a listener on
the caller's (possibly composite) signal on every wakeup and diverge from Go's wake-on-broadcast-only
semantics.

**8. Dropped mutexes (per ADR-0004), each justified in a `// Port note:`.**
`terminator`'s `sync.RWMutex` guarding `stopped` is dropped: `terminator.add`'s body and the
synchronous prefix of `terminator.shutdown` (set `stopped`, read `largestIssued`, early-return on 0)
contain no `await`, so run-to-completion already guarantees an add cannot observe a half-applied
shutdown. `terminator.largestIssued` (`atomic.Uint64` + CAS loop) becomes a plain field with a
synchronous compare-and-set. `integrationStats.indexSample` (`atomic.Pointer`) becomes a plain
nullable field. `inMemoryDedup`'s two `sync.OnceValue`s become plain captured variables (the build
step is synchronous). Each is annotated at the site.

## Consequences

- Several new exported type names (`AppendLifecycle`, `AppenderInit`, `NewAppenderResult`,
  `WitnessOptions`) with no direct Go counterpart, all additive. A donation reviewer diffing exported
  symbols needs this ADR + ADR-0031 to place them.
- The dropped mutexes are correct *only* because the guarded sections are synchronous; if a future
  change introduces an `await` into `terminator.add` or `AppendOptions`' setters, the ADR-0004
  analysis must be redone. The `// Port note:` at each site states the precondition.

## Alternatives considered

- **Tuples for the multi-returns.** Rejected per ADR-0031 (already the project convention).
- **Transliterate every `sync.Mutex`/atomic into `gostd/sync` primitives.** Rejected per ADR-0004:
  it would add deadlock risk and obscure which sections are actually load-bearing across `await`.
- **A per-wait abort listener in the awaiter for prompt cancellation.** Rejected: needless
  listener churn on the caller's signal and a divergence from Go's `Cond` wake semantics (which
  cannot observe ctx and relies on the next broadcast); the final broadcast-on-cancel gives the same
  result.

## Review

- **Reviewer:** Append-Lifecycle Reviewer
- **Verdict:** approved
- **Notes:** Read `append_lifecycle.go` and `await.go` in full against the ports. Checked each of the
  eight structural mappings; the load-bearing ones are the concurrency drops (item 8) and the
  `sync.Cond` awaiter (item 7), which I verified independently rather than on the ADR's say-so:

  - **Decoration order (item 1's neighbourhood):** the port's
    `for (i = addDecorators.length-1; i>=0; i--) a.add = dec(a.add)` matches Go's reverse loop
    exactly, so `decorators[0]` ends up outermost; for `WithAntispam` that puts in-memory dedup
    outside the persistent antispam decorator, as Go intends. The fake-driver test asserts
    `order === ["A","B"]` for decorators `[A,B]`; a forward loop would yield `["B","A"]`, so the test
    genuinely distinguishes the two orderings (it is not vacuous).
  - **`terminator` RWMutex + `atomic.Uint64`:** `add()` is synchronous from the `#stopped` check
    through `#delegate(...)` to the return (no `await`), and `shutdown()`'s prefix (set `#stopped`,
    read `#largestIssued`, early-return on 0) is likewise synchronous, so under run-to-completion an
    add cannot observe a half-applied shutdown — the RWMutex's whole purpose. The `largestIssued`
    compare-and-set runs after `await res()` but the read+write pair itself has no interleaving
    point, so it cannot lose an update — equivalent to Go's atomic CAS loop.
  - **`integrationStats.indexSample` (`atomic.Pointer`):** `sample()` and `latency()` are each fully
    synchronous; the CAS-on-empty and load/store-nil semantics are preserved atomically.
  - **`inMemoryDedup` `sync.OnceValue` and `memoizeFuture` `sync.OnceValues`:** both build steps are
    synchronous (the `built`/`promise` captured variable is set before any `await`), so at-most-once
    holds without a lock; `add()` is synchronous through `return f()`, so even "concurrent" same-entry
    adds cannot both miss the cache. `memoizeFuture`'s concurrent test uses `Promise.all([f(),f()])`
    with a yielding delegate and asserts `calls===1`; a resolve-then-cache memoizer would give
    `calls===2`, so it exercises real overlap, not just sequential caching.
  - **`PublicationAwaiter` (item 7):** the `#wait()`/`#broadcast()` pair replaces `Cond.Wait`/
    `Broadcast`; the condition is re-checked after each wake and the register-a-waiter step is
    synchronous with the guard check, so there is no lost-wakeup window. Cancellation matches Go's
    up-to-one-poll latency (waiter woken by the next broadcast, not a per-wait listener), and the
    poll loop's final broadcast-on-cancel plus its setting of `#err` means a late `await()` returns
    the error immediately rather than hanging — I traced this against Go's `a.err`-set-under-lock
    behaviour and it is equivalent.

  Items 2–6 (named multi-returns, `AppendLifecycle` guard, synchronous `newCP`, `opts` nullability,
  folded zero value, field visibility) are faithful and additive; the new exported names are
  accounted for by ADR-0031/0010. Full suite and typecheck green after review.

## Update (2026-10-02)

Status changed from "proposed" to "accepted" on the strength of the approved verdict recorded
above; no new review was made.

**Item 8 is corrected for `terminator`.** The reasoning that `terminator`'s `sync.RWMutex` could be
dropped looked only at the race the lock prevents, which run-to-completion does rule out. It missed
that Go's `Shutdown` holds the write lock for its whole body, across the polling loop's sleeps and
checkpoint reads, so an `Add` that arrives during `Shutdown` blocks on the read lock until
`Shutdown` returns, and only then fails. The port now keeps that: `terminator` has a gostd `Mutex`
that `shutdown` holds for its whole body, with upstream's comment on the lock carried over. `add`
takes no lock (its body never awaits, so it cannot be part-way through when `shutdown` takes the
lock), but once it sees `stopped`, the future it returns waits for the lock before failing with
"appender has been shut down"; an AddFn returns its future synchronously, so the future is what
waits where Go's caller would block. A port addition test pins it. The other drops listed in item
8 (`largestIssued`, `indexSample`, and the `sync.OnceValue`s) stand, although `indexSample` itself
is gone with `integrationStats` (ADR-0181).

**Item 7.** `PublicationAwaiter.await` now returns `[Index, Uint8Array]`: Go's nil checkpoint is an
empty `Uint8Array` internally, and a successful `await` only ever returns a checkpoint that a poll
parsed. The poll loop is `pollLoop` (`@internal`), no longer `_pollLoop`, since nothing collides
with its name.

## Update (2026-10-04)

Two statements of this ADR were inaccurate, and one behaviour of item 8 was not recorded:

- **Item 8 says "`inMemoryDedup`'s two `sync.OnceValue`s".** There is one: the `OnceValue` that builds the deduplicated
  entry's `IndexFuture` (`antispam.go`). The other one-shot is `memoizeFuture`'s `sync.OnceValues`
  (`append_lifecycle.go`).
- **`sync.OnceValue` re-panics.** If its function panics, every later call panics with the same value, and the function
  is never called again. The captured-variable rendering in `inMemoryDedup` did not do that: a delegate that threw
  synchronously (instead of returning a failing future) left nothing cached, so the duplicate's future called the
  delegate a second time and could resolve where Go's re-panics. It now remembers the thrown value and rethrows it on
  every later call, as `memoizeFuture` already did for `OnceValues`; the duplicate's future therefore rejects with that
  value, and the delegate is called once, as in Go (the audit's probe: `add#1 recovered=delegate exploded; future#2
  recovered=delegate exploded; delegateCalls=1` on both sides). Only an `AddFn` that throws can reach this; the
  in-tree queue never does. `antispam_test.ts` pins it.
- **Consequences listed `WitnessOptions` among exported names "with no direct Go counterpart".** It has one:
  `append_lifecycle.go`'s exported `WitnessOptions` struct (`Timeout`, `FailOpen`), which the port's interface mirrors
  with the fields camelCased. `AppendLifecycle`, `AppenderInit` and `NewAppenderResult` remain the additions.
