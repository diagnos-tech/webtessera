# ADR-0070: `witness`/`migrate` packages drop OpenTelemetry metrics and klog logging

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate agent
- **Upstream reference:** `internal/witness/witness.go`, `internal/witness/otel.go`, `migrate.go`, `migrate_lifecycle.go`

## Context

Every file in this work package instruments itself with either OpenTelemetry or `k8s.io/klog/v2`,
neither of which is on `AGENTS.md` §7's dependency allow-list (`@noble/hashes`, `@noble/curves`,
nothing else):

- `internal/witness/otel.go` declares a `metric.Meter`, three metrics
  (`witnessReqsTotal`/`witnessReqHistogram`/`witnessRespsTotal`) and two attribute keys
  (`witnessNameKey`/`witnessStatusKey`). `internal/witness/witness.go`'s `init()` constructs those
  metrics and its `witness.update` method records to them around every HTTP call:

  ```go
  witnessReqsTotal.Add(ctx, 1, metric.WithAttributes(nameAttr))
  ...
  witnessRespsTotal.Add(ctx, 1, metric.WithAttributes(nameAttr, statusAttr))
  witnessReqHistogram.Record(ctx, d.Milliseconds(), metric.WithAttributes(nameAttr, statusAttr))
  ```

  and logs a retry with `klog.Infof("Witness at %q replied with x.tlog.size %d != our hint %d, retrying", ...)`.

- `migrate.go`'s `copier.Copy`/`populateWork`/`worker` and `migrate_lifecycle.go`'s
  `MigrationTarget.Migrate`/`awaitFollower` call `klog.Infof`/`klog.Warningf` at nearly every step
  (`"Starting copy from %d to source size %d"`, `"Spans for entry range [%d, %d)"`, retry messages,
  a once-a-second `"Progress: %s"` line built entirely to be logged, and `"Migration successful."`).

This is the third work package to hit exactly this situation — `storage/internal` (ADR-0051) and
`client` (ADR-0061) already established that OTel/klog are out of scope and get dropped outright,
not stubbed.

## Decision

Following ADR-0051's precedent directly:

- `internal/witness/otel.go` is **not ported**. No file exists at `src/internal/witness/otel.ts`.
- Every `metric.Meter`/`.Add`/`.Record`/`metric.WithAttributes` call site in
  `src/internal/witness/witness.ts` is dropped; no stand-in metrics object is introduced.
- Every `klog.Infof`/`klog.Warningf` call site in `src/internal/witness/witness.ts`, `src/witness.ts`,
  `src/migrate.ts` and `src/migrate_lifecycle.ts` is dropped.
- `migrate_lifecycle.go`'s background "Progress: ..." goroutine inside `Migrate` is dropped in its
  entirety, not just its `klog.Infof` call, because printing was its *only* effect — see
  `src/migrate_lifecycle.ts`'s own header comment and ADR-0074 for why `progress()` itself is still
  ported and tested even though nothing calls it from this file.

## Consequences

- No file in this work package depends on `go.opentelemetry.io/otel` or `k8s.io/klog/v2`, so
  `package.json`'s dependency list needs no addition here either.
- A production deployment loses request-count/latency histograms for witness cosigning traffic and
  copy/integration progress logging. Neither is behaviour a test or golden fixture in this codebase
  observes, and `AGENTS.md` §7's dependency bar ("there is no other way") was not met for either — a
  real OTel SDK is heavyweight and klog assumes a Node/server logging story this port does not have.
- `docs/PORTING-MAP.md`'s row for `internal/witness/otel.go` reads `not ported`, naming this ADR.

## Alternatives considered

- **Stub metrics/logging with no-op implementations**, preserving the call sites' shape. Rejected:
  dead call sites that always no-op are exactly the kind of code `AGENTS.md`'s "no invention" rule
  argues against; ADR-0051 rejected the same option for the same reason.
- **Write to `console.log` instead of klog.** Rejected outright: `AGENTS.md`'s Definition of Done
  explicitly forbids `console.log` in this codebase.
- **Port a minimal event-emitter hook so application code could wire in real observability later.**
  Rejected as invented API surface upstream does not have; application code can add its own
  instrumentation around these functions without this package needing to anticipate it.

## Review

- **Reviewer:** Witness/Migrate Reviewer (agent)
- **Verdict:** approved
- **Notes:** Checked against `internal/witness/witness.go` (the `var`/`init()` metric block,
  the `witnessReqsTotal.Add`/`witnessRespsTotal.Add`/`witnessReqHistogram.Record` call sites
  in `update`, and the `klog.Infof` retry line) and against `migrate.go`/`migrate_lifecycle.go`'s
  `klog` calls: every one is genuinely absent from the ports, and no stand-in metrics/logging
  object was introduced (grepped `src/internal/witness/witness.ts`, `src/witness.ts`,
  `src/migrate.ts`, `src/migrate_lifecycle.ts` for `otel`/`klog`/`console` — none). No file at
  `src/internal/witness/otel.ts`. The `migrate_lifecycle.go` "Progress: ..." goroutine is dropped
  in full (its only effect was the dropped `klog.Infof`); `progress()` itself is still ported and
  tested, correctly. Same precedent as ADR-0051/0061, applied identically. Dependency list gains
  nothing. Confirmed no observable behaviour a test or fixture checks is lost.

## Update (2026-10-02)

The Decision's last bullet says `progress()` "is still ported and tested". It no longer is: its
only upstream caller is the dropped "Progress: ..." goroutine, so ADR-0181 deletes it along with
the other code whose only effect was to feed dropped metrics or logs.
