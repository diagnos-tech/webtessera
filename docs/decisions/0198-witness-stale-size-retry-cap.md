# ADR-0198: A witness update retries a stale-size reply at most three times

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity contributor
- **Upstream reference:** `internal/witness/witness.go` (`witness.update`)

## Context

On a `409` with `Content-Type: text/x.tlog.size`, `update` adopts the witness's size and calls
itself again, with no limit:

```go
// Witnesses could cause this recursion to go on for longer than expected if the value they kept returning
// this case with slightly larger values. Consider putting a max recursion cap if context timeout isn't enough.
return w.update(ctx, cp, size, fetchProof)
```

## Decision

As hardening, and as upstream's comment contemplates, one update retries at most three times after
a stale-size reply. A fourth such reply fails the update with
`witness at "<url>" replied with a stale x.tlog.size after 3 retries, the last <n>`. The witness's
recorded size is still updated from each reply, as in Go.

## Consequences

- A witness that keeps answering with a different size is given up on after four requests,
  instead of until the caller's signal fires. An honest witness needs one retry.
- `witness.update` takes an internal retry counter as a trailing parameter.

## Alternatives considered

- **Rely on the caller's signal, as Go relies on its context.** Rejected: nothing requires a caller
  to set a deadline.
- **A single retry.** Rejected: a witness may legitimately cosign another checkpoint between the
  two requests.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
