# ADR-0161: Record the POSIX driver's `.state/` files in the log fixtures

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** `storage/posix/files.go` (`ensureVersion`, `writeTreeState`, `lockFile`)

## Context

`fixtures/gen/log.go` skipped the log directory's `.state/` when dumping it: "not part of the tlog-tiles surface
a client sees and not something the port has to reproduce". The second half stopped being true once the port
claimed that a store and a POSIX log directory can be exchanged in both directions (ADR-0102): then `.state/`
is exactly what the port must reproduce, and read. The previous resumption test laid a Go log out in a store with
a `.state/treeState` the test assembled itself from the checkpoint hash, in the format the test author believed
Go writes. That is an assertion, not evidence; AGENTS.md §5 asks for the latter.

## Decision

`log.go` records every regular file in `.state/`, apart from the `*.lock` files, as a new `state` array of
`{ path, raw }` in each `log_<N>.json`, sorted by name. The lock files are left out because they are empty
`flock(2)` targets that carry no state, and an `ObjectStore` has no counterpart for them (`ObjectStore.lock` is
not backed by objects). With garbage collection disabled, as the fixtures run, that is `.state/treeState` and
`.state/version`.

The golden suite (ADR-0160) now asserts that a store's `.state/` holds exactly those files with exactly those
bytes, and preloads them, as Go wrote them, when it resumes a Go log.

## Consequences

- Eight fixture files gain a `state` field; nothing else in them changes, and regenerating twice is
  byte-identical. `fixtures/README.md`'s table says so.
- The format of `.state/treeState` is now pinned by Go's own output for eight tree sizes, on top of the
  `encoding/json` vectors in `json_test.ts`.
- `gcState` is not covered by the fixtures (GC is off in them); `json_test.ts` remains its evidence, and the
  interop harness (ADR-0162) never runs GC either.

## Alternatives considered

- **Keep synthesising `treeState` in the test.** Rejected: it proves only that the test and the driver agree.
- **Record the lock files too.** Rejected: they are empty, every store would have to fake them, and a store that
  did would gain keys no client or driver reads.
- **A separate fixture file for state.** Rejected: the state belongs to one log, and splitting it invites
  pairing the wrong two files.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
