# ADR-0196: `LogStateTracker.update` checks checkpoints that are not newer

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity agent
- **Upstream reference:** `client/client.go` (`LogStateTracker.Update`)

## Context

```go
if lst.latestConsistent.Size > 0 {
	if c.Size <= lst.latestConsistent.Size {
		return lst.latestConsistentRaw, p, lst.latestConsistentRaw, nil
	}
	...
```

A checkpoint no larger than the tracked one is ignored without being compared with it. A
checkpoint of the same size with a different root, or a smaller one that is not a prefix of the
tracked tree, is evidence of an inconsistent log, which `ErrInconsistency` exists to report.

## Decision

As hardening, in that branch `update` first verifies the checkpoint against the tracked one:

- same size: the root hashes must match (`verifyConsistency` with an empty proof);
- smaller size: a consistency proof from the smaller size to the tracked size, built with the
  tracker's proof builder for the tracked size, must verify.

A failure throws `ErrInconsistency` with the smaller checkpoint as `smallerRaw`, the larger as
`largerRaw`, and the proof used. On success the return value is upstream's, unchanged.

## Consequences

- An inconsistent older or same-size checkpoint is reported, where upstream ignores it.
- A smaller checkpoint now costs the tile reads for one consistency proof. Upstream's own
  `TestCheckLogStateTracker` cases ("Identical CP", "Out of order") pass unchanged.

## Alternatives considered

- **Keep upstream's behaviour.** Rejected as hardening: the check is cheap and its failure is
  exactly what the tracker is for.
- **Reject any smaller checkpoint outright.** Rejected: a consensus source may lag; an older but
  consistent checkpoint is not an error.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `LogStateTracker.Update` (`client/client.go:305-343`) returns early for `c.Size <= latestConsistent.Size` without comparison.
  - TS: `update` calls `#verifyNotNewer` under the mutex: same size uses `verifyConsistency` with an empty proof (so the roots must match), a smaller size builds a consistency proof from the tracker's builder for the tracked size and verifies it; failures throw `ErrInconsistency` with the smaller as `smallerRaw` and the larger as `largerRaw`; success returns `{old, proof: [], newer}` as before. Upstream's 'Identical CP', 'Identical CP pairs' and 'Out of order' cases pass unchanged, and `client_test.ts` adds three tests (same size wrong root, smaller inconsistent, smaller consistent).
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
