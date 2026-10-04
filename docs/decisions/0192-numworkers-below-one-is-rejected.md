# ADR-0192: A worker count below one is rejected instead of hanging

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity agent
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Code matches the Decision: `entryBundles` is a plain function that throws `RangeError("numWorkers must be an integer of at least 1, got <n>")` before any fetch, and `newFsck` maps unset/0 to 1 and throws `Opts.n must be an integer of at least 1, got <n>` for negative, fractional or NaN values; tests exist (`stream_test.ts` 'numWorkers below 1', `fsck_test.ts` 'newFsck validates Opts.n').
  - Factual error in the Context, which understates the divergence. It says that with `numWorkers == 0` 'the producer blocks and the iterator never yields or returns'. I ran the pinned Go `EntryBundles` with 0 workers: a non-empty range hangs (2s timeout), but an empty tree and `N = 0` return after zero yields, and a failing `getSize` yields that error and returns. The port's check is unconditional, so in those three cases Go terminates normally and the port now throws `RangeError`. The Consequences ('where Go blocks forever, the port fails immediately') hide that.
  - Required change: amend the Context to say the hang needs at least one bundle to fetch, and the Consequences to record that `entryBundles(0, ...)` now throws even for an empty range or a failing `getSize`, where Go returns an empty or error-only iteration (or restrict the check to what hangs).
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.

## Update (2026-10-04): `numWorkers == 0` is refused only where Go hangs

This answers the Review above.

- **The Context overstated the hang.** Go's `EntryBundles` with `numWorkers == 0` blocks only when there is a bundle
  to fetch. Its producer takes a token before each fetch, and there are none. With nothing to fetch, it closes the
  channel and the iterator returns after no yields. A failing `getSize` is sent before any token is needed, so it is
  yielded and the iterator returns. Run against `client.EntryBundles` at the pinned commit under Go 1.24.7 and
  1.25.5, with a 2s limit:
  - These returned after no yields: an empty tree, `N = 0`, `fromEntry` at the tree size, and `fromEntry` past it.
  - A failing `getSize` yielded its error and returned.
  - `[0, 600)` of 600 entries, and `[0, 1)` of 1, hung.
  - None of them called `getBundle`.
- **The port now refuses exactly that case.** `entryBundles` (`src/client/stream.ts`) still refuses, when it is
  called, a `numWorkers` that Go's `uint` cannot hold: a negative, fractional or NaN value. `0` is a `uint`, so it
  is no longer refused at the call. The generator calls `getSize` and builds the range, as for any worker count.
  It throws the same `RangeError("numWorkers must be an integer of at least 1, got 0")` only if the range holds at
  least one bundle, the point where Go's producer would block, and before any fetch. Otherwise it behaves as Go
  does: an empty range ends after no yields, and a `getSize` error is thrown, which is how the port returns an
  iterator error (ADR-0066).
- **Consequences, corrected.** "Where Go blocks forever, the port fails immediately" now holds exactly. For
  `numWorkers == 0`, the refusal comes at the first `next()` and not at the call. ADR-0066's lazy start already
  defers `getSize`, and the range is not known before it. The second Consequences bullet still holds: `entryBundles`
  stays a plain function for the domain check.
- **`newFsck` is unchanged.** It maps an unset or zero `n` to 1, as `fsck.New` does, so fsck never passes 0. It
  refuses only values a `uint` cannot hold.
- **Tests.** `stream_test.ts`, "port addition: numWorkers below 1", has these cases:
  - −1, 1.5 and NaN throw at the call.
  - "numWorkers=0, …" runs Go's seven cases above, and asserts each outcome and that `getBundle` is never called.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. See the Re-review below.*

## Re-review (2026-10-04)

- **Re-review:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - The earlier Review's point (the Context overstates the hang, and the check is unconditional) is answered by narrowing the code and recording it. I reproduced Go with `client.EntryBundles` at the pinned commit (own probe, `numWorkers = 0`, 2 s limit): an empty tree, `N = 0`, `fromEntry` at the size and past it return after no yields with no `getBundle` call; a failing `getSize` yields its error once and returns; `[0, 600)` of 600 and `[0, 1)` of 1 hang; a control with one worker yields 3 bundles.
  - `streamEntryBundles` throws the `RangeError` only when `numWorkers === 0 && infos.next().done !== true`, that is, when the range holds a bundle, and before any fetch; an empty range ends with no yields and a `getSize` error is thrown (ADR-0066's mapping of a yielded error). `entryBundles` still refuses -1, 1.5 and NaN when called. The seven cases are in `stream_test.ts` "port addition: numWorkers below 1", each asserting the outcome and that `getBundle` is never called. `stream_test.ts`, `client_test.ts` and the fsck tests pass (88). `newFsck` is unchanged (unset or 0 means 1; refuses what a `uint` cannot hold).
  - The corrected Consequences (for 0 the refusal comes at the first `next()`, not at the call; the second Consequences bullet still holds) is accurate. The Decision's first bullet still says "checked when `entryBundles` is called", which the Update supersedes for 0, history kept.
