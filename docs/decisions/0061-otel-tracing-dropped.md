# ADR-0061: OpenTelemetry tracing dropped from client/client.go and client/stream.go

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** client agent
- **Upstream reference:** `client/otel.go`, `client/client.go`, `client/stream.go`

## Context

Every exported function in `client/client.go` and `client/stream.go` opens an
OpenTelemetry span and, in several cases, sets attributes on it:

```go
func FetchRangeNodes(ctx context.Context, s uint64, f TileFetcherFunc) ([][]byte, error) {
	ctx, span := tracer.Start(ctx, "tessera.client.FetchRangeNodes")
	defer span.End()
	span.SetAttributes(logSizeKey.Int64(otel.Clamp64(s)))
	...
}
```

`tracer`, and the attribute keys (`firstKey`, `NKey`, `logSizeKey`, `indexKey`,
`levelKey`, `smallerKey`, `largerKey`), are defined in `client/otel.go`, which imports the
real `go.opentelemetry.io/otel` SDK:

```go
import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)
var tracer = otel.Tracer(name)
```

`client/otel.go` is **not** one of the five files this work package is scoped to port
(the original work plan's Wave 2 client row lists `client/{client,fetcher,stream}.go`
and `internal/{future,fetcher}`, not `client/otel.go`). `AGENTS.md` §7 also caps
donatable-code dependencies at `@noble/hashes` and `@noble/curves`, "and nothing else",
with the bar for adding anything else being "there is no other way" — a real OpenTelemetry
JS SDK dependency does not clear that bar for a package whose job is proof verification,
not observability.

`internal/otel/cast.go` (the `Clamp64` helper `SetAttributes` calls) is a separate,
dependency-free file already scoped as in-scope-to-port per
`docs/decisions/0001-scope-and-module-inclusion.md`'s table, but it exists solely to
support the very same span attributes this ADR drops, so there is nothing left in this
work package that would call it.

## Decision

Every `tracer.Start`/`span.SetAttributes`/`defer span.End()` call in `client.go` and
`stream.go` is dropped from the port, with no replacement. The `ctx` returned from
`tracer.Start(ctx, ...)` in Go is otherwise just the same `ctx` passed through unchanged
(OpenTelemetry stores the span in a derived context so a nested call can find its parent
span), so dropping the span wrapper changes nothing about how `signal`/`AbortSignal`
propagates through the port — every place Go re-assigns `ctx` from `tracer.Start` is
simply the original `signal` parameter, used as-is, in the corresponding TypeScript.

`client/otel.go` itself is not ported.

## Consequences

- No tracing/observability surface exists in this package. A future package (or a Wave 3
  agent porting the root `otel.go`, which **is** in scope per ADR-0001's table) can add it
  back with its own ADR once there is an actual accepted OpenTelemetry-for-JS dependency
  decision; this ADR does not foreclose that, it just declines to make that call from
  inside the client work package.
- Every dropped span name (`"tessera.client.FetchRangeNodes"`,
  `"tessera.client.logstatetracker.Update"`, `"tessera.storage.StreamAdaptor"`, etc.) and
  attribute key is absent from the TypeScript source. A transparency-dev reviewer
  diffing exported symbols will not find `otel.ts` under `src/client/` and needs this ADR
  to know why, alongside the `docs/decisions/0001` row.
- Purely additive to restore: nothing about proof verification, consistency checking, or
  fetch behaviour depends on tracing, so this is safe to revisit independently.

## Alternatives considered

- **Port `client/otel.go` too, even though it is out of scope, to keep the calls intact.**
  Rejected: it would add a real OpenTelemetry JS dependency without the "there is no
  other way" justification AGENTS.md §7 requires, and it is explicitly not assigned to
  this work package.
- **Replace spans with `console.log`-based tracing.** Rejected twice over:
  `console.log` is explicitly banned by AGENTS.md's definition of done, and inventing a
  logging mechanism upstream does not have is exactly the kind of addition
  `docs/decisions/0000-template.md` requires an ADR for on its own, which would just move
  the problem rather than solve it.
- **A no-op tracer interface (`tracer.start()` that does nothing) to keep the call sites
  textually identical to Go.** Rejected: it is invented API surface with no upstream
  counterpart, purely to make a diff look smaller, and every no-op call site would still
  need `span.setAttributes` stubs that do nothing either — more code for zero behaviour.

## Review

- **Reviewer:** Client Reviewer (Opus 4.8)
- **Verdict:** approved
- **Notes:** Confirmed against `client/otel.go`, `client/client.go`, and `client/stream.go` that
  every dropped construct is purely observability: `tracer.Start` returns a span-carrying `ctx`
  that is otherwise the same `ctx`, and `span.SetAttributes`/`span.End` have no effect on returned
  values or control flow. Walked each Go function and confirmed the port carries over the real
  logic with `signal` used exactly where Go re-used the `tracer.Start`-derived `ctx`, so nothing
  functional was lost with the spans. `client/otel.go` is correctly out of scope per the original work plan's
  Wave 2, and adding an OpenTelemetry-JS dependency would violate AGENTS.md §7. Agree tracing is
  purely additive to restore later.
