# Compatibility with Tessera

webtessera claims that a log it writes, on any of its storage backends, is **byte for byte** the log Tessera's
own POSIX driver writes for the same entries, and that each side can carry on a log the other started. This page
explains how that claim is proven, what exactly is compared, and how to reproduce every check on your machine.
The Go code the claim refers to is Tessera at the commit pinned in [`scripts/upstream.json`](../scripts/upstream.json).

## The evidence, in five layers

| Layer | What it proves | Where |
| --- | --- | --- |
| Golden fixtures | Outputs recorded from real Tessera: paths, tiles, bundles, proofs, notes, checkpoints, and complete logs with their `.state/` files. Regenerating them leaves `fixtures/data` unchanged. | [`fixtures/`](../fixtures/README.md), ADR-0006, ADR-0161 |
| Component tests | Each ported package reproduces its fixtures byte for byte. | `src/**/*_fixtures_test.ts` and the Go-mirrored tests |
| Golden suite, per backend | Every backend, in every runtime it supports, stores exactly the files Tessera's POSIX driver stores for the fixture logs, and carries on logs Go wrote. | [`golden.ts`](../src/storage/objectstore/testing/golden.ts), ADR-0160 |
| Go interop harness | Tessera's own Go code verifies logs webtessera wrote on each Node backend, reproduces them byte for byte, and carries them on; webtessera does the same with logs Go wrote. | [`interop/`](../interop), [`scripts/interop.mjs`](../scripts/interop.mjs), ADR-0162 |
| Differential corpora | Go's verdict, error text and outputs on ~86 000 generated inputs (most of them malformed) and on every Unicode scalar, replayed in Node, Chromium and workerd; every difference is either a named, ADR-backed divergence or a failure. | [`fixtures/gen/differential*.go`](../fixtures/gen), [`src/testonly/testing/differential/`](../src/testonly/testing/differential), ADR-0215, ADR-0216 |

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

## Differential tests

The golden fixtures pin hand-picked cases. The differential corpora run the pinned Go code over thousands of
generated inputs, most of them malformed, and record every verdict: accept or reject, the exact error text, and
every output. The TypeScript suites replay each record and must reach the same verdict, except where a named
divergence says otherwise. They are the permanent form of the fidelity audits' Go-versus-TypeScript experiments
(ADR-0215).

### What exists

| Corpus (`fixtures/data/`) | Size | Records | What Go recorded |
| --- | --- | --- | --- |
| `differential_checkpoint.json` | 1.1 MB | 8 460 | `Checkpoint.Unmarshal` over boundary and random bodies (valid and invalid UTF-8), `Marshal`, `log.ID`, `ParseCheckpoint` over signed, mutated checkpoints |
| `differential_note_keys.json` | 0.8 MB | 5 224 | `NewVerifier`, `NewSigner`, `NewEd25519VerifierKey`, `GenerateKey`, and formats/note's cosignature/v1 constructors and `VKeyToCosignatureV1`, over names with every Unicode space, BOM, controls and `+`, every algorithm byte and key length, malformed hash and base64 fields |
| `differential_note_open.json` | 0.9 MB | 1 654 | `note.Open` of notes signed under valid and invalid names, with stray bytes, invalid UTF-8, BOM, truncation, duplicate and broken signature lines, 100 and 101 signatures, ambiguous verifiers |
| `differential_note_sign.json` | 0.2 MB | 1 500 | `note.Sign` with existing (malformed) signatures and signers under invalid names: error text or exact bytes |
| `differential_ed25519.json` | 0.6 MB | 2 366 | Go's `crypto/ed25519.Verify` on honest and corrupted signatures, S+L, S high bits, small-order and non-canonical keys with cofactorless-valid signatures, mixed-order keys, torsion on R; every key classified and `NewVerifier`'s verdict on it |
| `differential_cosig.json` | 0.7 MB | 3 631 | cosignature/v1 key hashes, the signature a signer must produce at fixed seconds (proven by upstream's verifier), `Sign` errors, `Verify` up to t = 2^64-1, `CoSigV1Timestamp`, cosigned notes through `Open` |
| `differential_layout.json` | 0.7 MB | 8 664 | `ParseTileIndexPartial`, `ParseTileLevel`, `ParseTileLevelIndexPartial` over generated segments; path builders, `PartialTileSize`, `NodeCoordsToTileAddress` and `Range` over random uint64s |
| `differential_proof_inclusion.json` | 0.9 MB | 4 635 | `VerifyInclusion` over random and exhaustive-small (index, size) up to 2^64-1, wrong proof lengths, wrong-size hashes; each mismatch replayed with Go's calculated root (the success path) |
| `differential_proof_consistency.json` | 1.2 MB | 4 481 | `VerifyConsistency` likewise, through the second-root check to the success path |
| `differential_proof_nodes.json` | 0.8 MB | 3 023 | `proof.Inclusion`/`Consistency` node IDs, ephemeral node and `Rehash` output, for every tree up to 40 and random sizes up to 2^64-1 |
| `differential_compact.json` | 1.1 MB | 6 061 | `Decompose`, `RangeNodes`, `RangeSize`, `NodeID`, and `Range` traces: appends from begins near 2^63 and 2^64 and past 2^64-1, recursive merges, merge errors, `NewRange` |
| `differential_rfc6962.json` | 0.2 MB | 436 | `HashLeaf` for every length up to 140 and the SHA-256 block boundaries, `HashChildren`, `EmptyRoot` |
| `differential_gostd.json` | 1.5 MB | 25 246 | `base64.StdEncoding.DecodeString`, `hex.DecodeString`, `strconv.ParseUint` (16/32, 16/64, 10/64, 10/8), `strconv.Quote` for every scalar value (escaped ranges, exact text for a sample), `strings.Fields`/`TrimSpace`, `math/bits` and shifts |
| `differential_unicode.json` | 0.1 MB | ~910 000 sequences, 1 114 112 code points | `utf8.Valid` over structured sweeps of every byte-class boundary (1 and 2 bytes exhaustively) and random strings; `unicode.IsSpace` for every code point |
| `differential_witness_policy.json` | 0.2 MB | 695 | `NewWitnessGroupFromPolicy` over hand-written and generated policies: error text, or the group tree and endpoints |
| `differential_bundle_hashers.json` | 0.2 MB | 400 | the tlog-tiles and static-ct identity and Merkle leaf hashers over well-formed and corrupted bundles |
| `differential_checkpoint_publisher.json` | 0.1 MB | 414 | `CheckpointPublisher`'s signed checkpoints, and its rejection of each previous checkpoint `internal/parse.CheckpointUnsafe` rejects |
| `differential_api.json` | 0.5 MB | 108 | `HashTile` and `EntryBundle` `UnmarshalText` up to 300 elements (the spec allows 256), truncated and padded; `NewEntry` around the 65 535-byte length-prefix limit |
| `differential_ct_log.json` | 0.1 MB | 300 entries, 8 files | a static-ct log built by the POSIX driver with `WithCTLayout` and `NewCertificateTransparencyAppender`: every file, `.state` included, rebuilt on the ObjectStore driver |

### How they are generated

`pnpm fixtures` runs them with every other fixture, so CI's "fixtures are reproducible" job also proves they are
what the pinned Go code produces. Each corpus has its own seed; inputs are built in Go (the adversarial Ed25519
vectors with `filippo.io/edwards25519`, the code `crypto/ed25519` is built from) and every recorded value is
upstream's output. Records are compact JSON arrays, one per line, whose columns each file names. `go run .
-diffscale 10` inside `fixtures/gen` writes the same corpora with ten times the random records, for a soak run
that is not committed.

### How they are replayed

The suites live in `src/testonly/testing/differential/`. They run on Node from the `*_differential_test.ts` file
next to the code they cover (`pnpm test:unit`), and all of them again in Chromium
(`src/testonly/differential_browser_test.ts`, `pnpm test:browser`) and workerd
(`src/testonly/differential_workers_test.ts`, `pnpm test:workers`), because several stand-ins depend on the
runtime: `validUTF8` and `fromUTF8` on `TextDecoder`, `quote` on the runtime's Unicode property tables, the
witness URL checks on the platform URL parser. A failing suite prints how many records it replayed and
mismatched, how often each divergence applied, and the first mismatches with their inputs.

### How divergences are allow-listed

A record may differ from Go only under an entry of `DIVERGENCES` in
[`src/testonly/testing/differential.ts`](../src/testonly/testing/differential.ts). Each entry names the ADRs that
decided it and the exact behaviour the port shows instead, and a suite applies it only when that behaviour is
what it observes; any other difference is a failure. Each suite lists the entries it may apply and those it must
apply at least once. ADR-0216 explains each entry; `pnpm test:parity` fails if one cites a missing ADR. Adding an
entry needs an ADR, like any divergence.

### Test parity

`pnpm test:parity` ([`scripts/test-parity.mjs`](../scripts/test-parity.mjs), ADR-0217) lists every Go test,
example, fuzz target and benchmark of Tessera and of the vendored modules (`go test -list` merged with a static
scan), reads vitest's JSON report, and fails unless each one has a passing TypeScript test of the same name in
the mirrored directory or an entry in [`scripts/test-parity-allowlist.json`](../scripts/test-parity-allowlist.json)
citing the ADR that left it out. It prints one row per Go package (tests, ported, allow-listed, missing,
failing); `--verbose` adds the allow-listed names, `--report vitest.json` reuses an existing report.

## CI

| Job | Command | Needs |
| --- | --- | --- |
| Fixtures are reproducible | `pnpm fixtures`, then `git status --porcelain fixtures/data` must be empty (golden fixtures and differential corpora) | Go 1.24, `pnpm upstream` |
| Go and TypeScript interoperate | `pnpm build && pnpm interop` | Go 1.24, `pnpm upstream`, `pnpm install` |
| Unit (Node 22, 24) | `pnpm test:unit` (golden suite: memory, IndexedDB on fake-indexeddb; every differential corpus, `*_differential_test.ts`) | `pnpm install` |
| Browser (Chromium) | `pnpm test:browser` (golden suite: IndexedDB; every differential corpus, `src/testonly/differential_browser_test.ts`) | Playwright Chromium |
| Workers (workerd) | `pnpm test:workers` (golden suite: memory, and the SQLite engines of workerd; every differential corpus, `src/testonly/differential_workers_test.ts`) | `pnpm install` |
| Test parity | `pnpm test:parity` | Go 1.24, `pnpm upstream`, `pnpm install`, Go module proxy on first run |

## Reproducing locally

```sh
pnpm install
pnpm fixtures && git status --porcelain fixtures/data   # nothing printed: the fixtures are Go's
pnpm test:unit                                          # includes the golden suite on Node
pnpm test:browser                                       # PLAYWRIGHT_CHROMIUM_EXECUTABLE=... to use a local Chromium
pnpm test:workers
pnpm test:parity                                        # every upstream Go test has a TypeScript counterpart
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
