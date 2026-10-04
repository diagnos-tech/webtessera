# ADR-0192: A worker count below one is rejected instead of hanging

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity contributor
- **Upstream reference:** `client/stream.go` (`EntryBundles`), `fsck/fsck.go` (`New`, `Opts`)

## Context

`EntryBundles(ctx, numWorkers uint, ...)` fills a token bucket with `numWorkers` tokens and takes one
before each fetch. With `numWorkers == 0` no token ever exists, so the producer blocks and the
iterator never yields or returns: run at the pinned commit, it had not completed after 2s.
`fsck.New` normalises `Opts.N == 0` to 1, so fsck itself never passes 0; but `N` is a `uint`, and
TypeScript's `number` can also hold negative, fractional and NaN values a `uint` cannot.

## Decision

- `entryBundles` throws `RangeError("numWorkers must be an integer of at least 1, got <n>")` when
  called with a `numWorkers` that is not an integer of at least 1. It is checked when
  `entryBundles` is called, before any fetch.
- `newFsck` keeps Go's zero-value rule — an unset or zero `n` means 1 — and throws
  `RangeError("Opts.n must be an integer of at least 1, got <n>")` for a negative, fractional or
  NaN `n`.

## Consequences

- Where Go blocks forever, the port fails immediately and says why. A hang is never something a
  caller relies on.
- `entryBundles` is now a plain function returning the async generator, so that the check runs at
  the call rather than at the first `next()`.

## Alternatives considered

- **Reproduce the hang.** Rejected: an iterator that never settles is a defect, not behaviour.
- **Treat 0 as 1, as `fsck.New` does.** Rejected for `entryBundles`: Go's `EntryBundles` does not do
  that, and silently choosing a worker count hides the caller's mistake.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Code matches the Decision: `entryBundles` is a plain function that throws `RangeError("numWorkers must be an integer of at least 1, got <n>")` before any fetch, and `newFsck` maps unset/0 to 1 and throws `Opts.n must be an integer of at least 1, got <n>` for negative, fractional or NaN values; tests exist (`stream_test.ts` 'numWorkers below 1', `fsck_test.ts` 'newFsck validates Opts.n').
  - Factual error in the Context, which understates the divergence. It says that with `numWorkers == 0` 'the producer blocks and the iterator never yields or returns'. I ran the pinned Go `EntryBundles` with 0 workers: a non-empty range hangs (2s timeout), but an empty tree and `N = 0` return after zero yields, and a failing `getSize` yields that error and returns. The port's check is unconditional, so in those three cases Go terminates normally and the port now throws `RangeError`. The Consequences ('where Go blocks forever, the port fails immediately') hide that.
  - Required change: amend the Context to say the hang needs at least one bundle to fetch, and the Consequences to record that `entryBundles(0, ...)` now throws even for an empty range or a failing `getSize`, where Go returns an empty or error-only iteration (or restrict the check to what hangs).
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
