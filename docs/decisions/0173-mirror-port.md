# ADR-0173: Port the experimental mirror as `webtessera/mirror`, fixing its zero-stride hang

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** http/witness/mirror agent
- **Upstream reference:** `cmd/experimental/mirror/internal/mirror.go`, `cmd/experimental/mirror/posix/main.go`, `github.com/avast/retry-go/v4@v4.7.0` (`retry.go`, `options.go`)

## Context

Upstream's mirror copies a tlog-tiles log from a `Source` (a client fetcher) to a `Target`, in
parallel, checkpoint last. It lives in an `internal` package of one POSIX command. It has no test file.

Reading it closely shows a bug, still present on upstream `main`: `stride := delta / NumWorkers` is
only rounded *up* to a tile multiple when non-zero, so when the source is fewer entries ahead than there
are workers, `stride` is 0. `jobs()` then yields `{N: 0}` forever as soon as its iteration reaches a
tile-aligned `from` below the level's extent, at any level, and `calcNumResources` never returns. That
happens whatever the target size: from an aligned one straight away (source 10, target 0, 30 workers, the
CLI default; source 257, target 256, 2 workers), after the first, partial job ends on a tile boundary
(source 260, target 250, 30 workers; 65537 from 65530), or at level 1 (source 256, target 255, 2 workers).
Reproduced in Go with a verbatim copy of `jobs()` and with the unmodified `Run`. Incremental mirroring of a
slowly growing log hits this.

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
7. **Cancellation:** upstream's workers never look at ctx. Its producer goroutine stops sending jobs once
   ctx is Done and closes the channel; the workers drain the jobs already in the channel's buffer (up to
   `NumWorkers` of them) and return nil, so `g.Wait()` returns nil and `Run` calls
   `WriteCheckpoint(ctx, sourceCP)` on the cancelled context. A target that does not itself honour ctx then
   publishes the source checkpoint over a mirror that is missing the resources of every job the producer
   never sent; with one worker and 16,777,216 entries, Go returned nil having written 131,328 of 131,330
   resources, and the checkpoint. The port's workers call `throwIfAborted(signal)` before taking each job
   (the shared generator stands in for the channel, ADR-0077), so a cancelled run rejects with
   `failed to migrate static resources: <the abort reason's message>` at the next job, after the jobs
   already started finish, and never writes the checkpoint, even when no job was left to take. Kept as
   the safe behaviour: a checkpoint must not be published for resources that were not copied.
   `mirror_test.ts` pins it ("never writes the checkpoint once its signal is aborted").

## Consequences

- Upstream should get an issue/PR for the zero-stride hang and for the checkpoint written after
  cancellation (lead's call); until then the port diverges in one guarded line and one per-job check,
  each recorded here and in a Port note.
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

## Update (2026-10-03)

`retry` (`src/mirror/retry.ts`) throws a `RangeError` for an `attempts` that is not a positive safe integer,
or a delay that is not a finite, non-negative number: a NaN count was never reached, and retried forever.
retry-go's defaults, which `Mirror` uses, are unaffected. See
[ADR-0212](0212-http-request-targets-limits-and-error-bodies.md). `Mirror` itself is unchanged; the verified
mirror's per-run state is ADR-0176's update.

## Update (2026-10-04)

- The Context described the zero-stride hang as happening "from a tile-aligned target size". It happens
  whenever `jobs()` reaches an aligned `from` below the level's extent with a stride of 0, which an
  unaligned target size reaches too; the Context now says so, and `mirror_test.ts` adds the three
  unaligned cases above. The fix (divergence 2) is unchanged: on 2,895 `(source, target, workers)` cases
  the port equals upstream with that one line added, and equals unmodified upstream on every case that
  does not hang.
- Divergence 7 (cancellation) was a Port note citing ADR-0077 only; it is recorded here now.
- `jobString` now carries the `@internal` tag this ADR said it had.
