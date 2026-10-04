# ADR-0080: `append_lifecycle.ts`/`await.ts`/`antispam.ts` drop OpenTelemetry and klog; keep the stats data-structures as logic

- **Status:** accepted; its "keep the stats data-structures as logic" part is superseded by ADR-0181 (accepted)
- **Date:** 2026-08-19
- **Author:** append-lifecycle contributor
- **Upstream reference:** `append_lifecycle.go` (lines 39-210, and the `.Record`/`.Add` call sites throughout), `otel.go`, `await.go`, `antispam.go`

## Context

`append_lifecycle.go` opens with ~170 lines of OpenTelemetry metric setup: eleven metric
handles (`appenderAddsTotal`, `appenderAddHistogram`, `appenderHighestIndex`,
`appenderIntegratedSize`, `appenderIntegrateLatency`, `appenderDeadlineRemaining`,
`appenderNextIndex`, `appenderSignedSize`, `appenderWitnessedSize`, `appenderWitnessRequests`,
`appenderWitnessHistogram`, plus `followerEntriesProcessed`/`followerLag`), a custom
`histogramBuckets` slice, and an `init()` that constructs them all via `meter.Int64*`, calling
`klog.Exitf` on failure. `otel.go` defines the `tracer`/`meter` and the `followerNameKey`
attribute. These feed `.Record(...)`/`.Add(...)` call sites scattered through `NewAppender`,
`integrationStats`, `followerStats`, `terminator`, `CheckpointPublisher` and
`WithCheckpointSigner`. `await.go` and `antispam.go` additionally carry `klog.*` logging.

The root `otel.go` and a real OpenTelemetry-for-JS dependency are not on this work package's
allow-list (`PORTING.md` §7 caps donatable dependencies at `@noble/*`), and this is the third
package in the port to hit exactly this — `docs/decisions/0051` did it for `storage/internal`
and `docs/decisions/0061` for `client`.

A wrinkle unique to this file: the metrics are fed by *real data structures* — `integrationStats`
(`sample`/`latency`/`updateStats`/`statsDecorator`), `idxAt`, and `followerStats` — that have
their own behaviour (a sample/consume ring for integration latency, periodic progress polling)
independent of whether the numbers are ever emitted.

## Decision

Drop every OpenTelemetry construct (the metric vars, `histogramBuckets`, the `init()`,
`otel.go`'s tracer/meter/attribute keys, and every `.Record`/`.Add` call) and every `klog.*`
logging call across `append_lifecycle.ts`, `await.ts` and `antispam.ts`. No stand-in tracer,
meter or logger is introduced. `internal/otel/cast.go`'s `Clamp64` is not needed because its only
callers here are the dropped `.Record` arguments.

**Keep the stats data structures and their logic; drop only emission.** Concretely:

| Symbol | Kept as logic | Dropped (emission only) |
| --- | --- | --- |
| `idxAt` | the whole struct (`idx`, `at`) | — |
| `integrationStats.sample` | the compare-and-set that stores a sample | — |
| `integrationStats.latency` | the "is sample covered? consume it, return elapsed" logic | — |
| `integrationStats.updateStats` | the 100ms poll loop, `IntegratedSize`/`NextIndex` reads, the sample-consuming `latency(s)` call | `appenderIntegratedSize`/`appenderIntegrateLatency`/`appenderNextIndex` records |
| `integrationStats.statsDecorator` | wrapping `Add`, and `sample(idx.Index)` on the success path | `start` timing, the pushback/error/duplicate attribute bucketing, `appenderAddsTotal`/`appenderAddHistogram` |
| `followerStats` | the 200ms poll loop and the `EntriesProcessed`/`size` reads | `f.Name()`, the attributes, `followerEntriesProcessed`/`followerLag` records |
| `terminator.Add` future | `largestIssued` tracking | `appenderHighestIndex` record |
| `CheckpointPublisher` | signing, old-size lookup, witnessing | `appenderSignedSize`/`appenderWitnessRequests`/`appenderWitnessedSize`/`appenderWitnessHistogram` |

**Honesty note the work package asked for explicitly:** with emission removed, the retained
`followerStats` loop and the retained reads inside `updateStats` compute values that nothing
consumes — they are behavioural *only* in the sense of continuing to poll the follower/reader.
`integrationStats.sample`/`latency` and `statsDecorator`'s sampling do have a real internal effect
(they maintain and consume the single held sample), but that effect too is observable only through
the dropped metric. So this is a faithful structural port of code whose *entire* current purpose is
instrumentation; it is kept (rather than deleted like `storage/internal`'s spans) because the work
package directed that these particular structures be ported as logic so that restoring OTel later is
a localised change and the side-by-side diff against `append_lifecycle.go` stays aligned. A reviewer
who would prefer these deleted outright (as ADR-0051 deleted spans) should say so — this is the most
debatable call in the package.

One `klog` call is **not** dropped but converted: `WithCheckpointSigner`'s
`klog.Exitf("...additional signer name...does not match...")` is a fatal misconfiguration guard
(log-and-`os.Exit`), not observability, so it becomes a `throw` preserving the message. Dropping it
would silently accept mismatched signer names.

## Consequences

- No metrics/tracing/logging surface exists in these three files. A transparency-dev reviewer
  diffing exported symbols will not find the metric vars, `init()`, or `otel.go` and needs this ADR
  (alongside `docs/decisions/0051`/`0061`) to know why.
- The retained `updateStats`/`followerStats` loops do real I/O (`IntegratedSize`, `NextIndex`,
  `EntriesProcessed`) whose results are discarded until OTel is restored. This is wasteful but
  faithful; it is called out here so nobody mistakes it for a bug.
- Restoring the metrics is purely additive: the numbers are all still computed at the call sites
  where Go emitted them.

## Alternatives considered

- **Delete `integrationStats`/`followerStats` entirely (as ADR-0051 deleted spans).** They are pure
  instrumentation once emission is gone, so this is defensible and leaves less dead code. Rejected
  because the work package explicitly directed porting the sample/consume structure and the poll
  loops as logic; recorded here so the reviewer can overrule.
- **Port `otel.go` + a real OpenTelemetry JS SDK.** Rejected: off the §7 allow-list, and out of
  scope, exactly as ADR-0051/0061 concluded.
- **`console.*` for the klog lines.** Rejected: banned by `PORTING.md`'s definition of done.

## Review

- **Reviewer:** Append-Lifecycle Reviewer
- **Verdict:** approved (with a recorded reservation the maintainers may overrule)
- **Notes:** Read `append_lifecycle.go`, `await.go`, `antispam.go` and `otel.go` in full against
  their ports. Confirmed every `.Record`/`.Add` site listed in the Decision table is dropped and
  every retained structure (`idxAt`, `integrationStats.sample`/`latency`/`updateStats`/
  `statsDecorator`, `followerStats`, `terminator.largestIssued`) is ported as logic. The one
  converted (not dropped) klog line — `WithCheckpointSigner`'s `klog.Exitf` mismatch guard →
  `throw` — is correct: it is a fatal-misconfiguration guard (log-and-`os.Exit`), not observability,
  and dropping it would silently accept mismatched additional-signer names; message text preserved
  via `%q`→`quote`.

  On the debatable call the ADR flagged: I grepped the whole landed `src/` and found **no consumer**
  of `integrationStats`/`followerStats`/`updateStats`/`statsDecorator`/`sample`/`latency` outside
  `append_lifecycle.ts` itself, so the retained computation is genuinely dead in the current tree —
  its only sink was the dropped metric. **Recommendation: keep them, as the ADR decided.** The
  fidelity argument (side-by-side diff with `append_lifecycle.go` stays aligned; OTel restoration is
  purely additive rather than a re-port from Go) and PORTING.md §1's "don't omit either" outweigh the
  dead-code concern, and this is exactly the kind of instrumentation upstream *does* run in
  production — deleting it here would diverge from Go, not track it. This is materially different
  from ADR-0051's spans, which were behaviourless wrappers; the sample/consume slot is real logic.
  **Recorded reservation:** the two always-on poll loops (`updateStats` @100ms, `followerStats`
  @200ms) perform real background I/O (`integratedSize`/`nextIndex`/`entriesProcessed`) whose results
  are discarded until OTel returns, and the explicit deploy target is metered edge runtimes
  (Workers/DO) where that unbounded polling is a genuine (if small) cost, not merely "wasteful but
  faithful." I do not think that tips the balance to deletion — but if the project later decides to
  follow ADR-0051's delete-instrumentation precedent strictly, the consistent move is to delete the
  structures *and* the loops together, not a half-measure. Not escalating, because I agree with the
  author's call on balance.

  One behavioural nuance I verified and accept: `statsDecorator`'s throw model means the port does
  not sample index 0 on the error path where Go's zero-`Index` + `!idx.IsDup` does. It is genuinely
  unobservable while emission is dropped (the sample's only sink is the dropped metric; `updateStats`
  calls `latency(s)` identically either way), and is honestly disclosed in the in-file port note.
  Fixed a dangling doc reference in three files that pointed at the pre-split filename
  `0080-append-lifecycle-otel-and-lru.md` (now `-otel-and-klog.md` for the OTel/klog refs in
  `append_lifecycle.ts`/`await.ts`, and `0081-antispam-lru-subset-not-hashicorp.md` for the LRU ref
  in `antispam.ts`).

## Update (2026-10-02)

Status changed from "proposed" to "accepted" on the strength of the approved verdict recorded
above (no new review was made), and the part of the decision that kept the stats structures as
logic is superseded by ADR-0181: `idxAt`, `integrationStats` (`sample`, `latency`,
`updateStats`, `statsDecorator`) and `followerStats` are deleted, with their wiring in
`newAppender`. That follows the reviewer's recorded reservation above: with emission gone, the two
always-on loops read the storage several times a second (on this port's `ObjectStore` driver,
each `integratedSize`/`nextIndex` call reads and parses `.state/treeState`) for values nobody
reads. The rest of this ADR stands: OTel and klog are dropped, `terminator.largestIssued` and
`CheckpointPublisher`'s work are kept, and `WithCheckpointSigner`'s `klog.Exitf` is a throw.

*Review of this update: approved, ADR reviewer (independent), 2026-10-04. (The update carried no review line, and its status change was made without a new
review, as it says; I checked what it states.)* `idxAt`, `integrationStats`, `statsDecorator`, `updateStats` and `followerStats` no longer exist in `src/` (the only
mentions are the two comments in `append_lifecycle.ts` that say they were removed, lines 23 and 215). `terminator`'s `#largestIssued` is kept, and
`WithCheckpointSigner`'s `klog.Exitf` guard is a thrown `Error` with the quoted message (lines 671 and 716), as the update lists. The cost it gives as the reason is real:
the object-store driver's `integratedSize`/`nextIndex` are `readTreeState()` calls (`driver.ts:842, 847`), so the removed 100 ms and 200 ms loops each read
the state file several times a second for nothing, which is the reviewer's recorded reservation. The status line's "(proposed, review pending)" for ADR-0181 is accurate:
that ADR is `proposed`. The ADR's own Decision table still lists those structures as "kept as logic", but the update and the title say that part is superseded, which is the right way to record it.
