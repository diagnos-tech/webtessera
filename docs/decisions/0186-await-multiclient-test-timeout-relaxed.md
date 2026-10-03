# ADR-0186: `TestAwait_multiClient` runs under a 15s bound instead of Go's 1s

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** root-package fidelity contributor
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
  which PORTING.md §4 forbids; relaxing the bound leaves the assertions intact.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
