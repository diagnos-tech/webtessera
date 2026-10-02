# Compatibility with Tessera

webtessera claims that a log it writes, on any of its storage backends, is **byte for byte** the log Tessera's
own POSIX driver writes for the same entries, and that each side can carry on a log the other started. This page
explains how that claim is proven, what exactly is compared, and how to reproduce every check on your machine.
The Go code the claim refers to is Tessera at the commit pinned in [`scripts/upstream.json`](../scripts/upstream.json).

## The evidence, in four layers

| Layer | What it proves | Where |
| --- | --- | --- |
| Golden fixtures | Outputs recorded from real Tessera: paths, tiles, bundles, proofs, notes, checkpoints, and complete logs with their `.state/` files. Regenerating them leaves `fixtures/data` unchanged. | [`fixtures/`](../fixtures/README.md), ADR-0006, ADR-0161 |
| Component tests | Each ported package reproduces its fixtures byte for byte. | `src/**/*_fixtures_test.ts` and the Go-mirrored tests |
| Golden suite, per backend | Every backend, in every runtime it supports, stores exactly the files Tessera's POSIX driver stores for the fixture logs, and carries on logs Go wrote. | [`golden.ts`](../src/storage/objectstore/testing/golden.ts), ADR-0160 |
| Go interop harness | Tessera's own Go code verifies logs webtessera wrote on each Node backend, reproduces them byte for byte, and carries them on; webtessera does the same with logs Go wrote. | [`interop/`](../interop), [`scripts/interop.mjs`](../scripts/interop.mjs), ADR-0162 |

### Golden suite

`describeGoldenCompatibility(name, newStore, options)` runs, against fresh stores of one backend, every
`fixtures/data/log_<N>.json` (N = 0, 1, 2, 255, 256, 257, 1000, 5000):

1. **One batch** of N entries leaves exactly Go's files: the same set of paths and the same bytes for every tile,
   entry bundle and the signed checkpoint, plus Go's `.state/treeState` and `.state/version`.
2. **Batches of 37** leave Go's files plus exactly the superseded partial tiles and bundles those batch boundaries
   imply, each holding the bytes POSIX wrote at that path; after garbage collection, exactly what POSIX's GC leaves.
3. **Restarts**: a new driver, over a newly opened handle, for each of several sessions split at and around tile
   boundaries, converges on the same files.
4. **Go-written state**: a store preloaded with a smaller Go log, `.state/` included, exactly as it sits on disk,
   grows into the larger fixture.

The signing key of the fixtures is a published test key and Ed25519 is deterministic, so even signed checkpoints
compare byte for byte. Which keys a store holds is read through the backend's own listing where it has one, and
otherwise by reading back every key ever written to it.

| Backend | Runtime | Test file |
| --- | --- | --- |
| memory | Node | `src/storage/objectstore/driver_fixtures_test.ts` |
| memory | workerd | `src/storage/memory/memory_golden_workers_test.ts` |
| IndexedDB | Node (fake-indexeddb) | `src/storage/indexeddb/indexeddb_golden_test.ts` |
| IndexedDB | Chromium | `src/storage/indexeddb/indexeddb_golden_browser_test.ts` |
| SQLite engines | per engine | wired by `src/storage/sqlite`, with the same call |

Every runtime runs every fixture size; the largest takes under two seconds in Chromium.

### Go interop harness

`pnpm interop` builds two Go tools on the pinned Tessera checkout:

- **`interop/produce`** writes a log with Tessera's real POSIX driver, in batches ending at given sizes, and records
  every checkpoint it publishes. Pointed at an existing log, it resumes it.
- **`interop/verify`** judges a log directory with Tessera's own code, read through `client.FileFetcher` as
  `cmd/fsck` reads a `file://` log: the checkpoint signature; `fsck` of the whole tree (every bundle re-hashed,
  every tile re-derived, the root recomputed); every entry against the expected corpus, with every bundle holding
  exactly the entries the tree size implies; inclusion proofs for entries at every boundary plus a seeded random
  sample, and for the first and last entry of every historical tree; consistency proofs from every historical
  checkpoint to the final one.

Both sides derive their entries from one seeded corpus (entries of 0 to 255 bytes, empty entries, and 4 to 16 KiB
entries; see `interop/internal/entries`) and follow one seeded batch plan. For each backend that runs in Node
(memory, IndexedDB on fake-indexeddb, SQLite through node:sqlite and through libSQL):

- **ts -> go**: webtessera writes 65 000 entries in about 60 batches. Go verifies the exported store, which must be
  byte-identical to the log Go writes for the same plan (every file, `.state/treeState` and `.state/version`
  included, and every one of the ~60 signed checkpoints). Go's POSIX driver then carries the log on to 70 000
  entries, past the first level-2 tile, and the result is verified and compared again.
- **go -> ts**: Go writes 65 000 entries; the directory, `.state/` included, is loaded into the backend;
  webtessera's own client and fsck verify it; webtessera carries it on to 70 000; Go verifies the result, including
  consistency from Go's checkpoints to webtessera's, and it must be byte-identical to Go's log for the whole plan.

A typical run prints, per backend:

```
memory
  ok    ts -> go  webtessera appended [0, 65000) in 61 batches (9.8s)
  ok    ts -> go  Go verified webtessera's log (0.2s)
                    Go: fsck: every bundle, tile and the root re-derived and identical
                    Go: entries: all 65000 are the interop corpus with seed 1, in order
                    Go: inclusion: 202 proofs verified (final tree and 61 historical trees)
                    Go: consistency: 61 historical checkpoints proven consistent with the final one
  ok    ts -> go  webtessera's log is Go's log (0.1s)
                    every file and all 61 signed checkpoints are byte-identical
  ...
summary
  reference                    go PASS
  memory                       ts -> go PASS   go -> ts PASS
  indexeddb (fake-indexeddb)   ts -> go PASS   go -> ts PASS
  sqlite (node:sqlite)         ts -> go PASS   go -> ts PASS
  sqlite (libSQL)              ts -> go PASS   go -> ts PASS
```

Any difference fails the run and names the file and the first differing byte; the logs are kept for inspection.
The whole run takes about 90 seconds for the four backends.

## What is compared

| Artefact | Fixtures and golden suite | Interop harness |
| --- | --- | --- |
| Tiles (full and right-edge partial) | byte-identical | byte-identical, and re-derived by Go's fsck |
| Superseded partial tiles and bundles | byte-identical (the prefix POSIX wrote) | byte-identical |
| Entry bundles | byte-identical | byte-identical; every entry checked against the corpus |
| Signed checkpoint | byte-identical | byte-identical at every batch, signature verified by Go |
| `.state/treeState`, `.state/version` | byte-identical to Go's | byte-identical; each side resumes the other's |
| `.state/gcState` | not compared (GC is off in the fixtures; `json_test.ts` pins its encoding) | not compared (GC off) |
| Set of paths | exact | exact |

## Differences that are not byte differences

- **Lock files.** POSIX keeps empty `flock(2)` targets in `.state/` (`treeState.lock`, `publish.lock`, ...). A store
  has none: `ObjectStore.lock` is not backed by objects. They carry no data and are ignored on both sides.
- **Symlinked partial tiles.** POSIX's `writeTile` means to replace superseded partial tiles with symlinks to the
  full tile; webtessera does not (ADR-0101). In practice, at the pinned commit, the relinking only happens when the
  log directory is the process's working directory, and then leaves dangling links; otherwise POSIX keeps the
  partial files exactly as webtessera does. ADR-0162 has the details and the evidence.

## CI

| Job | Command | Needs |
| --- | --- | --- |
| Fixtures are reproducible | `pnpm fixtures`, then `git status --porcelain fixtures/data` must be empty | Go 1.24, `pnpm upstream` |
| Go and TypeScript interoperate | `pnpm build && pnpm interop` | Go 1.24, `pnpm upstream`, `pnpm install` |
| Unit (Node 22, 24) | `pnpm test:unit` (golden suite: memory, IndexedDB on fake-indexeddb) | `pnpm install` |
| Browser (Chromium) | `pnpm test:browser` (golden suite: IndexedDB) | Playwright Chromium |
| Workers (workerd) | `pnpm test:workers` (golden suite: memory, and the SQLite engines of workerd) | `pnpm install` |

## Reproducing locally

```sh
pnpm install
pnpm fixtures && git status --porcelain fixtures/data   # nothing printed: the fixtures are Go's
pnpm test:unit                                          # includes the golden suite on Node
pnpm test:browser                                       # PLAYWRIGHT_CHROMIUM_EXECUTABLE=... to use a local Chromium
pnpm test:workers
pnpm interop                                            # checks out upstream and builds dist/ itself
```

`pnpm interop` accepts `--seed N`, `--size1 N --size2 N` (for example `--size1 3000 --size2 5000` for a quick
run), `--backend NAME` (repeatable), `--keep` to keep the logs, and `--no-build` to reuse an existing `dist/`. It
needs Go 1.24 or later on `PATH` and, the first time, access to the Go module proxy.

The Go tools also run on their own, for example against a log exported from a browser:

```sh
cd interop
go run ./verify -dir /path/to/log -vkey "$(cat log.vkey)" -history /path/to/checkpoints
go run ./produce -dir /tmp/log -skey "$SKEY" -seed 1 -from 0 -ends 1,256,1000 -history /tmp/log.history
```

## Adding a backend

1. Call `describeGoldenCompatibility` from the backend's test file in every runtime it supports, passing
   `listKeys` if the backend can enumerate its keys and `reopen` if it can open a second handle onto the same data.
2. If it runs in Node, add one entry to [`scripts/interop/backends.mjs`](../scripts/interop/backends.mjs).
