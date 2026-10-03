# ADR-0073: Hand-rolled exponential backoff instead of `cenkalti/backoff`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate agent
- **Upstream reference:** `migrate.go`'s `copier.worker`

## Context

`copier.worker` retries each entry-bundle fetch+store with a third-party retry library:

```go
n, err := backoff.Retry(ctx, func() (uint64, error) {
    d, err := m.getEntryBundle(ctx, b.Index, uint8(b.Partial))
    ...
    if err := m.setEntryBundle(ctx, b.Index, b.Partial, d); err != nil { ... }
    return 1, nil
},
    backoff.WithMaxTries(10),
    backoff.WithBackOff(backoff.NewExponentialBackOff()))
```

`github.com/cenkalti/backoff/v5` is not `@noble/hashes`/`@noble/curves`, the only two dependencies
`AGENTS.md` §7 allows in donatable code, and there is no TypeScript equivalent already vendored
anywhere in this codebase (`src/internal/gostd/sync.ts` covers `sync`/`time.Ticker`, not a
third-party retry policy).

## Decision

`src/migrate.ts` implements a small local `retryWithBackoff<T>(maxTries, fn, signal)` helper that
reproduces the *shape* of `backoff.NewExponentialBackOff()`'s well-known, publicly documented
defaults: a 500ms initial interval, ×1.5 multiplier per attempt, capped at a 60s maximum interval,
and ±50% randomised jitter — combined with `backoff.WithMaxTries(10)`, exactly as `copier.worker`
configures it. It is not a byte-for-byte port of the library's internal jitter algorithm or its
`ctx`-cancellation plumbing (which becomes `throwIfAborted(signal)` at the top of each attempt and
`sleep(ms, signal)` between attempts, both from `src/internal/gostd/sync.ts`/`errors.ts`).

## Consequences

- No new entry in `package.json`'s `dependencies`.
- Retry *timing* is not bit-reproducible against Go's — acceptable because there is no
  `migrate_test.go` upstream to assert on it, and nothing in this codebase's golden-fixture pipeline
  (`AGENTS.md` §5) touches retry behaviour at all. `src/migrate_test.ts`'s retry tests use Vitest's
  fake timers (`vi.useFakeTimers()`/`vi.advanceTimersByTimeAsync`) specifically because real timing
  is not something either the Go original or this port needs to guarantee.
- If a future work package needs a faithful, shared `backoff`-equivalent (e.g. for a storage driver's
  own retry logic in Wave 4), this function is the natural thing to promote into
  `src/internal/gostd/` rather than duplicating — see that directory's own "add it there with tests"
  rule in `AGENTS.md` §3.5.1. It stays local to `migrate.ts` for now because it has exactly one
  caller.

## Alternatives considered

- **A fixed, non-exponential retry delay.** Simpler, but a deliberate simplification of a policy Go
  explicitly configures as exponential-with-jitter, for behaviour (transient network fetch/store
  failures during a bulk copy) where thundering-herd avoidance is exactly the reason exponential
  backoff with jitter exists. Rejected as an unforced fidelity loss.
- **No retry at all**, treating any `getEntryBundle`/`setEntryBundle` failure as immediately fatal.
  Rejected: `copier.worker`'s whole reason for existing this way, per its own doc comment ("this
  should help deal with any transient errors which may occur"), is tolerating exactly the kind of
  blip a single migration over many thousands of bundles will realistically hit.

## Review

- **Reviewer:** Witness/Migrate Reviewer (agent)
- **Verdict:** approved
- **Notes:** Checked `retryWithBackoff` against `copier.worker`'s
  `backoff.Retry(ctx, fn, WithMaxTries(10), WithBackOff(NewExponentialBackOff()))`. The loop runs
  at most `maxTries`=10 attempts, `throwIfAborted(signal)` at the top of each (Go's `ctx`
  cancellation), `sleep(ms, signal)` between attempts (cancellable), returns on first success,
  re-throws the last error on exhaustion — matching `backoff.Retry`'s contract, including "the
  final error propagates" (the worker returns it, failing `Copy`). The 500ms/×1.5/60s-cap/±50%
  jitter values are cenkalti/backoff v5's documented `NewExponentialBackOff` defaults. Not
  bit-reproducible against Go's jitter, correctly — no `migrate_test.go` exists and nothing in the
  fixture pipeline touches retry timing; `migrate_test.ts` uses fake timers and asserts attempt
  *counts* (3 for eventual success, 10 for exhaustion), not wall-clock timing. Third-party dep
  correctly avoided per AGENTS.md §7.

## Update (2026-10-02)

The Decision's "not a byte-for-byte port of the library's internal jitter algorithm or its
`ctx`-cancellation plumbing" no longer holds; `retryWithBackoff` was brought in line with
`backoff.Retry` and `ExponentialBackOff` from `github.com/cenkalti/backoff/v5` **v5.0.3** (the
version `fixtures/gen/go.mod` resolves), read from the module cache:

- The operation runs before cancellation is looked at, so it always runs at least once; the
  `throwIfAborted(signal)` at the top of each attempt is gone.
- After a failure the checks run in `Retry`'s order: once `maxTries` attempts have been made the
  operation's error is returned; then an aborted signal returns the signal's reason (Go:
  `context.Cause(ctx)`); then, if the elapsed time plus the next wait would exceed
  `DefaultMaxElapsedTime` (15 minutes, which `Retry` applies when no `WithMaxElapsedTime` option is
  given and which the old helper lacked), the operation's error is returned; a signal aborted
  during the wait returns its reason.
- The waits use `ExponentialBackOff`'s formula in nanoseconds, including its truncations and the
  `+1` in the random interval. Only the random source differs (`Math.random` for
  `math/rand/v2`), so individual waits are still not reproducible, as they are not in Go.
- `PermanentError` and `RetryAfterError` are not reproduced; the worker's operation returns
  neither.
- The worker adds the `1` its operation returns to `bundlesCopied`, as Go adds `n`.

`migrate_test.ts` pins the new cases: the operation runs once under an already-aborted signal,
a failure under an aborted signal reports the signal's reason, the last allowed try reports the
operation's error even if the signal was aborted during it, and the 15-minute bound ends retries
early. The rest of this ADR (no dependency, helper local to `migrate.ts`) stands.
