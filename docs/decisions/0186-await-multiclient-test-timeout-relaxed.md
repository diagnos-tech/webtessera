# ADR-0186: `TestAwait_multiClient` runs under a 15s bound instead of Go's 1s

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** root-package fidelity agent
- **Upstream reference:** `await_test.go` (`TestAwait_multiClient`)

## Context

`TestAwait_multiClient` starts 300 concurrent `Await` calls against one `PublicationAwaiter`
whose checkpoint grows by 10 on every poll, and has each caller parse and verify the checkpoint it
is released with:

```go
testTimeout := 1 * time.Second
ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
...
cp, _, _, err := log.ParseCheckpoint(cpRaw, "example.com/log/testdata", v)
```

The bound is a safety net: if the awaiter never releases a caller, the context expires and the
test fails instead of hanging. It is not an assertion about speed.

The port verifies the 300 checkpoints with `@noble/curves`' pure-JavaScript Ed25519 (ADR-0005),
which is much slower than Go's native `crypto/ed25519`. Measured on the development container,
the test takes 1.1 to 1.3 seconds under the port, so Go's 1s bound fails it although every
caller is released correctly.

## Decision

`await_test.ts`'s `TestAwait_multiClient` uses a 15s context (and a 30s Vitest timeout around
it). Everything else is as upstream: 300 clients, 3ms checkpoint reads, 15ms futures, 10ms polls,
and the same assertions, that each caller gets back its own index and a checkpoint that verifies
and covers it. A port note at the constant points here.

## Consequences

- A regression that makes the awaiter slower, but not stuck, by up to roughly an order of
  magnitude would not fail this test. The test never measured speed in Go either; it bounds a
  hang.
- A genuinely stuck awaiter now takes 15s to report instead of 1s.

## Alternatives considered

- **Keep 1s.** Rejected: the test fails on correct code.
- **Verify fewer checkpoints, or skip verification.** Rejected: that weakens what the test checks,
  which AGENTS.md §4 forbids; relaxing the bound leaves the assertions intact.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `await_test.go` `TestAwait_multiClient` uses `testTimeout := 1 * time.Second`, 300 clients, 3ms reads, 15ms futures, 10ms polls, and verifies every released checkpoint with `log.ParseCheckpoint`. TS (`await_test.ts`) keeps every value and assertion; only the context bound is 15s and the Vitest timeout 30s.
  - Measured: the test takes 0.5-0.6 s on its own, 0.85-1.0 s with four busy processes on this four-core container, and 1257 ms inside the full parallel unit run. So the ADR's 1.1-1.3 s is reproduced under suite load, not in isolation; the 1s bound would be flaky there rather than always failing. The decision (relax a hang guard, keep the assertions) holds either way. Non-blocking: say 'under the full parallel suite' in the Context.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
