# ADR-0054: `append_lifecycle.ts` lands early, carrying only `AddFn`/`IndexFuture`/`Index`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal agent
- **Upstream reference:** `append_lifecycle.go:212-226`

## Context

`storage/internal/queue.go` and `lifecycle.go`'s `Antispam` interface both use three small types
that Go declares in `append_lifecycle.go`:

```go
type AddFn func(ctx context.Context, entry *Entry) IndexFuture
type IndexFuture func() (Index, error)
type Index struct {
	Index uint64
	IsDup bool
}
```

`append_lifecycle.go` as a whole (850 lines: OpenTelemetry metric setup, `Appender`,
`NewAppender`, `AppendOptions` and its functional options, `terminator`, `integrationStats`, …)
belongs to the Wave 3 append-lifecycle work package
(in the original work plan), which does not exist yet. But `queue.go` and `lifecycle.go` are
squarely in *this* work package's mission, and neither can compile without `Index`/`IndexFuture`
(`queue.go`'s `Add` returns one, `notify` constructs one) or `AddFn` (`lifecycle.go`'s `Antispam`
interface names it in `Decorator() func(AddFn) AddFn`).

This is not a new problem in this codebase: `ct_only.go` hit the identical situation with
`Appender`/`IndexFuture`/`AppendOptions`/the root `Entry`, and `docs/decisions/0044-ct-only-partial-port.md`
resolved it by porting the self-contained two-thirds of the file and leaving the
append-lifecycle-dependent third as `TODO(<owner>):` comments naming the exact upstream symbol,
line, and future file — no placeholder types, no stub interfaces.

## Decision

`src/append_lifecycle.ts` is created now, containing exactly the three declarations above, in the
position they occupy in the Go file (immediately after the OpenTelemetry metric `init()` block,
which is dropped per the same reasoning as
`docs/decisions/0051-storage-internal-drops-otel-and-klog.md`, and immediately before `Appender`,
which is not ported). A `TODO(<owner>):` block at the top of the file names everything else in
`append_lifecycle.go` that Wave 3 still owns: the metric setup, `Appender`, `NewAppender`,
`memoizeFuture`, `followerStats`, `idxAt`, `integrationStats`, `terminator`,
`NewAppendOptions`/`AppendOptions` and its functional options, `WitnessOptions`.

`AddFn`'s `ctx context.Context` parameter moves to a trailing optional `signal`, and it takes
`Entry` (this work package's own `src/entry.ts`) as a type-only import — `AddFn`'s only use of
`Entry` is as a parameter type, never a constructed value, so the import is `import type`, which
TypeScript erases entirely at compile time. `IndexFuture`'s `func() (Index, error)` becomes
`() => Promise<Index>` that throws instead of returning the error half of the tuple
(`docs/decisions/0004-errors-context-and-concurrency.md`), and "will block when called" becomes
"the caller awaits the returned Promise" — the same substitution `src/internal/future/future.ts`
makes (`docs/decisions/0056-future-ported-ahead-of-schedule.md`). `Index` is a plain readonly
interface, matching `RangeInfo`'s treatment as a genuine (non-multi-return-synthesised) Go struct.

`docs/PORTING-MAP.md`'s row for `append_lifecycle.go` moves from `not started` to `in progress`,
naming this ADR, mirroring exactly how `ct_only.go`'s row reads today.

## Consequences

- `docs/PORTING-MAP.md` must not mark `append_lifecycle.go`/`append_lifecycle_test.ts` `done`
  until Wave 3 lands the rest. The Wave 3 agent inherits one job this ADR creates: when porting
  the remainder of the file, keep `AddFn`/`IndexFuture`/`Index` exactly where they already are
  (same names, same shapes) rather than re-deriving them, and port `append_lifecycle_test.go`
  against the combined file.
- No fake/placeholder type stands in for `Appender`, `AppendOptions`, or anything else `AddFn`'s
  *implementations* (not `AddFn` itself) will eventually need — those simply do not exist yet in
  this codebase, exactly as ADR-0044 insists for the equivalent situation in `ct_only.ts`.
- This is the second work package in a row to hit this exact cross-wave dependency shape
  (`ct_only.ts`, now `queue.ts`/`lifecycle.ts`), which is a signal — noted here for whoever plans
  Wave 3 — that `AddFn`/`IndexFuture`/`Index` are load-bearing enough to arguably deserve landing
  before the rest of `append_lifecycle.go` regardless of which agent claims that package first;
  this ADR does not resolve that planning question, only documents the immediate necessity.

## Alternatives considered

- **Stub `Appender`/`AppendOptions` so the whole file could compile at once.** Rejected, for the
  same reason ADR-0044 rejects it: a stub that compiles is a stub that gets built on, and this
  work package has no authority to guess at `Appender`'s real shape.
- **Put `AddFn`/`IndexFuture`/`Index` in `queue.ts` or `lifecycle.ts` instead, deferring their
  move to `append_lifecycle.ts` until Wave 3.** Rejected: `docs/decisions/0002-file-and-identifier-naming.md`
  mirrors upstream file paths exactly *because* it is this port's main reviewability asset: a
  transparency-dev reviewer who knows `append_lifecycle.go` defines `Index` should find it in
  `append_lifecycle.ts`, not have to know it briefly lived somewhere else mid-port.
- **Wait for Wave 3 and leave `queue.go`/`lifecycle.go` unported in the meantime.** Rejected:
  both are explicitly this work package's mission per `AGENTS.md`, and `storage/internal/queue.go`
  is the actual, real logic this package exists to deliver — deferring it would mean reporting the
  assignment incomplete for a dependency that is three declarations long and easy to isolate.

## Review

- **Reviewer:** Storage-Internal Reviewer
- **Verdict:** approved
- **Notes:** Confirmed `append_lifecycle.ts` ports exactly `AddFn`, `IndexFuture`, and
  `Index` (with `index`/`isDup`) and nothing else, in the Go declaration position, matching
  the `append_lifecycle.go` shapes. The `TODO(<owner>):` block enumerates every deferred
  symbol; no placeholder/stub `Appender` was invented, consistent with the ADR-0044
  precedent. `AddFn`'s `ctx`→trailing `signal` and `import type { Entry }` (erased) are both
  correct. This is a genuinely minimal partial port and does not overreach — the queue and
  the `Antispam` interface are the only consumers, and both compile against exactly these
  three declarations.
