# ADR-0173: Port the experimental mirror as `webtessera/mirror`, fixing its zero-stride hang

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** http/witness/mirror contributor
- **Upstream reference:** `cmd/experimental/mirror/internal/mirror.go`, `cmd/experimental/mirror/posix/main.go`, `github.com/avast/retry-go/v4@v4.7.0` (`retry.go`, `options.go`)

## Context

Upstream's mirror copies a tlog-tiles log from a `Source` (a client fetcher) to a `Target`, in
parallel, checkpoint last. It lives in an `internal` package of one POSIX command. It has no test file.

Reading it closely shows a bug, still present on upstream `main`: `stride := delta / NumWorkers` is
only rounded *up* to a tile multiple when non-zero, so when the source is fewer entries ahead than there
are workers, `stride` is 0, and from a tile-aligned target size `jobs()` yields `{N: 0}` forever
(`calcNumResources` never returns). Reproduced with a verbatim copy of `jobs()` in Go: source 10,
target 0, 30 workers (the CLI default) loops. Incremental mirroring of a slowly growing log hits this.

## Decision

`src/mirror/mirror.ts` ports the file in Go order with its comments: `Target`, `Source`, `Mirror`
(`numWorkers`, `source`, `target`, `run(signal)`, `progress()`), `jobs`, `calcNumResources`,
`fetchAndParseCP`, with the usual mappings (uint64 → bigint, ctx → trailing signal, multi-value return →
`MirrorProgress`, ADR-0031; channel + producer goroutine → shared generator, ADR-0077; plain
`errgroup.Group` → `ErrGroup` whose workers do not stop each other, as upstream). Divergences:

1. **Location:** `src/mirror/` instead of `src/cmd/experimental/mirror/internal/`, because it is a
   public library here (exports map `./mirror`).
2. **Zero stride:** after the rounding, a stride of 0 becomes one tile width (what the rounding yields
   for any other small delta). A test with 5 entries and 30 workers hangs without it.
3. **retry-go:** `src/mirror/retry.ts` reimplements `retry.Do`'s defaults (10 attempts; delay
   `100ms << (n-1)` plus up to 100ms jitter; error "All attempts fail:\n#1: ..." whose `is` matches any
   attempt; `Unrecoverable`/`IsRecoverable`), like ADR-0073 did for `cenkalti/backoff`. Upstream does
   not pass ctx to `retry.Do`, so after cancellation each failing copy still sleeps ~50s; the signal
   aborts those waits here.
4. **Logging** (`log.Printf`) dropped as klog is elsewhere (ADR-0051); `progress()` stays.
5. **`numWorkers`** defaults to 30 (upstream's `--num_workers` default) and must be a positive integer;
   Go's zero value would panic dividing by zero.
6. Kept on purpose: the uint64 wrap when the target is larger than the source (no work, then the source
   checkpoint is written), and copying without verification. Both are addressed outside the port, by
   `newVerifiedMirror` (ADR-0176).

## Consequences

- Upstream should get an issue/PR for the zero-stride hang (lead's call); until then the port diverges
  in one guarded line, recorded here and in a Port note.
- `jobs`/`calcNumResources`/`jobString` are exported `@internal` for tests (ADR-0010).

## Alternatives considered

- **Port the bug faithfully.** Rejected: a library that hangs on ordinary input is not shippable, and the
  fix does not change any non-hanging behaviour.
- **Clamp `numWorkers` to `delta`.** Rejected: changes the work split for every small delta; the
  one-tile stride is what upstream already produces when delta ≥ numWorkers.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
