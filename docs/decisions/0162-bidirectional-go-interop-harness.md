# ADR-0162: Prove interoperability with Tessera in Go, both ways, with a differential harness

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** `storage/posix/files.go` (`writeTile`), `fsck/fsck.go`, `client/client.go`,
  `client/fetcher.go` (`FileFetcher`), `cmd/fsck/main.go`

## Context

The golden fixtures (ADR-0006) and the golden suite (ADR-0160) prove webtessera reproduces eight small logs built
from one fixed entry scheme in a single batch. They say nothing about logs with entries of varied sizes, grown
through many batch boundaries, past 65 536 entries (where level-2 tiles appear), or about whether Tessera's own
tools accept a log webtessera wrote and carry it on. The maintainer's requirement is byte compatibility "in both
directions", proven in CI.

## Decision

A Go module, `interop/` (with `replace github.com/transparency-dev/tessera => ../.upstream/tessera` and the
dependency versions of the pinned checkout, like `fixtures/gen`), provides two tools built on Tessera itself:

- `interop/produce` writes a log with the real POSIX driver, in batches ending exactly at given sizes, recording
  the checkpoint published after each batch (`checkpoint.<size>`, upstream's `testdata/log` convention). Given a
  directory that already holds a log, it resumes it and checks that the first new entry gets the expected index.
- `interop/verify` checks a log directory with `client.FileFetcher`, as `cmd/fsck` does for `file://`: the
  checkpoint signature; `fsck` of the whole tree; every entry against the corpus, with each bundle holding exactly
  the entries the tree size implies (which `fsck` alone does not check); inclusion proofs for boundary and seeded
  random entries, and for the first and last entry of every historical tree; consistency proofs from every
  recorded checkpoint.

Both sides derive entries from one seeded corpus, specified in `interop/internal/entries` and mirrored in
`scripts/interop/entries.mjs`, pinned by a shared digest. `scripts/interop.mjs` (`pnpm interop`) runs, for each
Node backend in `scripts/interop/backends.mjs`, against the built `dist/`:

- **ts -> go**: webtessera writes phase 1; Go verifies the exported store; it must be byte-identical (every file,
  `.state/treeState` and `.state/version` included, lock files aside) to the log Go writes for the same batch plan,
  with every signed checkpoint identical; Go's POSIX driver then carries it on through phase 2, and the result is
  verified and compared again.
- **go -> ts**: Go writes phase 1; the directory, `.state/` included, is loaded into the backend; webtessera's
  client and fsck verify it; webtessera carries it on through phase 2; Go verifies the result, including
  consistency from Go's checkpoints to webtessera's, and it must be byte-identical to Go's log for the whole plan.

Defaults: seed 1, phase 1 to 65 000 entries (partial resources at levels 0 and 1), phase 2 to 70 000 (crossing
65 536). Batch plans hit every landmark size either side of the bundle, tile and level-2 boundaries.

### The upstream finding the exact comparison depends on

posix's `writeTile` intends to replace superseded partial tiles with symlinks to the full tile (the relinking
ADR-0101 declines to port), but both its glob and its symlink use `tPath`, which is relative to the log root,
as if it were relative to the process's working directory:

```go
partials, err := filepath.Glob(fmt.Sprintf("%s.p/*", tPath))   // tPath = "tile/0/000", not joined with cfg.Path
...
tmp := fmt.Sprintf("%s.link", tPath)
if err := os.Symlink(tPath, tmp); err != nil {
```

Observed at the pinned commit with `interop/produce -ends 1,255,256,300`: run from outside the log directory, the
glob matches nothing and `tile/0/000.p/1` and `.p/255` stay regular files with their partial contents; run from
inside it, they become symlinks to `tile/0/000`, a target resolved relative to the link's own directory, so they
dangle and readers fall back to the full tile. In the normal deployment (a storage path that is not the working
directory) Tessera therefore keeps superseded partial tiles exactly as ObjectStore backends do. The harness runs
Go from its working directory, never from a log directory, and fails with an explanation if it meets a symlink.
This is worth reporting upstream; ADR-0101's description of what POSIX does on disk should be read with it.

## Consequences

- `pnpm interop` takes about 90 seconds for its four backends (memory, IndexedDB on fake-indexeddb, SQLite through
  node:sqlite and through libSQL), plus a one-off Go module download. The CI job that runs
  it already exists in `_compat.yml`; the script also runs `go test ./...` in `interop/`, checks out upstream and
  builds `dist/` itself, idempotently.
- Adding a backend that runs in Node is one entry in `backends.mjs`. Exporting never needs a listing operation:
  the harness records every key it writes.
- Batch boundaries are deterministic on the TypeScript side by construction (entries are added synchronously).
  On the Go side they depend on adding a batch (at most 4 096 prebuilt entries) inside the 100 ms batch age, which
  takes a few milliseconds; a split batch would show up as a file-set difference, never as a silent pass.
- Garbage collection is off on both sides, so `gcState` and GC's deletions are not compared here; the golden suite
  covers GC against the fixtures.

## Alternatives considered

- **Verify only, without the byte comparison.** Rejected: `fsck` and proofs accept many logs that are not what
  Tessera writes (a different set of partials, extra entries in a partial bundle).
- **Compare only against fixtures.** Rejected: fixtures are small, single-batch, fixed-size entries, and cannot
  include logs webtessera wrote first.
- **Ship the entries from one side to the other** instead of a shared corpus. Rejected: a list hides which side
  produced a wrong entry, and the corpus lets `verify` check content from the seed alone.
- **Tolerate symlinked partial tiles in the comparison.** Rejected: with Go run correctly there are none, and a
  tolerance would only hide the day that changes.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
