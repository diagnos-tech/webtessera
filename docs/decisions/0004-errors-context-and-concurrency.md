# ADR-0004: Map Go errors, `context.Context` and concurrency onto TypeScript

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** lead (human-directed)
- **Upstream reference:** `log.go`, `lifecycle.go`, `append_lifecycle.go`, `storage/internal/queue.go`, `migrate.go`, `client/stream.go`, `fsck/fsck.go`

## Context

Three Go idioms appear on nearly every page of Tessera and none has a direct TypeScript equivalent:

1. **Errors as values**, with sentinel identity (`errors.Is`) and wrapping (`fmt.Errorf("%w")`).
   Tessera's public contract depends on this: `ErrPushback` tells a personality to apply
   back-pressure, and the doc comment states callers must test it with `errors.Is(e, ErrPushback)`
   *whether or not it is wrapped*. `LogReader.ReadCheckpoint` is specified to report `os.ErrNotExist`.
2. **`context.Context`** threaded through every I/O function for cancellation.
3. **Goroutines, `sync.Mutex`, `errgroup.Group`**, used for the queue flusher, the checkpoint
   publisher, migration workers, `client.EntryBundles` streaming, and fsck's parallel resource checks.

## Decision

### Errors

Go returns errors; TypeScript throws them. `return nil, fmt.Errorf(...)` becomes
`throw new Error(...)` **with the same message text**, because upstream tests assert on message
content and so do ours.

- Sentinels are exported singletons of `SentinelError`. Identity is by reference.
- `fmt.Errorf("...: %w", err)` becomes `wrapError("...", err)`, which sets `cause`.
- `errors.Is` becomes `errorIs`, walking the `cause` chain by reference, and honouring an optional
  `is(target)` method the way Go honours an optional `Is(error) bool`.
- `errors.As` becomes `errorAs`, matching by constructor.
- `os.ErrNotExist` becomes the exported `ErrNotExist` sentinel.

All of this lives in `src/internal/gostd/errors.ts`. Ports must use it rather than hand-rolling
identity checks — `e.message.includes("pushback")` is the failure mode this exists to prevent.

### Context

`context.Context` becomes `AbortSignal`, passed as an optional last parameter. Where upstream checks
`ctx.Done()` or returns `ctx.Err()`, the port calls `throwIfAborted(signal)`. Where upstream derives
a cancellable child context, the port constructs an `AbortController` chained to the parent signal.

`context.WithTimeout` becomes `AbortSignal.timeout(ms)` combined with the caller's signal via
`AbortSignal.any([...])`.

### Concurrency

`src/internal/gostd/sync.ts` provides `Mutex`, `WaitGroup`, `ErrGroup`, `Once`, `sleep`, `ticker`.

The important observation, and the one every porting agent must internalise: **JavaScript's
single-threaded run-to-completion semantics mean a purely synchronous Go critical section needs no
lock at all.** Where upstream holds a `sync.Mutex` across code that stays synchronous in TypeScript,
the port drops the lock and records why in a `// Port note:` comment. Where the critical section
spans an `await`, the lock is genuinely required, because `await` is an interleaving point — and
those are the cases `Mutex` exists for.

Blindly transliterating every `sync.Mutex` into a `Mutex` would add deadlock risk and obscure which
sections are actually load-bearing. Blindly dropping them all would introduce real races across
`await`. Each one is a judgement call and each one gets a comment.

`errgroup.Group` with `SetLimit` becomes `ErrGroup` with `setLimit`, preserving the "first error
wins, cancel the rest" contract. `time.Ticker` loops become `ticker`.

## Consequences

- Throwing loses Go's "both a value and an error" return shape. Functions that upstream expects to
  return a partial result alongside an error need care; those are called out individually in the
  ports that hit them.
- Stack traces replace error strings as the primary debugging aid, which is a net gain.
- `ErrGroup` always cancels its signal on first error, whereas Go's bare `errgroup.Group` only
  cancels when created via `errgroup.WithContext`. Tessera uses `WithContext` at the sites that
  matter, so this is a strictly-safer superset; noted here so a reviewer is not surprised.
- `sync.ts` is tested in its own right (`sync_test.ts`, 20 cases) rather than only through its
  callers, because a subtle bug in `ErrGroup` would surface as a mysterious failure three layers up.

## Alternatives considered

- **Result/Either return types** instead of throwing. Faithful to Go's shape and forces callers to
  handle errors. Rejected: every call site grows a match block, which destroys the line-by-line
  correspondence with upstream (ADR-0002), and it is not idiomatic TypeScript for a donated library.
- **Passing a `context`-shaped object** rather than `AbortSignal`. Rejected: `AbortSignal` is the
  platform primitive, already understood by `fetch` and by every runtime we target.
- **A full CSP/channel library** to mirror goroutines and `select`. Rejected: far more machinery than
  the handful of concurrency patterns Tessera actually uses, and it would make the port harder to
  read than the original.

## Review

- **Reviewer:** gostd Reviewer (agent)
- **Verdict:** approved
- **Notes:** Checked `errors.ts` against Go's `errors.Is`/`errors.As` semantics: `errorIs`
  walks the `cause` chain by reference and honours an optional `is(target)` method (Go's
  `Is(error) bool`); `errorAs` matches by constructor; `wrapError` renders `"...: <cause>"`
  exactly as `%w`; `ErrNotExist` is a reference-identity sentinel. Two deliberate, benign
  gaps vs. Go, neither reachable by any current caller: `errorIs`/`errorAs` do not handle the
  Go 1.20 multi-error `Unwrap() []error` fan-out (Tessera wraps single errors only), and
  `errorAs` does not consult an optional `As(any) bool` method (no ported error implements
  one). The cycle guard is a justified *superset* of Go, which documents the hazard rather
  than guarding it. Checked `sync.ts` line by line: `Mutex` serialises across `await` and
  serves waiters FIFO; `WaitGroup` panics on a negative counter as Go does; `ErrGroup`
  preserves first-error-wins + signal cancel, and `setLimit` gates concurrency. Verified the
  lead's fix for the `ErrGroup` parent-abort listener leak — `wait()` now calls
  `removeEventListener` and clears both stored references, and `sleep()` already cleans up its
  own abort listener on both the resolve and abort paths; these are the only two
  `addEventListener` sites in the file. `errors.ts` had no test file; added `errors_test.ts`
  (12 cases), and added one `sync_test.ts` case that pins the listener cleanup on normal
  completion with a live parent. Consequence note (line 71) that `ErrGroup` always cancels on
  first error is accurate and a strictly-safer superset. Minor, out of this ADR's scope:
  `bits.ts` shift helpers return `0n` for a negative shift count while modern Go panics — the
  path is unreachable from the Merkle layer (shift counts derive from bit-lengths).

## Update (2026-10-02)

A fidelity audit of `src/internal/gostd/` against Go 1.25.5 and `golang.org/x/sync@v0.19.0` corrected
the shims this ADR introduced. The decisions above stand; what follows changes what they describe.
Every item is pinned by a test in `sync_test.ts` (now 42 cases) or `errors_test.ts` (now 31).

**`ErrGroup`**

- **The concurrency limit could be exceeded.** A finishing task released its permit and woke the next
  queued task, which counted itself a few microtasks later; a `go()` call landing in that window found
  a free slot and took it, so three tasks ran under a limit of two. The woken task's permit is now
  counted in the same synchronous step that frees it, so no `go()` call can slip in between. The
  regression test fails against the previous implementation.
- **`signal` is also aborted the first time `wait()` returns.** This is `errgroup.WithContext`'s
  contract: the derived context is cancelled "the first time a function passed to Go returns a non-nil
  error or the first time Wait returns, whichever occurs first". The Consequences bullet above says
  only "on first error"; both now hold. With no error the reason is the default `AbortError` (Go:
  `context.Canceled`); with one it is the first error, and a parent's reason is kept if the parent
  aborted first. A caller that keeps using `eg.signal` after `eg.wait()` has returned will see it
  aborted; `fsck` threads it only into workers that `wait()` joins, and no other caller reads it.
- **`go()` queues instead of blocking the caller at the limit.** Go's `Group.Go` blocks until the new
  goroutine fits under the limit. A synchronous JavaScript caller cannot be suspended, so `go()`
  returns at once and the operation waits in a first-in-first-out queue. The limit therefore bounds how
  many operations run at once, not how far a producer can run ahead of them. This is a deliberate
  divergence; it is recorded on the class and on `go`.
- **`setLimit` follows Go.** A negative value means no limit and never throws. Zero means no operation
  may start: operations passed to `go()` stay queued, and `wait()` does not settle, until a later
  `setLimit` raises the limit (Go's `Go` blocks forever there). The "modify limit while ... goroutines
  in the group are still active" error, with Go's message text, is thrown only while operations are
  *running*, counted by an active count rather than by the tasks started so far. Before, zero meant
  unlimited, and a task that had already finished but not been waited for still made `setLimit` throw.
  A limit that is not an integer is a `RangeError`, since Go's is an `int`. No caller in the port calls
  `setLimit`.

**`Once.do`** now memoises a synchronous throw the way it memoises a rejection, so `fn` runs once
whichever way it fails; before, a throw left the `Once` unused and the next call ran `fn` again. Go's
`sync.Once` treats a panicking `f` as done. Every caller then observes the failure, as `sync.OnceFunc`
and `sync.OnceValue` do by panicking again on each call; `Once.Do` itself panics only in the first
caller.

**`ticker`** keeps to a fixed schedule, as `time.Ticker` does. Before, it slept a full period after
each body, so the doc comment's claim that this matched Go was wrong: a 40 ms body stretched a 50 ms
period to about 90 ms. Ticks now fall due at the start time plus n periods. A tick that falls due while
the body is running is held and the body runs again as soon as it returns; further ticks that fall due
meanwhile are dropped, as Go's one-slot channel drops them for a slow receiver, so a stall is never
made up with a burst. A body longer than the period runs back to back (still yielding once to the event
loop between runs). A non-positive period throws a `RangeError`, as `time.NewTicker` panics. The three
callers (`followerStats` at 200 ms and `updateStats` at 100 ms in `append_lifecycle.ts`, and the garbage
collection job in `storage/objectstore/driver.ts`, which is started only when its interval is positive)
have cheap bodies and no logic that depends on the old drift; the visible change is that a body that
outlasts its period is now followed immediately by the next one rather than after another full period.

**`errorIs` and `errorAs`** now traverse `JoinError.errors` depth-first and in order, with the cycle
guard shared across the whole traversal, as Go's `errors.Is` and `errors.As` walk `Unwrap() []error`.
This closes the gap named in the Review above and in ADR-0057. See ADR-0057 for `errors.Join` itself.

*Review of this update: approved, ADR review agent (independent), 2026-10-04.* Checked each bullet against
`golang.org/x/sync@v0.19.0/errgroup/errgroup.go`, Go 1.25.5's `sync.Once`/`time.Ticker`/`errors` and
`src/internal/gostd/{sync,errors}.ts`. `ErrGroup`: `signal` is aborted by the first error and by `wait()`
(`g.cancel(g.err)`), a parent's reason survives because aborting an aborted controller is a no-op; `go()` queues;
`setLimit` has Go's semantics for negative and zero limits and Go's exact panic text, counted on running
operations. `Once.do` memoises a synchronous throw (Go: a panicking `f` counts as done). `ticker` keeps a fixed
schedule, holds one overdue tick and drops the rest (traced by hand for a 120 ms body on a 50 ms period: ticks
due at 50, 100, 200, matching Go's one-slot channel) and throws Go's `non-positive interval for NewTicker`.
`errorIs`/`errorAs` follow `is`: self, then `Is`, then `Unwrap() []error` depth-first in order. Ran
`sync_test.ts` and `errors_test.ts` (75 pass; 44 and 31 cases, so "42" has since become 44). To check that the
limit regression test is not vacuous I reinstated the old hand-off (permit counted by the woken task, not by the
releaser) in a scratch copy: "never runs more operations than the limit while a permit changes hands" then fails.
One imprecision, not blocking: "`fsck` threads it only into workers that `wait()` joins" is loose, since
`fsck.ts` also passes `eg.signal` to the `entryBundles` stream and to `waitUntilBelow` in the producer loop. All of
that runs before `wait()`, nothing reads the signal afterwards, so the conclusion holds.

## Update (2026-10-02)

Two statements above no longer describe the code, and are corrected here rather than rewritten:

- **`context.WithTimeout`.** "`context.WithTimeout` becomes `AbortSignal.timeout(ms)` combined
  with the caller's signal" holds only where the timeout lives as long as the work it bounds. Go
  pairs `WithTimeout` with `defer cancel()`, which stops the timer and cancels the context as
  soon as the function returns; `AbortSignal.timeout` cannot be cancelled, so it keeps its timer
  pending for the full duration. Where upstream defers `cancel()`, the port uses an
  `AbortController` and a `setTimeout`, and both clears the timer and aborts the controller in a
  `finally` (`AppendOptions.checkpointPublisher` in `src/append_lifecycle.ts` is the example; see
  ADR-0082's update).
- **`errgroup`.** "Tessera uses `WithContext` at the sites that matter" is wrong: at the pinned
  commit Tessera never calls `errgroup.WithContext`. Every site (`migrate.go`,
  `migrate_lifecycle.go`, `fsck/fsck.go`, the cloud storage drivers and the experimental mirror)
  constructs a bare `errgroup.Group{}`, whose `Wait` returns the first error but cancels nothing.
  `ErrGroup` still aborts its own `signal` on the first error (and, per the update above, when
  `wait()` first returns), but that is only observable where a task is given `eg.signal`:
  `src/fsck/fsck.ts` does so deliberately and says why in its own port note, while
  `src/migrate.ts` and `src/migrate_lifecycle.ts` pass their caller's signal, as Go passes its own
  context, and so behave like Go's bare group.
- **`ticker`'s callers.** The update above names `followerStats` and `updateStats` in
  `append_lifecycle.ts` among `ticker`'s callers. ADR-0181 deletes both, so the garbage collection
  job in `storage/objectstore/driver.ts` is the only caller left.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. (The update carried no review line;
I reviewed it with the one above.)* `grep` of the pinned tree finds no `errgroup.WithContext` at all and a bare
`errgroup.Group{}` at every site the update names (`migrate.go:73`, `migrate_lifecycle.go:156`, `fsck/fsck.go:109`,
the `gcp`/`aws` drivers, `cmd/experimental/mirror/internal/mirror.go:111`), so the correction of "Tessera uses
`WithContext` at the sites that matter" is right. `context.WithTimeout` appears once in non-test library code,
`append_lifecycle.go:645`, with `defer cancel()`; `src/append_lifecycle.ts` implements it as an `AbortController`
plus `setTimeout`, cleared and aborted in a `finally`, with the port note the update describes. `fsck.ts` passes
`new ErrGroup(signal)` and explains why; `migrate.ts` and `migrate_lifecycle.ts` pass the caller's signal. The
`ticker` bullet is true: `driver.ts`'s `garbageCollectorJob` is the only caller left and it is started only
when the interval is positive.

## Update (2026-10-04): a panic whose text cannot be reproduced

A Go panic becomes a thrown `Error` with the panic's text, like a returned error. One upstream panic formats a value
whose text depends on memory: `NewWitnessGroup` (`witness.go`) panics with
`fmt.Errorf("threshold of %d outside bounds for children %s", n, children)`, and `%s` of the children slice prints
each child's fields, including the address of its verifier's state
(`[{%!s(*note.verifier=&{Wit1 2604643029 0x6ec920}) https://w.example/add-checkpoint}]`). `newWitnessGroup`
(`src/witness.ts`) throws `threshold of <n> outside bounds for children <count>` instead, with the number of
children where Go prints them; its Port note says so. The condition and the prefix are Go's.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. (The update carried no review line.)*
`witness.go:236` is the panic quoted; `src/witness.ts` `newWitnessGroup` throws
`threshold of <n> outside bounds for children <count>` under the same condition (`n < 0 || n > len(children)`),
and a probe confirms it for `-1` and `1` with no children, while `0` is accepted. The `%s` of a slice of structs
holding a `*note.verifier` does print a pointer, so the text cannot be reproduced; printing the count is a
reasonable stand-in, and the Port note says so. Neither upstream's tests nor this port's pin the message (no
test calls `newWitnessGroup` out of range), which is consistent with the update citing none, but means the
divergence is documented and not asserted. Not blocking.
