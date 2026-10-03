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

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
