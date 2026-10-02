# ADR-0051: `storage/internal` drops OpenTelemetry tracing and klog logging

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal agent
- **Upstream reference:** `storage/internal/integrate.go`, `storage/internal/queue.go`, `storage/internal/otel.go`

## Context

`integrate.go` and `queue.go` both instrument themselves with OpenTelemetry spans/attributes and
`k8s.io/klog/v2` debug logging:

```go
ctx, span := tracer.Start(ctx, "tessera.storage.integrate")
defer span.End()
span.SetAttributes(fromSizeKey.Int64(otel.Clamp64(fromSize)), numEntriesKey.Int(len(leafHashes)))
klog.V(1).Infof("Loaded state with roothash %x", r)
```

```go
ctx, span := tracer.Start(ctx, "tessera.storage.queue.doFlush")
defer span.End()
```

The tracer, span helpers and attribute keys (`fromSizeKey`, `numEntriesKey`, `treeSizeKey`,
`indexKey`, `levelKey`) come from `storage/internal/otel.go`, which is not part of this work
package's mission (`AGENTS.md`'s file table lists exactly six files: `tileid.go`, `integrate.go`,
`queue.go`, `entry.go`, `log.go`, `lifecycle.go`). `k8s.io/klog/v2` has no port anywhere in this
codebase either.

## Decision

Every `tracer.Start`/`span.SetAttributes`/`span.AddEvent`/`span.End()` call and every
`klog.V(...).Infof(...)` call is dropped from `src/storage/internal/integrate.ts` and
`src/storage/internal/queue.ts`. No stand-in tracer or logger is introduced.

## Consequences

- Nothing outside `otel.go`'s own file depends on the specific attribute keys or span names, so
  dropping them changes no observable behaviour any test in this package (or its golden fixtures)
  can see — tracing and debug logging are both side channels, not part of the storage contract.
- If/when `storage/internal/otel.go` is ported by whichever work package claims it, that agent
  will need to re-thread the spans through `integrate.ts`/`queue.ts`. This ADR is the record of
  where they were removed and why, so that work is a restoration, not an archaeology exercise.
- `docs/PORTING-MAP.md`'s row for `storage/internal/otel.go` stays `not started`, unchanged by
  this work package.

## Alternatives considered

- **Port `otel.go` too, even though it is out of scope.** Rejected: `AGENTS.md` §7 restricts
  donatable dependencies to `@noble/*`; adding an OpenTelemetry dependency (even a stub) is
  exactly the kind of drive-by scope expansion §6's "any dependency added to `package.json`"
  clause exists to gate through its own ADR and review, not fold into an unrelated one.
- **Add a no-op tracer interface as a placeholder.** Rejected as invention: nothing in this work
  package's test suite or the golden fixtures needs it, and a placeholder that compiles is a
  placeholder that gets built on before anyone revisits it.
- **Port klog calls as `console.debug`.** Rejected: `AGENTS.md`'s definition of done explicitly
  forbids `console.log` (and by the same reasoning, any `console.*` logging) in donatable code.

## Review

- **Reviewer:** Storage-Internal Reviewer
- **Verdict:** approved
- **Notes:** Cross-checked every `tracer.Start`/`span.*`/`klog.V(...).Infof` site in
  `integrate.go` and `queue.go` against the ports; all are pure observability side channels
  that feed no return value, error, or fixture-visible byte. Dropping them changes nothing a
  test or a golden fixture can observe, which the passing 200,000-entry `TestIntegrate` and
  the `log_<N>` fixtures confirm. Not porting `otel.go` is consistent with the six-file
  mission scope and AGENTS.md §7's dependency limit. The one `span.AddEvent(fmt.Sprintf(...))`
  inside `tileReadCache.Get` is also correctly dropped (it is not an error path).
