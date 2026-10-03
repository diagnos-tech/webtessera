# ADR-0181: Delete the instrumentation that only fed dropped metrics and logs; supersede ADR-0080's "keep as logic"

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** root-package fidelity contributor
- **Upstream reference:** `append_lifecycle.go` (`idxAt`, `integrationStats` with `sample`/`latency`/`updateStats`/`statsDecorator`, `followerStats`, their wiring in `NewAppender`), `migrate_lifecycle.go` (`progress`)

## Context

OpenTelemetry and klog are dropped from the whole port (ADR-0051, ADR-0061, ADR-0070, ADR-0080).
ADR-0080 nevertheless kept, "as logic", the structures in `append_lifecycle.go` whose only job is
to feed metrics:

- `integrationStats.statsDecorator` wraps every `Add` to record a sample of the assigned index;
- `integrationStats.updateStats` is a goroutine that, every 100ms for as long as the appender
  lives, reads `IntegratedSize` and `NextIndex` and consumes the sample;
- `followerStats` is a goroutine per follower that, every 200ms, reads `EntriesProcessed` and
  `IntegratedSize`.

Their only sinks were `appenderIntegratedSize`, `appenderIntegrateLatency`, `appenderNextIndex`,
`appenderAddsTotal`, `appenderAddHistogram`, `followerEntriesProcessed` and `followerLag`, all
dropped. ADR-0080 itself said the retained loops compute values nothing consumes, and its
reviewer recorded a reservation about their I/O cost on the metered runtimes this port targets,
adding that if the project followed ADR-0051's precedent the structures and loops should go
together.

The cost is real on this port's storage. Every `integratedSize` and `nextIndex` call on the
`ObjectStore` driver reads and parses the `.state/treeState` object. `updateStats` alone is two
such reads every 100ms, about 20 a second and 1.7 million a day per appender, plus two more every
200ms per follower; on IndexedDB each is a read transaction, on SQLite a query, on a Durable
Object a billed storage read. The results are thrown away.

`migrate_lifecycle.go`'s `progress` is the same case on a smaller scale: its only caller is
`Migrate`'s once-a-second "Progress: ..." goroutine, which feeds `klog.Infof` and which ADR-0070
already dropped. ADR-0070 kept `progress` itself, ported and tested, with the justification that
tooling might scrape its output from logs; this port never writes that output anywhere. Its
`%.2f` rendering was also not Go's (it rounded exact halves up where Go rounds them to even, and
did not wrap `p*100` at 2^64), which would have needed a float formatter written only for a
function nothing calls.

## Decision

Following ADR-0051 and ADR-0070, code whose only effect was to feed dropped metrics or logs is
not ported:

- `idxAt`, `integrationStats` (`sample`, `latency`, `updateStats`, `statsDecorator`) and
  `followerStats` are deleted from `src/append_lifecycle.ts`, along with their wiring in
  `newAppender` (the `statsDecorator` wrapping of `add` and the two background loops). A port note
  at the call site and the file header say what Go does there.
- `progress` is deleted from `src/migrate_lifecycle.ts`, with its tests.

This supersedes the "keep the stats data-structures as logic" part of ADR-0080 (its title and the
table's "Kept as logic" column for `idxAt`, `integrationStats.*` and `followerStats`). The rest of
ADR-0080 stands: OTel and klog are dropped, `terminator.largestIssued` and `CheckpointPublisher`'s
real work are kept, and `WithCheckpointSigner`'s `klog.Exitf` becomes a throw. It also updates
ADR-0070's statement that `progress` is still ported.

## Consequences

- An appender no longer polls its storage in the background beyond what the driver itself does
  (integration, publication, garbage collection) and what followers do.
- The side-by-side diff with `append_lifecycle.go` has a gap where the metric plumbing sits, the
  same kind of gap ADR-0051 left in `storage/internal`. Restoring metrics later means porting
  these structures from Go together with whatever metrics API is chosen, rather than only
  attaching emission to retained code.
- `newAppender` returns an `add` that is one wrapper shallower; no behaviour depended on the
  removed wrapper, which only sampled indices on success.

## Alternatives considered

- **Keep them, as ADR-0080 decided.** Rejected for the cost above, for a result nobody reads.
- **Keep the structures but not the loops.** Rejected, as ADR-0080's reviewer argued: without
  `updateStats` nothing consumes `statsDecorator`'s sample, so it would be dead code wrapping
  every `add`.
- **Make `progress` Go-exact instead** (round-half-even `%.2f`, `uint64` wraparound of `p*100`).
  Feasible, but it would add a float formatter whose only caller is a test, to keep a helper
  whose only upstream caller is deliberately not ported.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
