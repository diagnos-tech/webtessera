# ADR-0106: Prove the ObjectStore driver against Go's tests, Go's logs, and one suite for every backend

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files_test.go`, `fixtures/gen/log.go`, `append_lifecycle.go`
  (`terminator.Shutdown`)

## Context

`files_test.go` has three tests: `TestGarbageCollect`, `TestGarbageCollectOption` (on, on-ct, off) and
`TestPublishTree` (eight cases). They run against a temporary directory, reach unexported members
(`s.newAppender`, `appender.publishCheckpoint`, `appender.newCP`, `s.garbageCollect`), and find partial
resources by walking the directory for `.p` subdirectories. They say nothing about byte compatibility, and
nothing about backends other than POSIX, of which this port has three, written by different people.

## Decision

Four layers of tests, each with a different job:

1. **`driver_test.ts`, the port of `files_test.go`**, with Go's case names and values (60,000-entry batches,
   a 98,304-entry target, the 1.2 s checkpoint interval, the same publish/republish timings), run against a
   `MemoryObjectStore`. A "partial directory" is a key prefix ending in a `.p` segment, found with
   `MemoryObjectStore.keys()`; the rest of each test is unchanged, including the final `fsck`. The eight
   `TestPublishTree` cases run concurrently, since each is dominated by sleeps. Driver-internal cases follow
   (version file, tree-state errors, lock naming and wrapping, fetch defaulting, partial fallback, GC's
   `d > maxBundles` limit, tile width checks, migration bounds).
2. **`json_test.ts`**, whose expected encodings and error texts were recorded from Go 1.24's
   `encoding/json` (ADR-0102).
3. **`driver_fixtures_test.ts`, the compatibility proof.** The same appends `fixtures/gen/log.go` made, run
   through `newAppender` and this driver, leave exactly the paths and bytes the Go POSIX driver left, signed
   checkpoint included (the fixture key is published and Ed25519 is deterministic), for every `log_<N>`.
   Built in batches of 37, the store holds exactly the fixture plus the superseded partials those batches
   wrote, computed independently, and after GC exactly the fixture plus the superseded partials POSIX's GC
   also keeps. Go-written logs laid out in a store with a Go-format `.state/treeState` resume and grow into the
   next fixture.
4. **`testing/driver_conformance.ts`, `describeDriverConformance(name, newStore, { reopen? })`**, run by every
   backend (memory in `memory_driver_test.ts`). It uses only vitest and library code so that it runs in Node,
   Chromium and workerd, keeps logs small and intervals at the minimum, and checks a whole log end to end:
   sequential indices, the PublicationAwaiter, checkpoint verification, inclusion and consistency proofs from
   served tiles (including against an older checkpoint's partial tiles), `ErrNotExist`, antispam dedup,
   restart, two drivers on one store, GC below the published size only, migration, and that nothing touches
   the store, and no Node timer stays pending, after shutdown and abort. `reopen` lets a backend supply a second
   handle onto the same data (a second tab, a restarted Durable Object) for the restart and shared-store
   cases.

The appenders in layer 3 wait with a PublicationAwaiter, as `fixtures/gen/log.go` does, before calling
`shutdown`: `terminator.shutdown` treats a largest issued index of 0 as "no work done" and returns at once, so
a one-entry log's first checkpoint would otherwise not be published yet. That is upstream behaviour, ported
faithfully in `append_lifecycle.ts`, and is noted where the tests depend on it.

## Consequences

- `driver_test.ts` takes about 50 s on Node, almost all of it in the four garbage-collection tests, whose run
  time is set by Go's values (two awaited publications per 60,000-entry batch at a 1.2 s interval). They run
  sequentially because `TestGarbageCollectOption` gives GC a fixed 300 ms window, which CPU contention from a
  concurrent case could make flaky.
- The fixture tests rely on batch boundaries being deterministic: entries are added synchronously, so the
  queue flushes every 37 entries. A change to the queue's flushing would show up there first.
- The conformance suite's "no pending timers" check is Node-only (`process.getActiveResourcesInfo`); in
  browsers and workerd the "no store calls after abort" check is the evidence. Mutating the driver so that its
  publishing loop ignores the abort signal, or so that sequencing skips the tree-state lock, makes the
  respective cases fail.

## Alternatives considered

- **Smaller sizes in the `files_test.go` port.** Rejected: PORTING.md asks for the same cases with the same
  values, and the large batch is what makes GC walk up to level-1 tiles.
- **Compare only the resources the final size implies.** Rejected as the only check: it cannot notice a
  driver that writes extra resources, or that GC removes too much or too little. Exact key-set equality can.
- **Separate end-to-end suites per backend.** Rejected: they would drift, and the point is that every backend
  behaves like the reference one.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
