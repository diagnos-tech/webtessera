# ADR-0134: `internal/otel/cast.go` and `storage/internal/otel.go` are not ported

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `internal/otel/cast.go`, `storage/internal/otel.go`

## Context

Every other OpenTelemetry file in Tessera already has a decision recording that it is not ported: the root
`otel.go` ([ADR-0080](0080-append-lifecycle-otel-and-klog.md)), `client/otel.go`
([ADR-0061](0061-otel-tracing-dropped.md)) and `internal/witness/otel.go`
([ADR-0070](0070-witness-and-migrate-drop-otel-and-klog.md)), with the `storage/internal` call sites dropped by
[ADR-0051](0051-storage-internal-drops-otel-and-klog.md). Two files were left as "not started" in
`docs/PORTING-MAP.md`. Both were read in full to check that they are only instrumentation plumbing.

`internal/otel/cast.go` is one function:

```go
// Clamp64 casts a uint64 to an int64, clamping it at MaxInt64 if the value is above.
//
// Intended only for converting Tessera uint64 internal values to int64 for use with
// open telemetry metrics.
func Clamp64(u uint64) int64 {
	if u > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(u)
}
```

It is called on 18 lines, and every one is an argument to an OpenTelemetry call: `span.SetAttributes(...)` in
`client/client.go`, `storage/internal/integrate.go`, `storage/gcp/gcp.go` and `storage/posix/antispam/badger.go`,
and `.Record(...)` on a metric in `append_lifecycle.go`. Nothing outside instrumentation calls it.

`storage/internal/otel.go` declares a tracer and five attribute keys, and nothing else:

```go
const name = "github.com/transparency-dev/tessera/storage"

var tracer = otel.Tracer(name)

var (
	fromSizeKey   = attribute.Key("tessera.fromSize")
	numEntriesKey = attribute.Key("tessera.numEntries")
	treeSizeKey   = attribute.Key("tessera.treeSize")
	indexKey      = attribute.Key("tessera.index")
	levelKey      = attribute.Key("tessera.level")
)
```

Its only consumers are the four spans in `integrate.go` and `queue.go` (the drivers each carry their own
`otel.go`), which are the spans ADR-0051 already removed.

## Decision

Neither file is ported. There is no `src/internal/otel/` directory and no `src/storage/internal/otel.ts`.

`Clamp64` is not needed by anything that remains. Its purpose is to make a `uint64` fit OpenTelemetry's
`int64` metric type, and every caller is gone. The port represents `uint64` as `bigint`
([ADR-0003](0003-uint64-as-bigint.md)), which cannot overflow, so no clamping appears anywhere else in the code
either. A port of the function would be unused code.

The tracer and attribute keys of `storage/internal/otel.go` have no consumer in TypeScript, since
`integrate.ts` and `queue.ts` carry no spans.

## Consequences

- The `docs/PORTING-MAP.md` rows for both files change from `not started` to `not ported`, citing this ADR.
  With them, every OpenTelemetry file in the upstream tree that falls inside this port's scope has a recorded
  decision: root `otel.go`, `client/otel.go`, `internal/witness/otel.go`, `storage/internal/otel.go` and
  `internal/otel/cast.go`. (The cloud-driver and `cmd/` `otel.go` files belong to modules this port does not
  include, [ADR-0001](0001-scope-and-module-inclusion.md).)
- If instrumentation is ever added, `Clamp64` should not be restored as it is. The OpenTelemetry JavaScript API
  takes `number`, which is an IEEE double, so the question there is how to convert a `bigint` size
  into a safe integer, not how to fit one into 63 bits. That design belongs in the ADR that introduces
  an OpenTelemetry dependency, which [PORTING.md](../../PORTING.md) section 7 requires anyway.
- A reviewer diffing the file lists will find no `otel` file under `src/internal/` or `src/storage/internal/`,
  and this ADR is where to learn why.

## Alternatives considered

- **Port `Clamp64` over `bigint` as `src/internal/otel/cast.ts`, for later.** Rejected: it would be dead code
  with a test but no caller, and it bakes in an `int64` target that the JavaScript OpenTelemetry API does not
  have. ADR-0051 rejected the same kind of compiling placeholder.
- **Port `storage/internal/otel.go` as a module of constants for the attribute names.** Rejected for the same
  reason: constants with no consumer. They are also trivial to add back next to the spans that would use them.
- **Port both behind a no-op tracer interface so the call sites could be kept.** Rejected in ADR-0051 and ADR-0080
  already, and nothing here changes the reasoning.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `internal/otel/cast.go` and `storage/internal/otel.go`. `Clamp64` is called on exactly 18 lines
    (`append_lifecycle.go` x7, `storage/gcp/gcp.go` x2, `storage/posix/antispam/badger.go` x1, `storage/internal/integrate.go`
    x2, `client/client.go` x6), every one an argument to `span.SetAttributes` or a metric `.Record`. `storage/internal/otel.go`
    is a tracer plus five attribute keys, consumed only by the four spans (`integrate.go` x3, `queue.go` x1). There is no
    `src/internal/otel/` and no `src/storage/internal/otel.ts`, and the PORTING-MAP rows for both read `not ported` citing
    this ADR. ADR-0051, 0061, 0070 and 0080 exist and record the other files named.
  - The reasoning against porting `Clamp64` over `bigint` is sound (an int64 target that JavaScript's OpenTelemetry API does
    not have). Not blocking: the closing sentence lists five `otel.go` files as "every OpenTelemetry file ... inside this port's
    scope", which omits `storage/posix/otel.go` (decided in ADR-0100) and `storage/posix/antispam/otel.go` (decided in ADR-0141).
    Each does have a recorded decision, so nothing is false, but the list is not the whole set.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
