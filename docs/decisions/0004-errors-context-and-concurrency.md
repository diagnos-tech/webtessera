# ADR-0004: Map Go errors, `context.Context` and concurrency onto TypeScript

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** lead maintainer
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

The important observation, and the one every porting contributor must internalise: **JavaScript's
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

- **Reviewer:** gostd Reviewer
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
