# Porting map — Go → TypeScript

This is the file-by-file status of the port, and a reviewer's first stop. It covers **every one of
the 106 `.go` files** in upstream Tessera @ `4a6d9f9` (see `scripts/upstream.json`), whether or not
anyone has started on it, so that an omission is visible as a row rather than as an absence.

Regenerate the upstream list from the pinned checkout:

```sh
pnpm upstream
(cd .upstream/tessera && find . -name '*.go' -not -path './.git/*' | sort)
```

When the pin moves, diff that list against the first column below and add a row for every new file
as `not started`.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `done` | Ported, its Go test file is ported with the same cases, and the suite is green. |
| `in progress` | Claimed by a contributor and partially landed. Do not build on it yet. |
| `not started` | In scope per ADR-0001, nobody has claimed it. |
| `pending ADR` | Inclusion is still being argued — see the `pending` rows in ADR-0001. **Nobody may act on these**; the decision comes first. |
| `not ported` | A decision was taken not to port it. The `notes` column must name the ADR. |

The **tests (TS/Go)** column counts individual test cases — a Go table-driven subtest and its
TypeScript `it()` each count as one — so `48 / 48` means every upstream case has a counterpart.
`—` means neither side has tests yet.

## Rules for editing this file

- Add a row, never delete one. If upstream gains a file, the row appears here as `not started`.
- Only change a row for work you are doing. Do not guess at someone else's progress.
- A row is `done` only if you ran the suite and watched it pass.
- Any status other than `done`/`not started` needs either an ADR reference or the claiming
  contributor's GitHub handle (or an issue link) in `notes`.

---

## The upstream Go files

| Go path | TS path | status | tests (TS/Go) | notes |
| --- | --- | --- | --- | --- |
| `antispam.go` | `src/antispam.ts` | done | — | root package; `inMemoryDedup` + the 3-method LRU subset it uses, hand-ported instead of adding `hashicorp/golang-lru` — ADR-0081. OTel/klog dropped — ADR-0080 |
| `antispam_test.go` | `src/antispam_test.ts` | done | 4 / 4 | TestDedup ×3 + TestDedupDoesNotCacheError; benchmark not ported — ADR-0034 |
| `api/layout/example_test.go` | `src/api/layout/example_test.ts` | done | 4 / 4 | Go testable examples become assertion tests — ADR-0033 |
| `api/layout/paths.go` | `src/api/layout/paths.ts` | done | — | `Range` is a generator; `MaxUint64` overflow guard kept — ADR-0003, ADR-0030, ADR-0031 |
| `api/layout/paths_test.go` | `src/api/layout/paths_test.ts` | done | 48 / 48 | fixtures in `paths_fixtures_test.ts`: `layout_paths` (2393 cases), `layout_parse` (99), `layout_range` (27) |
| `api/layout/tile.go` | `src/api/layout/tile.ts` | done | — | `nodeCoordsToTileAddress` returns a named object — ADR-0031 |
| `api/layout/tile_test.go` | `src/api/layout/tile_test.ts` | done | 5 / 5 | fixtures in `tile_fixtures_test.ts`: `layout_tile` (1007 cases). Upstream has no direct test for `PartialTileSize`; the fixture is its only direct coverage |
| `api/state.go` | `src/api/state.ts` | done | — | `HashTile`/`EntryBundle` as classes — ADR-0032 |
| `api/state_test.go` | `src/api/state_test.ts` | done | 15 / 12 | 12 upstream cases + 3 port additions pinning the rejection messages; benchmark not ported — ADR-0034. Fixtures in `state_fixtures_test.ts`: `api_hash_tile` (19), `api_entry_bundle` (18) |
| `append_lifecycle.go` | `src/append_lifecycle.ts` | done | — | root package; `AddFn`/`IndexFuture`/`Index` kept in place (ADR-0054) and the rest completed: `Appender`, `newAppender`, `memoizeFuture`, `integrationStats`/`followerStats`, `terminator`, `AppendOptions` + all `with*`/accessors, `CheckpointPublisher`, `WitnessOptions`. OTel/klog dropped, stats structures kept as logic — ADR-0080. Witness gateway wired — ADR-0082. Structural mappings (named multi-returns, `sync.Cond`/mutex drops, sync `newCP`) — ADR-0083. `NewCertificateTransparencyAppender`/`WithCTLayout` remain ct_only.go's deferred TODOs (that file's work package), now unblocked |
| `append_lifecycle_test.go` | `src/append_lifecycle_test.ts` | done | 13 / 5 | TestMemoize + TestAppendOptionsValid ×4; 8 port additions (memoize concurrency ×2, accessors ×2, `newAppender` decoration-order/shutdown/guards ×4) |
| `await.go` | `src/await.ts` | done | — | root package; `sync.Cond` → broadcast/wait, klog dropped — ADR-0083, ADR-0080 |
| `await_test.go` | `src/await_test.ts` | done | 10 / 10 | TestAwait ×9 + TestAwait_multiClient; multi-client ctx bound raised from Go's 1s (slower pure-JS ed25519 verify ×300) — in-file port note; benchmark not ported — ADR-0034 |
| `client/client.go` | `src/client/client.ts` | done | — | OTel spans dropped — ADR-0061; fetcher-shaped types take `signal` last — ADR-0060; `ErrInconsistency.Wrapped` is `Error.cause`; `RWMutex`→`Mutex` for `update`, no lock for `latest` — ADR-0063; `nodeCache`/`tileKey` exported `@internal` (not in `client/index.ts`) — ADR-0010 pattern |
| `client/client_test.go` | `src/client/client_test.ts` | done | 11 / 10 | 10 upstream cases (TestCheckLogStateTracker ×4, TestNodeCacheHandlesInvalidRequest, TestHandleZeroRoot, TestGetEntryBundleAddressing ×2, TestNodeFetcherAddressing ×2) plus 1 new case for `LogStateTracker`'s consistency-rejection path, which no upstream case reaches — ADR-0065. Fixture: `client_log` (reads back upstream's static `testdata/log`, incl. its signing key) |
| `client/fetcher.go` | `src/client/fetcher.ts` | in progress | — | `HTTPFetcher` ported via `fetch`/`URL`; `FileFetcher` (POSIX-only) not ported — ADR-0064 |
| `client/otel.go` | — | not ported | — | ADR-0061; real OpenTelemetry SDK dependency out of scope (AGENTS.md §7) and out of this work package |
| `client/stream.go` | `src/client/stream.ts` | done | — | `iter.Seq2[T,error]` → `AsyncGenerator<T>`, errors thrown; bounded read-ahead is a sliding window of promises, not a channel/goroutine translation — ADR-0066; `Range`'s `fromEntry+N` second argument kept verbatim (Port note in-file) |
| `client/stream_test.go` | `src/client/stream_test.ts` | done | 6 / 2 | Cannot reuse `testonly.NewTestLog` (Wave 2/3-only); rebuilt against `log_1000`/`log_5000` fixtures instead — see file header and ADR-0065's sibling reasoning. Covers ordering, the `numWorkers` concurrency bound, error propagation, and resuming across repeated calls (the real "log grew" usage pattern) |
| `cmd/conformance/aws/main.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row |
| `cmd/conformance/aws/otel.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row |
| `cmd/conformance/gcp/main.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row |
| `cmd/conformance/gcp/otel.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row |
| `cmd/conformance/mysql/main.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row |
| `cmd/conformance/posix/main.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row |
| `cmd/examples/posix-oneshot/main.go` | — | pending ADR | — | ADR-0001 `cmd/examples/*` row |
| `cmd/experimental/migrate/aws/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row |
| `cmd/experimental/migrate/gcp/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row |
| `cmd/experimental/migrate/mysql/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row |
| `cmd/experimental/migrate/posix/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row |
| `cmd/experimental/mirror/internal/mirror.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row |
| `cmd/experimental/mirror/posix/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row |
| `cmd/fsck/internal/tui/app.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/main.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/tui/fsck_panel.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/tui/layerbar.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/tui/layerbar_test.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/tui/stats_view.go` | — | not ported | — | ADR-0093 |
| `ctonly/ct.go` | `src/ctonly/ct.ts` | done | 52 / 0 | no upstream test file; `src/ctonly/ct_test.ts` is new and fixture-backed — ADR-0043 |
| `ct_only.go` | `src/ct_only.ts` | in progress | — | root package; bundle parsers, copy helpers, `ctEntriesPath`, `convertCTEntry` and now `(*MigrationOptions).WithCTLayout` → `withCTLayout` are done (`src/migrate_lifecycle.ts` existing unblocked it — ADR-0079). Only `NewCertificateTransparencyAppender` and `(*AppendOptions).WithCTLayout` remain, now unblocked by `src/append_lifecycle.ts` landing but not picked up by this (witness/migrate) work package — out of its assigned scope. `identityHash`'s duplicate is deleted; it imports the shared definition from `src/lifecycle.ts` — ADR-0044, ADR-0055, ADR-0059, ADR-0079 |
| `ct_only_test.go` | `src/ct_only_test.ts` | done | 31 / 12 | all 12 upstream cases plus bundle-parser error paths, golden-fixture cross-checks, 5 `convertCTEntry` cases, and 1 new `withCTLayout` case — ADR-0044, ADR-0055, ADR-0059, ADR-0079 |
| `entry.go` | `src/entry.ts` | done | — | `Entry.internal` groups the fields Go keeps in an unexported struct, reachable the way Go's same-package visibility allows (used by `ct_only.ts`'s `convertCTEntry`, unblocked and ported by this landing — ADR-0059) — ADR-0010's pattern, no leading `_` needed since nesting avoids the accessor collision. `api/state_test.ts` stands in for the bundle encoding too — ADR-0036 |
| `entry_test.go` | `src/entry_test.ts` | done | 8 / 1 | the 1 upstream case plus 7 port additions pinning `newEntry`'s own defaults (identity, leaf hash, bundle encoding, uint16 length-prefix truncation), which the golden-fixture integration test in `storage/internal/integrate_fixtures_test.ts` depends on |
| `fsck/fsck.go` | `src/fsck/fsck.ts` | done | 12 / 4 | `Fetcher` ported as its own interface, not merged with client's fetcher-shaped types; `chan resource` → `ResourceQueue`, an async queue with **loop-level backpressure** (`waitUntilBelow`, `size`) replacing the bound a Go buffered channel gives for free — the queue's own buffer is unbounded (an async queue has no other way to represent "waiting to be pulled"), but `check()`'s bundle loop now awaits `waitUntilBelow(resourceBackpressureThreshold(n), eg.signal)` between bundles, capping buffered resources at O(n) instead of O(logSize); see ADR-0091 §1's resolution note — a real memory-exhaustion gap the reviewer caught and the lead fixed, not the implementer's original unbounded design; `atomic.Uint64` counters → plain `bigint` fields; `compact.NodeID` map keys → string keys (ADR-0050 precedent); `uint8(256)` full-tile wraparound reproduced explicitly; `klog` dropped, `klog.Exitf` invariant guards → thrown `Error`s; `New` → `newFsck` (reserved word) — ADR-0091. `fsckTree.visit` needs no ADR-0052-style sync-visitor/async-I/O workaround (it does no I/O) — ADR-0092. 1 upstream case (`TestTrimFullToPartial`, 4 subtests) plus 8 new cases: 2 fixture-backed `check()` integration tests, 1 pinning the `uint8(256)` wrap, 4 unit tests on `ResourceQueue.waitUntilBelow` (immediate-resolve, block-then-unblock-via-pull, unblock-via-abort, already-aborted), and 1 end-to-end test proving buffered-resource count stays capped under a fast-producer/slow-consumer imbalance (verified to fail without the fix: peak size 48 against a threshold of 16) — see file header |
| `fsck/fsck_test.go` | `src/fsck/fsck_test.ts` | done | 12 / 4 | `TestTrimFullToPartial`'s 4 subtests ported verbatim, plus 8 new cases not part of upstream — see the `fsck.go` row and file header |
| `fsck/status.go` | `src/fsck/status.ts` | done | — | `State` (Go `uint8` + `String()`) → `number` consts + standalone `stateString` (primitives can't carry methods); `rangeTracker`'s `mu *sync.Mutex` dropped (every method is synchronous, ADR-0004); `Range`/`rangeTracker` exported lowercase per ADR-0010 (touched directly by `status_test.ts`); backed by the new `src/internal/gostd/list.ts` — ADR-0090, ADR-0091 |
| `fsck/status_test.go` | `src/fsck/status_test.ts` | done | 12 / 10 | all 10 `TestUpdate` subtests, plus 2 new cases pinning `stateString`'s and `update`'s panic branches, neither covered upstream |
| `integration/fault/posix/fault_test.go` | — | pending ADR | — | ADR-0001 `integration/` row |
| `integration/integration_test.go` | — | pending ADR | — | ADR-0001 `integration/` row |
| `internal/fetcher/fallback.go` | `src/internal/fetcher/fallback.ts` | done | — | `ctx` → trailing `signal` on `f` too — ADR-0060 |
| `internal/fetcher/fallback_test.go` | `src/internal/fetcher/fallback_test.ts` | done | 5 / 5 | |
| `internal/future/future.go` | `src/internal/future/future.ts` | done | — | ported ahead of the `client` package because `storage/internal/queue.ts` needs it directly; self-contained, nothing for `client` to reconcile. Native `Promise` instead of `WaitGroup`+fields — ADR-0056 |
| `internal/hammer/hammer.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/hammer_test.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/loadtest/analysis.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/loadtest/analysis_test.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/loadtest/client.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/loadtest/hammer.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/loadtest/throttle.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/loadtest/tui.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/loadtest/workerpool.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/hammer/loadtest/workers.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row |
| `internal/migrate/migrate.go` | `src/internal/migrate/migrate.ts` | done | — | `MigrationWriter` interface only, no upstream test file; ported alongside `migrate_lifecycle.ts` (which needs it to compile) rather than left blocking — ADR-0076 |
| `internal/otel/cast.go` | `src/internal/otel/cast.ts` | not started | — | |
| `internal/parse/parse.go` | `src/internal/parse/parse.ts` | done | — | returns a named object — ADR-0031; needs `gostd/bytes.splitN` and strict base64 — ADR-0035 |
| `internal/parse/parse_test.go` | `src/internal/parse/parse_test.ts` | done | 5 / 5 | benchmark not ported — ADR-0034. `parse_fixtures_test.ts` cross-checks against the `checkpoint` fixture; no fixture is generated from `CheckpointUnsafe` itself — see Open items |
| `internal/witness/otel.go` | — | not ported | — | metrics dropped, extending ADR-0051's precedent to this package — ADR-0070 |
| `internal/witness/witness.go` | `src/internal/witness/witness.ts` | done | — | `WitnessGateway`/`newWitnessGateway`, `ErrPolicyNotSatisfied`, `sharedConsistencyProofFetcher`, `witness`/`update` (HTTP via `FetchFn`, the same stand-in `client/fetcher.ts` uses for `*http.Client`). OTel/klog dropped — ADR-0070. Channel-based result fan-in becomes promise racing (no goroutine-leak equivalent) — ADR-0072. The `errors.Join(ErrPolicyNotSatisfied, err)` + partial-checkpoint return becomes `PolicyNotSatisfiedError` — ADR-0075 |
| `internal/witness/witness_test.go` | `src/internal/witness/witness_test.ts` | done | 22 / 22 | all 6 Go test functions (`TestWitnessGateway_Update` ×8, `TestWitness_UpdateRequest` ×2, `TestWitness_UpdateResponse` ×6, `TestWitnessConflict` ×4, `TestWitnessStateEvolution`, `TestWitnessReusesProofs`) reusing the `client_log` fixture instead of a real posix driver/appender for tile/checkpoint data — same judgement call as `client/stream_test.ts` — ADR-0065's sibling reasoning |
| `keygen/main.go` | — | not ported | — | **No such file in upstream @ `4a6d9f9`** (`git ls-tree` finds none; the pinned tree has 106 `.go` files). Kept only because rows are never deleted; it, and ADR-0001's `keygen/` row, should go when ADR-0001 is next revised |
| `lifecycle.go` | `src/lifecycle.ts` | done | 9 / 0 | root package; `LogReader`/`Follower`/`Antispam` interfaces ported faithfully, the concrete `Appender`/antispam wiring is Wave 3's job. `identityHash` exported here, closing ADR-0044's `ct_only.ts` TODO — ADR-0055. `defaultIDHasher`/`defaultMerkleLeafHasher` exported (Go-unexported, no upstream test) so `lifecycle_test.ts` can reach them directly; no upstream `lifecycle_test.go` |
| `log.go` | `src/log.ts` | done | 8 / 0 | root package; `ErrPushbackAntispam`/`ErrPushbackIntegration` built directly with `new Error(..., {cause})` rather than `wrapError`, since Go's `fmt.Errorf("antispam %w", ...)` has no colon before `%w` (Port note in-file). No upstream `log_test.go` |
| `migrate.go` | `src/migrate.ts` | done | 13 / 0 | root package; `copier`/`newCopier`/`Bundle`/`populateWork` exported per ADR-0010's pattern. No upstream `migrate_test.go` (Wave 4 `integration/` needs a real driver — ADR-0074); 13 new cases cover `populateWork`'s chunking arithmetic and `Copier.copy`'s worker orchestration/retry against in-memory fakes. `todo` channel + producer goroutine become a shared generator — ADR-0077. `cenkalti/backoff` retry policy hand-rolled — ADR-0073. OTel/klog dropped — ADR-0070 |
| `migrate_lifecycle.go` | `src/migrate_lifecycle.ts` | done | 14 / 0 | root package; `newMigrationTarget`, `MigrationOptions` (fields grouped under `internal`, mirroring `Entry.internal` — closes `ct_only.ts`'s `WithCTLayout` TODO, ADR-0079), `MigrationTarget`/`migrate`, `awaitFollower`, `progress`. No upstream test file (same ADR-0074 reasoning as `migrate.go`); 14 new cases cover `progress()`'s formatting (incl. Go's `%.2f` +Inf/NaN rendering), `awaitFollower`'s polling loop, `MigrationOptions`'s accessors, and `newMigrationTarget`'s driver-rejection path. The periodic "Progress: ..." printer goroutine is dropped (klog-only effect) — ADR-0070 |
| `otel.go` | `src/otel.ts` | not ported | — | root package; real OpenTelemetry SDK dependency out of scope (AGENTS.md §7). Its tracer/meter and the append-lifecycle metric setup are dropped from `append_lifecycle.ts`/`await.ts`/`antispam.ts` — ADR-0080 (following ADR-0051/0061) |
| `README_test.go` | `src/README_test.ts` | not started | — | compiles the README's examples; both its tests need `Appender` (Wave 3) and a storage driver (none in scope yet) — nothing is independently portable — ADR-0058 |
| `storage/aws/antispam/aws.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/aws/antispam/aws_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/aws/aws.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/aws/aws_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/aws/otel.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/gcp/antispam/gcp.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/gcp/antispam/gcp_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/gcp/antispam/otel.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/gcp/gcp.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/gcp/gcp_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/gcp/otel.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/internal/integrate.go` | `src/storage/internal/integrate.ts` | done | — | the Merkle tree-building engine every storage driver calls into. `TileID`/`compact.NodeID`-keyed Go maps become string-keyed `Map`s — ADR-0050. OTel/klog dropped — ADR-0051. `tileWriteCache`'s `getTile` fallback is synchronous, backed by a cache-only `tileReadCache.peek` — ADR-0052 (read this one first if reviewing). `errors.Join` ported as `joinErrors` — ADR-0057. `treeBuilder`/`tileWriteCache`/`populatedTile` exported (Go-unexported) so `integrate_test.ts` can reach them, mirroring ADR-0044's pattern |
| `storage/internal/integrate_test.go` | `src/storage/internal/integrate_test.ts` | done | 3 / 3 | `TestNewRangeFetchesTiles`, `TestTileVisit`, `TestIntegrate` (200,000-entry test given an explicit 60s timeout — bigint + async-per-chunk overhead the Go original doesn't pay, Port note in-file); benchmark not ported — ADR-0034. Golden fixtures in `integrate_fixtures_test.ts`: 11 cases across all 8 `log_<N>` sizes plus 255→256→257 boundary-crossing resumption — the strongest proof in this package, claims the previously-unclaimed `log_<N>.json` fixtures |
| `storage/internal/otel.go` | `src/storage/internal/otel.ts` | not started | — | out of scope for the storage-internal work package; its tracer/attribute keys are dropped from `integrate.ts`/`queue.ts` — ADR-0051 |
| `storage/internal/queue.go` | `src/storage/internal/queue.ts` | done | — | buffered channel + worker goroutine become an unbounded array drained by an async loop, since `add()` must stay synchronous and JS cannot block a synchronous caller the way Go blocks a goroutine on a full channel — ADR-0053. Mutexes in `add()`/`flush()` dropped (synchronous critical sections, ADR-0004) |
| `storage/internal/queue_test.go` | `src/storage/internal/queue_test.ts` | done | 10 / 6 | `TestQueue` (3 cases) + `TestNotify` (3 cases) ported with matching values, plus 4 port additions (maxSize-triggered flush, maxAge-triggered flush, FIFO order across a multi-batch flush, add() does not resolve before a flush). Benchmark not ported — ADR-0034 |
| `storage/internal/tileid.go` | `src/storage/internal/tileid.ts` | done | 8 / 0 | `TileID` is a 2-field value type, no upstream `tileid_test.go`; `tileIDKey` added for use as a `Map` key — ADR-0050 |
| `storage/mysql/mysql.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/mysql/mysql_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row |
| `storage/posix/antispam/badger.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row |
| `storage/posix/antispam/badger_test.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row |
| `storage/posix/antispam/otel.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row |
| `storage/posix/file_ops.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row; encodes the crash-safety contract the browser/edge drivers must also meet |
| `storage/posix/files.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row |
| `storage/posix/files_test.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row |
| `storage/posix/otel.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row |
| `storage/storage_test.go` | `src/storage/storage_test.ts` | not started | — | cross-driver conformance suite; blocked on which drivers exist |
| `testonly/testlog.go` | `src/testonly/testlog.ts` | not started | — | |
| `witness.go` | `src/witness.ts` | done | — | root package; policy DSL (`newWitnessGroupFromPolicy`, `keywords`/`isBadName`), `newWitness`/`Witness`, `newWitnessGroup`/`WitnessGroup`. `url.URL.JoinPath` has no platform equivalent, reimplemented narrowly — ADR-0078. Depends on a new narrow vendor port of `formats/note`'s cosignature/v1 — ADR-0071 |
| `witness_policy_test.go` | `src/witness_policy_test.ts` | done | 11 / 11 | `TestNewWitnessGroupFromPolicy` ×2, `TestNewWitnessGroupFromPolicy_GroupN` ×3, `TestNewWitnessGroupFromPolicy_Errors` ×6 |
| `witness_test.go` | `src/witness_test.ts` | done | 18 / 18 | `TestWitnessGroup_Empty`, `TestWitnessGroup_Satisfied` ×12, `TestWitnessGroup_URLs` ×5. `BenchmarkWitnessGroupSatisfaction` not ported — ADR-0034 |

---

## Beyond the upstream files

Categories of file exist in `src/` with no row above, because they have no counterpart in the
Tessera repository. Add tables here as they land.

- **`src/vendor/`** — ports of Tessera's Go dependencies (`transparency-dev/merkle`,
  `transparency-dev/formats`, `golang.org/x/mod/sumdb/note`). Their upstreams and versions are listed
  in `AGENTS.md` §1. ADR-0002 explains why they live under `src/vendor/`.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | `golang.org/x/mod/sumdb/note/note.go` | `src/vendor/note/note.ts` | done | — | **BSD-3-Clause, not Apache-2.0** — ADR-0024. Error shape — ADR-0021. Optional signature lists and the `io.Reader` for randomness — ADR-0023. Ed25519 verified with Go's exact RFC 8032 / cofactorless rule (`zip215: false` plus a cofactorless residual check) — ADR-0025 |
  | `golang.org/x/mod/sumdb/note/note_test.go` | `src/vendor/note/note_test.ts` | done | 10 / 7 | 7 upstream tests + 3 port additions: signing non-ASCII text and a non-ASCII signer name (both asserted against Go's literal output), and a review-added regression that rejects a cofactored-only signature Go rejects (ADR-0025). `BenchmarkOpen` not ported — ADR-0034 |
  | `golang.org/x/mod/sumdb/note/example_test.go` | `src/vendor/note/example_test.ts` | done | 4 / 3 | Go testable examples become assertion tests — ADR-0033. The extra case derives `EnochRoot`'s published verifier key from an all-zero seed |
  | `github.com/transparency-dev/formats/log/checkpoint.go` | `src/vendor/formats/log/checkpoint.ts` | done | — | `Checkpoint` is a class so the upstream test's embedded `moonLogCheckpoint` ports as a subclass — ADR-0032. `size` is `bigint` — ADR-0003. Absent trailing data is `undefined`, mirroring Go's nil |
  | `github.com/transparency-dev/formats/log/checkpoint_test.go` | `src/vendor/formats/log/checkpoint_test.ts` | done | 18 / 16 | 16 upstream cases + 2 port additions marshalling and round-tripping a non-ASCII origin at `MaxUint64`, asserted against Go's literal output |
  | `github.com/transparency-dev/formats/log/identifier.go` | `src/vendor/formats/log/identifier.ts` | done | — | |
  | `github.com/transparency-dev/formats/log/identifier_test.go` | `src/vendor/formats/log/identifier_test.ts` | done | 7 / 6 | 6 upstream cases + 1 pinning UTF-8 hashing of a non-ASCII origin |
  | `github.com/transparency-dev/formats/log/note.go` | `src/vendor/formats/log/note.ts` | done | — | `parseCheckpoint` returns a result object and throws `ParseCheckpointError`, which carries the note — ADR-0022 |
  | `github.com/transparency-dev/formats/log/note_test.go` | `src/vendor/formats/log/note_test.ts` | done | 14 / 14 | includes a real `sum.golang.org` checkpoint. `BenchmarkParse`/`BenchmarkLotsOfIDs` not ported — ADR-0034 |
  | — | `src/vendor/formats/log/index.ts` | done | — | barrel for `webtessera/formats/log`; no Go counterpart, the package is the unit of import in Go |

  ### `github.com/transparency-dev/formats/note` @ `v0.0.0-20251017110053-404c0d5b696c`

  New dependency, discovered while porting `witness.go` (`NewWitness` calls
  `f_note.NewVerifierForCosignatureV1`). Narrowly scoped to the two functions the witness/migrate
  work package actually calls — ADR-0071.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | `note_cosigv1.go` | `src/vendor/formats/note/note_cosigv1.ts` | in progress | 4 / 8 | only `NewSignerForCosignatureV1`/`NewVerifierForCosignatureV1` ported; `VKeyToCosignatureV1`/`CoSigV1Timestamp` not ported (no caller in scope) — ADR-0071. BSD-3-Clause, like `src/vendor/note/` (ADR-0024) |
  | `note_cosigv1_test.go` | `src/vendor/formats/note/note_cosigv1_test.ts` | in progress | 4 / 8 | `TestSignerRoundtrip`, `TestSignerVerifierRoundtrip`, `TestVerifierInvalidSig`, `TestSigCoversExtensionLines` ported; `TestCoSigV1NewVerifier`, `TestCoSigV1Timestamp`, `TestVKeyToCosignatureV1` need unported functions — ADR-0071 |
  | `note_verifier.go` | — | not ported | — | `NewVerifier` dispatcher, `NewEd25519SignerVerifier`, `NewECDSAVerifier`: no caller in scope — ADR-0071 |
  | `note_rfc6962.go` | — | not ported | — | no caller in scope — ADR-0071 |

  ### `github.com/transparency-dev/merkle` @ `v0.0.2`

  Read-only upstream at `~/go/pkg/mod/github.com/transparency-dev/merkle@v0.0.2`. All paths below are
  relative to that root and to `src/vendor/merkle/`. This layer is **synchronous throughout** —
  ADR-0005.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | `hasher.go` | `hasher.ts` | done | — | interface only; `LogHasher` methods camelCased per ADR-0002 |
  | `rfc6962/rfc6962.go` | `rfc6962/rfc6962.ts` | done | — | `New(crypto.Hash)` → `new Hasher(sha256)`; `crypto.Hash` → noble `CHash` — ADR-0011. `DefaultHasher` moved to end of file (TDZ) |
  | `rfc6962/rfc6962_test.go` | `rfc6962/rfc6962_test.ts` | done | 6 / 5 | 5 upstream cases + 1 port addition pinning `size()` (Go inherits it from the embedded `crypto.Hash`); `BenchmarkHashChildren` not ported — ADR-0034. Fixtures in `rfc6962/rfc6962_fixtures_test.ts` |
  | `compact/nodes.go` | `compact/nodes.ts` | done | — | `NodeID` is a class so Go's methods stay methods; `Coverage` wraps at 2^64 — ADR-0014. `rangeNodes` always reallocates — ADR-0013 |
  | `compact/nodes_test.go` | `compact/nodes_test.ts` | done | 31 / 31 | `TestGenRangeNodes` runs all 131k `(begin,end)` pairs; equality is computed directly and `expect` only reports the mismatch, else `toEqual` dominates the runtime |
  | `compact/range.go` | `compact/range.ts` | done | — | `Range` fields are `_`-prefixed `@internal` — ADR-0010. uint64 wrapping in `getMergePath`/`decompose` — ADR-0014. Errors thrown with upstream's message text — AGENTS.md §3.6 |
  | `compact/range_test.go` | `compact/range_test.ts` | done | 477 / 476 | mirrors Go's external `compact_test` package. +1: Go's trailing "GetRootHash accepts only [0,N)" assertion is a statement inside `TestGetRootHash`, here its own `it`. `TestMergeRandomly` uses a seeded PRNG — ADR-0012. `BenchmarkAppend` not ported — ADR-0034 |
  | `compact/range_internal_test.go` | `compact/range_internal_test.ts` | done | 27 / 27 | mirrors Go's in-package test; touches `Range._begin`/`._end` and `getMergePath` — ADR-0010 |
  | `compact/node_fuzz_test.go` | — | not ported | — | fuzz target; properties covered by `TestGenRangeNodes` + fixtures — ADR-0015 |
  | — | `compact/index.ts` | done | — | barrel; re-exports exactly Go's exported surface — ADR-0010 |
  | `proof/proof.go` | `proof/proof.ts` | done | — | `Nodes.IDs` → `.ids`; `begin`/`end`/`ephem` → `_begin`/`_end`/`_ephem` — ADR-0010. `reverse` takes an explicit offset; `rehash` keeps its in-place contract — ADR-0013 |
  | `proof/proof_test.go` | `proof/proof_test.ts` | done | 71 / 71 | Go's `inclusion(t, …)` helper is dropped: the port's `inclusion` already throws, so the wrapper had nothing to do |
  | `proof/verify.go` | `proof/verify.ts` | done | — | `RootMismatchError` renders bytes with Go's `%v` (`[1 2 3]`) so the message text matches. `size2 < size1`'s swapped format arguments kept verbatim |
  | `proof/verify_test.go` | `proof/verify_test.ts` | done | 31 / 31 | probe construction wraps uint64 explicitly (`leafIndex - 1` at index 0 is `MaxUint64` upstream) — ADR-0014 |
  | — | `proof/index.ts` | done | — | barrel; re-exports exactly Go's exported surface — ADR-0010 |
  | `testonly/tree.go` | `testonly/tree.ts` | done | — | the independent reference implementation upstream cross-checks against; `New` → constructor — ADR-0011 |
  | `testonly/tree_test.go` | `testonly/tree_test.ts` | done | 72 / 70 | +2: Go's `validateTree(mt, 8)` and `ConsistencyProof(6,3)` rejection are statements inside `TestTreeConsistencyProof`, here their own `it`s. `TestTreeConsistencyProofFuzz` uses a seeded PRNG — ADR-0012 |
  | `testonly/constants.go` | `testonly/constants.ts` | done | — | pure data; no upstream test file |
  | `testonly/reference_test.go` | `testonly/reference.ts` + `testonly/reference_test.ts` | done | 12 / 12 | split in two: importing one `*_test.ts` from another double-registers its suites — ADR-0010 |
  | `testonly/tree_fuzz_test.go` | — | not ported | — | fuzz targets; properties covered by the ported tests + fixtures — ADR-0015 |

  Not ported and not listed above, because they are Go-toolchain artefacts with no counterpart:
  `go.mod`, `go.sum`, `.clusterfuzzlite/`, `testdata/FuzzRangeNodes/` (ADR-0015), `scripts/`.
- **`src/internal/gostd/`** — shims for the parts of the Go standard library the port relies on
  (`bytes`, `errors`, `strconv`, `strings`, `sync`, `bits`, …). Not Tessera logic. The layout work
  package added `bytes.splitN` and tightened `bytes.fromBase64` to Go's strictness — ADR-0035; the
  note work package added the four files below and rewrote `fromBase64` as a transcription of Go's
  `decodeQuantum` so its error offsets match Go's too — ADR-0020.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | `strconv.ParseUint`, `strconv.Quote` | `src/internal/gostd/strconv.ts` | done | 40 / — | base 0 not implemented; `quote` approximates `unicode.IsPrint` for non-ASCII — ADR-0020 |
  | `unicode.IsSpace`, `utf8.Valid`, `utf8.ValidString` | `src/internal/gostd/unicode.ts` | done | 39 / — | `isSpace` is written out because `/\s/` differs from Unicode White_Space at U+0085 and U+FEFF — ADR-0020 |
  | `strings.Cut` | `src/internal/gostd/strings.ts` | done | 10 / — | cases taken from Go's `TestCut` — ADR-0020 |
  | `io.Reader`, `io.ReadFull` | `src/internal/gostd/io.ts` | done | 6 / — | needed by `note.generateKey` — ADR-0020, ADR-0023 |
  | `base64.StdEncoding.DecodeString` | `src/internal/gostd/bytes.ts` | done | 28 / — | transcription of Go's `decodeQuantum`; accept/reject vectors and byte offsets taken from Go 1.25.5 — ADR-0020, refines ADR-0035 |
  | `golang.org/x/crypto/cryptobyte/{builder,string}.go` | `src/internal/gostd/cryptobyte.ts` | done | 39 / 18 | BSD-3-Clause, not Apache-2.0. 18 of upstream's 23 tests ported; the 5 ASN.1/fixed-builder ones go with the code that is not ported — ADR-0040. Buffer model — ADR-0041. Error and out-parameter shape — ADR-0042. |
  | `golang.org/x/crypto/cryptobyte/asn1.go` | — | not ported | — | no Tessera caller — ADR-0040 |
  | `math/bits` (uint64 intrinsics) | `src/internal/gostd/bits.ts` | done | 22 / — | `trailingZeros64`, `len64`, `onesCount64` plus `asUint64`/`shiftLeft64`/`shiftRight64` for Go's uint64 wrapping and shift saturation — ADR-0014. Every compact/proof bit operation goes through it |
  | `math/rand` (test use only) | `src/internal/gostd/rand.ts` | done | — | seeded splitmix64, deliberately not bit-compatible with Go — ADR-0012. No production code imports it |
  | `container/list` | `src/internal/gostd/list.ts` | done | 10 / 10 | BSD-3-Clause, not Apache-2.0 (Go standard library itself, not just a dependency — same open item as `cryptobyte.ts`). `Element<T>`/`List<T>` generic instead of Go's pre-generics `any`; `New` → `newList` (reserved word); `_root`/`_next`/`_prev`/`_list` are `_`-prefixed per ADR-0010 (cross-class access + `list_test.ts`'s direct field reads), `#len` stays genuinely private — ADR-0090. Added for `fsck/status.go`'s `rangeTracker` |

## Golden fixtures

Fixture assertions live in `*_fixtures_test.ts` next to the module they cover, deliberately **not**
inside the Go-mirrored `*_test.ts` file, so that file keeps diffing line-for-line against its
`*_test.go` original. The fixture files are large matrices, so each table is one test that walks
every case rather than one test name per case.

| Fixture | Asserted by | Cases |
| --- | --- | --- |
| `layout_paths.json` | `src/api/layout/paths_fixtures_test.ts` | 2393 |
| `layout_parse.json` | `src/api/layout/paths_fixtures_test.ts` | 99 |
| `layout_range.json` | `src/api/layout/paths_fixtures_test.ts` | 27 |
| `layout_tile.json` | `src/api/layout/tile_fixtures_test.ts` | 1007 |
| `api_hash_tile.json` | `src/api/state_fixtures_test.ts` | 19 |
| `api_entry_bundle.json` | `src/api/state_fixtures_test.ts` | 18 |
| `checkpoint.json` (accepted cases only) | `src/internal/parse/parse_fixtures_test.ts` | 6 |
| `note.json` | `src/vendor/note/note_fixtures_test.ts` | 95 |
| `checkpoint.json` | `src/vendor/formats/log/checkpoint_fixtures_test.ts` | 52 |
| `rfc6962.json` | `src/vendor/merkle/rfc6962/rfc6962_fixtures_test.ts` | 44 |
| `compact_range.json` | `src/vendor/merkle/compact/range_fixtures_test.ts` | 750 (minus the 6 `errors[op=appendRange]` rows — see Open items) |
| `proof_inclusion.json` | `src/vendor/merkle/proof/proof_fixtures_test.ts` | 1054 |
| `proof_consistency.json` | `src/vendor/merkle/proof/proof_fixtures_test.ts` | 1037 |
| `log_{0,1,2,255,256,257,1000,5000}.json` | `src/storage/internal/integrate_fixtures_test.ts` | 11 (8 build-from-scratch, one per size, + 3 resumption cases across the 255/256/257 boundaries) |

### Everything the generator emits

`fixtures/gen` produces 21 files / 6700 cases (3.3 MB). Load them with
`loadFixture(...)` from `src/testonly/fixtures.ts`. Fixtures not yet claimed by a test are marked
**unclaimed** — they are ready to use, nothing needs regenerating.

| Fixture | Cases | Covers |
| --- | --- | --- |
| `layout_paths.json` | 2393 | `NWithSuffix`, `TilePath`, `EntriesPath`, `EntriesPathForLogIndex` |
| `layout_parse.json` | 99 | `ParseTileLevelIndexPartial` / `ParseTileLevel` / `ParseTileIndexPartial`, every rejection + message |
| `layout_tile.json` | 1007 | `PartialTileSize`, `NodeCoordsToTileAddress`, the width constants |
| `layout_range.json` | 27 | `Range(from, N, treeSize)` |
| `rfc6962.json` | 44 | `EmptyRoot`, `HashLeaf`, `HashChildren` |
| `compact_range.json` | 750 | `compact.Range` append/merge with visitor output, `RangeNodes`, `RangeSize`, `Decompose`, `NodeID`, and the rejections |
| `proof_inclusion.json` | 1054 | every leaf of every tree 1..40, selected proofs up to 5000, `proof.Inclusion` node IDs, `RootFromInclusionProof` rejections, RFC 6962 reference tree |
| `proof_consistency.json` | 1037 | every `(size1, size2)` pair up to 40, selected large pairs, `proof.Consistency` node IDs, `VerifyConsistency` rejections |
| `api_hash_tile.json` | 19 | `HashTile` marshalling |
| `api_entry_bundle.json` | 18 | `EntryBundle` unmarshalling |
| `note.json` | 99 | `sumdb/note` keys, key hashing, `Sign`, `Open`, every rejection — asserted by `src/vendor/note/note_fixtures_test.ts` (95; the 4 `keys` rows are inputs, not assertions) |
| `checkpoint.json` | 52 | `formats/log` `Marshal`/`Unmarshal`, signed checkpoints, `ParseCheckpoint` — all 52 asserted by `src/vendor/formats/log/checkpoint_fixtures_test.ts`; `parse_fixtures_test.ts` also uses the 6 accepted cases |
| `ctonly.json` | 34 | `ctonly.Entry` marshalling |
| `log_{0,1,2,255,256,257,1000,5000}.json` | 64 files' worth of tiles + bundles | complete logs built by the real POSIX driver: every tile, every entry bundle, the signed checkpoint — asserted by `src/storage/internal/integrate_fixtures_test.ts` |

The full-log fixtures were the strongest evidence available and previously unclaimed; they are now
asserted end to end by `storage/internal/integrate_fixtures_test.ts`, which builds each size from
scratch via `integrate()` and separately resumes integration across the 255→256→257 tile boundary
(both pairwise and one entry at a time), checking the resulting tiles and root hash against the
fixture byte-for-byte. A future storage driver (Wave 4) can reuse the same fixtures the same way.

## Open items

- ~~There is no fixture generated from `internal/parse.CheckpointUnsafe`.~~
  **Cannot be generated.** `internal/parse` is under Tessera's `internal/`, so only packages under
  `github.com/transparency-dev/tessera/` may import it; the generator's module path is
  `github.com/diagnos-tech/webtessera/fixtures/gen` and the compiler rejects the import. Nothing exported
  by Tessera reaches `CheckpointUnsafe`. The three ways around it (squatting on upstream's module
  namespace, patching the pinned checkout, or copying the function into the generator) each destroy
  something the fixtures depend on. Reasoning and mitigation in
  `docs/notes/fixture-coverage-gaps.md` §8; `parse_fixtures_test.ts` cross-checking `checkpoint.json`
  on the accepted path, plus the ported `parse_test.go` table on the rejection path, is as far as
  this can go while the generator lives outside the Tessera tree.

- **Open:** `compact_range.json`'s six `errors` rows with `op: "appendRange"` cannot be driven
  from the fixture. `fixtures/gen/compact.go`'s `addAppendRangeErr(desc, lBegin, lEnd, rBegin, rEnd, …)`
  records only the **right** range's `begin`/`end`/`hashes`; the left range's bounds — which differ
  between cases (`0,3` for most, `0,5` for "overlapping ranges") and which the expected message text
  depends on ("ranges are disjoint: other.begin=3, want 5") — are not in the JSON.
  `range_fixtures_test.ts` therefore asserts only the `op: "newRange"` rows. The five `appendRange`
  error paths are covered by the ported `TestAppendRangeErrors` in `range_internal_test.ts`, so no
  assertion is missing; the fixture rows are simply unusable. Fix belongs in the fixtures work
  package: add `leftBegin`/`leftEnd` to `errorCase` and regenerate.

- ~~`src/vendor/note/` is BSD-3-Clause (ADR-0024) and its file headers point at a `LICENSE` file the
  package does not contain.~~ **Resolved at the repository level**, as ADR-0024 and ADR-0040
  anticipated: the verbatim Go licence text is `LICENSES/BSD-3-Clause-Go.txt` (with the Go patent
  grant beside it), and `NOTICE` lists every Go-derived file group — `src/vendor/note/`,
  `src/vendor/formats/note/` (ADR-0071) and the `cryptobyte.ts` / `list.ts` shims. What remains is
  mechanical: the older file headers still say "the LICENSE file", and should say
  `LICENSES/BSD-3-Clause-Go.txt`, as `AGENTS.md` §9 now prescribes.
