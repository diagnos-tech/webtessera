# ADR-0173: Port the experimental mirror as `webtessera/mirror`, fixing its zero-stride hang

- **Status:** accepted
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `cmd/experimental/mirror/internal/mirror.go` and `posix/main.go` in full against `src/mirror/mirror.ts` and `retry.ts`. Declaration order, `Target`, `Source`, `Mirror` (`numWorkers`, `source`, `target`, `run`, `progress`), `jobs`, `calcNumResources`, `fetchAndParseCP`, error texts (`failed to fetch source checkpoint size: ...`, `failed to read checkpoint in target: ...`, `failed to migrate static resources: ...`), the uint64 wrap when the target is larger (no jobs, source checkpoint written), the plain errgroup (a failing worker does not stop the others) and upstream's comments are all present. Upstream has no test file (`ls` confirms). The unmodified file is identical on upstream `main` today (fetched), so "still present on upstream main" holds.
  - Differential check against real Go (scratch, nothing added to the repo): 3,000 `(source, target, workers)` cases (all boundary pairs among 0, 1, 5, 10, 254..257, 260, 511..513, 65535..65537, 65792 and 70000, times 1, 2 and 30 workers, plus random ones to 70,000 with 1 to 50 workers), comparing the multiset of tile and bundle resources `Mirror.run` writes (real `Mirror` with recording fakes) with the resources computed from a verbatim copy of upstream's `jobs()` and the real `layout.Range`. Result: 3,000 of 3,000 equal Go-with-the-one-line-fix, and equal unmodified Go on every case that terminates; 22 cases hang in unmodified Go. Every example the ADR lists hangs in Go and terminates in the port (source 10 from 0 with 30 workers, 257 from 256 and 256 from 255 with 2, 260 from 250 and 65537 from 65530 with 30), including the unaligned ones the 2026-10-04 update adds, so the widened Context is accurate and the single guarded line (divergence 2) is the whole fix.
  - retry-go: read `retry.go` and `options.go` of v4.7.0 (module cache). Defaults are 10 attempts, delay 100 ms shifted by `n-1` after incrementing `n` (so 100 ms after the first failure), plus `rand.Int63n(100ms)` jitter, no wait after the last attempt, an unrecoverable error recorded unwrapped and stopping at once, `Error.Is` matching any attempt, message `All attempts fail:\n#1: ...`; `retry.ts` reproduces all of that (and the ten waits sum to about 51 s, the ADR's "~50s" after cancellation). The port's stricter `attempts >= 1` (retry-go reads 0 as infinite) cannot matter, since the mirror uses the defaults.
  - Divergence 7 (cancellation), added in 9849188, verified against real Go: I copied the unmodified `mirror.go` (only the internal `parse` import replaced) into a scratch module and ran `Run` 20 times with one worker, a source of 16,777,216 entries and the context cancelled at the first tile read, against a target that ignores the context: 20 of 20 runs returned nil, wrote the source checkpoint and had written fewer resources than `Progress()` reports (run 0 wrote 131,328 of 131,330 resources, the ADR's figures exactly: the level 0 and 1 jobs done, levels 2 and 3 never sent). `mirror.ts` checks the signal before each job (even when none is left), so a cancelled run rejects with `failed to migrate static resources: <reason>` and never writes the checkpoint; `mirror_test.ts` `never writes the checkpoint once its signal is aborted` pins it. The shared generator replacing the channel is ADR-0077's decision; the divergence is correctly recorded here as well as in the Port note.
  - Challenge, not a blocker: the module is named after Tessera's experimental mirror (a copy tool). It is unrelated to C2SP tlog-mirror, in which a mirror cosigns checkpoints; neither this ADR nor 0175 or 0176 says so, and `newVerifiedMirror` does not cosign. A sentence in 0173's Context would prevent a reader assuming otherwise.
  - Alternatives (port the bug, clamp workers to the delta) are real and the rejections hold. Status: proposed becomes accepted.

## Update (2026-10-03)

`retry` (`src/mirror/retry.ts`) throws a `RangeError` for an `attempts` that is not a positive safe integer,
or a delay that is not a finite, non-negative number: a NaN count was never reached, and retried forever.
retry-go's defaults, which `Mirror` uses, are unaffected. See
[ADR-0212](0212-http-request-targets-limits-and-error-bodies.md). `Mirror` itself is unchanged; the verified
mirror's per-run state is ADR-0176's update.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. `retry.ts` throws `RangeError` for `attempts` that is not a positive safe integer and for non-finite or negative delays (`mirror_test.ts`); `Mirror` is unchanged; the verified mirror's per-run state is in ADR-0176.*

## Update (2026-10-04)

- The Context described the zero-stride hang as happening "from a tile-aligned target size". It happens
  whenever `jobs()` reaches an aligned `from` below the level's extent with a stride of 0, which an
  unaligned target size reaches too; the Context now says so, and `mirror_test.ts` adds the three
  unaligned cases above. The fix (divergence 2) is unchanged: on 2,895 `(source, target, workers)` cases
  the port equals upstream with that one line added, and equals unmodified upstream on every case that
  does not hang.
- Divergence 7 (cancellation) was a Port note citing ADR-0077 only; it is recorded here now.
- `jobString` now carries the `@internal` tag this ADR said it had.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. Reviewed in full, including divergence 7 and the widened Context added in 9849188. The widened zero-stride Context is correct (verified above on 6 explicit cases and 3,000 differential cases). The "2,895 cases" figure is not reproducible from the repository (I used my own 3,000), but the claim it supports holds on mine. Divergence 7 is correct as verified above, and `jobString` carries `@internal` in the code. `mirror_test.ts` adds the three unaligned cases (250 to 260 with 30 workers, 255 to 256 and 256 to 257 with 2), which all finish and pass fsck.*

## Update (2026-10-04)

`webtessera/mirror` is a port of Tessera's experimental mirror, a copy tool. It is unrelated to C2SP tlog-mirror, in
which a mirror cosigns the checkpoints it serves. Neither `newMirror` nor `newVerifiedMirror` cosigns anything or
implements that protocol.
