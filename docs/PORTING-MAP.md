# Porting map — Go → TypeScript

This is the file-by-file status of the port, and a reviewer's first stop. It covers **every one of
the 106 `.go` files** in upstream Tessera @ `4a6d9f9` (see `scripts/upstream.json`), whether or not
anyone has started on it, so that an omission is visible as a row rather than as an absence.

Regenerate the upstream list from the pinned checkout:

```sh
bun run upstream
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
| `pending ADR` | Inclusion is still being argued — see the rows of ADR-0001's register that are `pending` or `proposed`. **Nobody may act on these**; the decision comes first. Where an ADR already proposes a disposition (ADR-0141), `notes` says what it proposes and that it awaits review; the row stays `pending ADR` until that review is signed. |
| `not ported` | A decision was taken not to port it. The `notes` column must name the ADR. |

The **tests (TS/Go)** column counts individual test cases — a Go table-driven subtest and its
TypeScript `it()` each count as one — so `48 / 48` means every upstream case has a counterpart.
`—` means neither side has tests yet.

A status that cites an ADR is only as settled as that ADR. Under AGENTS.md §6 an ADR is not in force
until someone other than its author has reviewed it; the `Status:` line at the top of each file in
`docs/decisions/` says where it stands.

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
| `api/layout/paths.go` | `src/api/layout/paths.ts` | done | — | `Range` is a generator; `MaxUint64` overflow guard kept, and `Range` wraps its uint64 arithmetic as Go does, except in the one case where Go's own count wraps to a value no `number` can hold, which throws `RangeError` — ADR-0003, ADR-0014, ADR-0030, ADR-0031 |
| `api/layout/paths_test.go` | `src/api/layout/paths_test.ts` | done | 52 / 48 | 48 upstream cases + 4 port additions pinning `Range`'s uint64 wraparound against Go; fixtures in `paths_fixtures_test.ts`: `layout_paths` (2393 cases), `layout_parse` (99), `layout_range` (27) |
| `api/layout/tile.go` | `src/api/layout/tile.ts` | done | — | `nodeCoordsToTileAddress` returns a named object — ADR-0031; `partialTileSize` wraps its uint64 arithmetic as Go does — ADR-0014 |
| `api/layout/tile_test.go` | `src/api/layout/tile_test.ts` | done | 9 / 5 | 5 upstream cases + 4 port additions pinning `partialTileSize`'s uint64 wraparound; fixtures in `tile_fixtures_test.ts`: `layout_tile` (1007 cases). Upstream has no direct test for `PartialTileSize`; the fixture is its only direct coverage |
| `api/state.go` | `src/api/state.ts` | done | — | `HashTile`/`EntryBundle` as classes — ADR-0032; more than 256 hashes or entries is rejected, where Go accepts any number — ADR-0194 |
| `api/state_test.go` | `src/api/state_test.ts` | done | 17 / 12 | 12 upstream cases + 5 port additions: 3 pinning the rejection messages and 2 pinning the 256-element maxima (ADR-0194); benchmark not ported — ADR-0034. Fixtures in `state_fixtures_test.ts`: `api_hash_tile` (19), `api_entry_bundle` (18) |
| `append_lifecycle.go` | `src/append_lifecycle.ts` | done | — | root package; `withCheckpointAsyncSigner` is an addition for keys held by WebCrypto (ADR-0223; tests in `append_lifecycle_async_test.ts`); `AddFn`/`IndexFuture`/`Index` kept in place (ADR-0054) and the rest completed: `Appender`, `newAppender`, `memoizeFuture`, `terminator`, `AppendOptions` + all `with*`/accessors, `CheckpointPublisher`, `WitnessOptions`. OTel/klog dropped — ADR-0080; `integrationStats` and `followerStats`, which only fed the dropped metrics, are deleted — ADR-0181. Witness gateway wired — ADR-0082. Structural mappings (named multi-returns, `sync.Cond`/mutex drops, sync `newCP`) — ADR-0083; `shutdown` holds the terminator lock for its whole run, so an `add` during shutdown waits for it, as in Go. `Follower.follow` is started as a detached task — ADR-0180. Failing open publishes the log-signed checkpoint for any error other than an unmet policy — ADR-0183. `NewCertificateTransparencyAppender`/`withCTLayout` live in `ct_only.ts` — ADR-0130 |
| `append_lifecycle_test.go` | `src/append_lifecycle_test.ts` | done | 21 / 5 | TestMemoize + TestAppendOptionsValid ×4; 16 port additions: `memoizeFuture` caching, concurrency and a synchronous throw ×3, `valid()`'s Go-format durations, accessors ×2, `newAppender` (decoration order, adds after and during shutdown, detached followers, driver and option guards) ×6, and `checkpointPublisher` (snapshotting its options, failing open on a policy failure and on any other error, failing closed) ×4 |
| `await.go` | `src/await.ts` | done | — | root package; `sync.Cond` → broadcast/wait, klog dropped — ADR-0083, ADR-0080; `await` returns `[Index, Uint8Array]`, Go's nil checkpoint being held internally as an empty array — ADR-0004 |
| `await_test.go` | `src/await_test.ts` | done | 10 / 10 | TestAwait ×9 + TestAwait_multiClient; the multi-client bound is raised from Go's 1s to 15s (slower pure-JS ed25519 verify ×300) — ADR-0186; benchmark not ported — ADR-0034 |
| `client/client.go` | `src/client/client.ts` | done | — | OTel spans dropped — ADR-0061; fetcher-shaped types take `signal` last — ADR-0060; `ErrInconsistency.Wrapped` is `Error.cause`; `RWMutex`→`Mutex` for `update`, and `latest` returns the state from before an in-flight update where Go's `RLock` waits for it — ADR-0063; checkpoints are copied in and out of `LogStateTracker`, as Go's value semantics do; `update` also checks a checkpoint that is not newer and throws `ErrInconsistency` for a fork — ADR-0196; surplus tile hashes and bundle entries are rejected — ADR-0194; `nodeCache`/`tileKey` exported `@internal` (not in `client/index.ts`) — ADR-0010 pattern |
| `client/client_test.go` | `src/client/client_test.ts` | done | 20 / 10 | 10 upstream cases (TestCheckLogStateTracker ×4, TestNodeCacheHandlesInvalidRequest, TestHandleZeroRoot, TestGetEntryBundleAddressing ×2, TestNodeFetcherAddressing ×2) plus 10 port additions: the consistency-rejection path no upstream case reaches (ADR-0065), checkpoints that are not newer ×3 (ADR-0196), checkpoint copying, `fetchLeafHashes`'s uint64 wrap, and surplus entries and hashes ×4 (ADR-0194). Fixture: `client_log` (reads back upstream's static `testdata/log`, incl. its signing key) |
| `client/fetcher.go` | `src/client/fetcher.ts` | done | 35 / 0 | `HTTPFetcher` over `fetch`/`URL`; `FileFetcher` not ported — ADR-0064; no upstream test file, `src/client/fetcher_test.ts` is new; fetch called without a receiver, non-200 bodies cancelled — ADR-0131; credentials always omitted, and a `redirect` option (`follow` by default) — ADR-0197; response bodies read with a size cap — ADR-0195 |
| `client/otel.go` | — | not ported | — | ADR-0061; real OpenTelemetry SDK dependency out of scope (AGENTS.md §7) |
| `client/stream.go` | `src/client/stream.ts` | done | — | `iter.Seq2[T,error]` → `AsyncGenerator<T>`, errors thrown; bounded read-ahead is a sliding window of promises, not a channel/goroutine translation, and starts at the first `next()` where Go's producer starts at once — ADR-0066; `Range`'s `fromEntry+N` second argument kept verbatim (Port note in-file); a worker count below 1 throws `RangeError` — ADR-0192; `entries` rejects a bundle with too few entries — ADR-0194; uint64 wraparound as in Go — ADR-0014 |
| `client/stream_test.go` | `src/client/stream_test.ts` | done | 18 / 2 | `TestEntryBundles` (12345 and 100045 entries, `numWorkers=2`, growth mid-stream, a 60s explicit timeout) and `TestEntries`, ported on `testonly.newTestLog`; 16 port additions on the `log_1000`/`log_5000` fixtures: ordering, the `numWorkers` bound, error propagation, resuming across calls, `numWorkers` below 1 (ADR-0192), lazy start (ADR-0066), uint64 wraparound (ADR-0014) and short-bundle rejection (ADR-0194) |
| `cmd/conformance/aws/main.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row. Proposed: not ported — ADR-0141 (awaiting review); HTTP personality over the AWS driver (S3 + Aurora MySQL, optional persistent antispam) |
| `cmd/conformance/aws/otel.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row. Proposed: not ported — ADR-0141 (awaiting review); OpenTelemetry setup for that binary |
| `cmd/conformance/gcp/main.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row. Proposed: not ported — ADR-0141 (awaiting review); HTTP personality over the GCP driver (GCS + Spanner, optional persistent antispam) |
| `cmd/conformance/gcp/otel.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row. Proposed: not ported — ADR-0141 (awaiting review); OpenTelemetry setup for that binary |
| `cmd/conformance/mysql/main.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row. Proposed: not ported — ADR-0141 (awaiting review); HTTP personality over the MySQL driver |
| `cmd/conformance/posix/main.go` | — | pending ADR | — | ADR-0001 `cmd/conformance/*` row. Proposed: not ported — ADR-0141 (awaiting review); HTTP personality over the POSIX driver, optional Badger antispam. `examples/log-server` and `examples/edge` play the example-personality role |
| `cmd/examples/posix-oneshot/main.go` | — | pending ADR | — | ADR-0001 `cmd/examples/*` row. Proposed: not ported — ADR-0141 (awaiting review); command that adds files to a POSIX log and exits once they are integrated; the README snippets (`src/README_test.ts`, ADR-0140) show the same calls |
| `cmd/experimental/migrate/aws/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row. Proposed: not ported — ADR-0141 (awaiting review); command-line wrapper around `NewMigrationTarget`/`Migrate`, which are ported and tested end to end — ADR-0105 |
| `cmd/experimental/migrate/gcp/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row. Proposed: not ported — ADR-0141 (awaiting review); command-line wrapper around `NewMigrationTarget`/`Migrate`, which are ported and tested end to end — ADR-0105 |
| `cmd/experimental/migrate/mysql/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row. Proposed: not ported — ADR-0141 (awaiting review); command-line wrapper around `NewMigrationTarget`/`Migrate`, which are ported and tested end to end — ADR-0105 |
| `cmd/experimental/migrate/posix/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row. Proposed: not ported — ADR-0141 (awaiting review); command-line wrapper around `NewMigrationTarget`/`Migrate`, which are ported and tested end to end — ADR-0105 |
| `cmd/experimental/mirror/internal/mirror.go` | `src/mirror/mirror.ts` | done | 12 / 0 | published as `webtessera/mirror`; ported in Go order with its comments: `Target`, `Source`, `Mirror`, `jobs`, `calcNumResources`, `fetchAndParseCP`. Goroutine fan-out becomes a shared generator and `ErrGroup` — ADR-0077; `retry.Do`'s defaults reimplemented in `retry.ts` — ADR-0173. **Divergence:** a zero stride, which hangs upstream when the source is fewer entries ahead than there are workers, becomes one tile width — ADR-0173. No upstream test file; `mirror_test.ts` is new. Sinks, S3 and verification are additions, see `src/mirror/` below |
| `cmd/experimental/mirror/posix/main.go` | — | pending ADR | — | ADR-0001 `cmd/experimental/*` row. Proposed: not ported — ADR-0141 (awaiting review); the command that mirrors a tlog-tiles log into a POSIX directory. The library it wraps is ported (`src/mirror/mirror.ts`, ADR-0173), and its `posixTarget` is `newSinkTarget` over any `ObjectStore` or other sink — ADR-0175 |
| `cmd/fsck/internal/tui/app.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/main.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/tui/fsck_panel.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/tui/layerbar.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/tui/layerbar_test.go` | — | not ported | — | ADR-0093 |
| `cmd/fsck/tui/stats_view.go` | — | not ported | — | ADR-0093 |
| `ctonly/ct.go` | `src/ctonly/ct.ts` | done | 52 / 0 | no upstream test file; `src/ctonly/ct_test.ts` is new and fixture-backed — ADR-0043 |
| `ct_only.go` | `src/ct_only.ts` | done | — | root package; all ADR-0044 items closed: `newCertificateTransparencyAppender`; one overloaded `withCTLayout` for both `AppendOptions` and `MigrationOptions` — ADR-0130, ADR-0079; `identityHash`/`convertCTEntry` — ADR-0055, ADR-0059; test-only helpers not re-exported — ADR-0044 |
| `ct_only_test.go` | `src/ct_only_test.ts` | done | 40 / 12 | all 12 upstream cases + parser error paths, fixture cross-checks, `convertCTEntry`, `withCTLayout` on both receivers, antispam ordering, appender via a fake driver — ADR-0130 |
| `entry.go` | `src/entry.ts` | done | — | `Entry.internal` groups the fields Go keeps in an unexported struct, reachable the way Go's same-package visibility allows (used by `ct_only.ts`'s `convertCTEntry` — ADR-0059) — ADR-0010's pattern, no leading `_` needed since nesting avoids the accessor collision. `newEntry` throws for data over 65535 bytes, where Go silently truncates the length prefix — ADR-0182; a blank `Entry` throws from `marshalBundleData`, as Go's nil func call panics. `api/state_test.ts` stands in for the bundle encoding too — ADR-0036 |
| `entry_test.go` | `src/entry_test.ts` | done | 10 / 1 | the 1 upstream case plus 9 port additions pinning `newEntry`'s own defaults (identity, leaf hash, bundle encoding, no index until `marshalBundleData`), its 65535-byte limit (accepts 65535, rejects 65536) and the blank-`Entry` error, which the golden-fixture integration test in `storage/internal/integrate_fixtures_test.ts` depends on |
| `fsck/fsck.go` | `src/fsck/fsck.ts` | done | 27 / 4 | `Fetcher` ported as its own interface, not merged with client's fetcher-shaped types; `chan resource` → `ResourceQueue`, an async queue with **loop-level backpressure** (`waitUntilBelow`, `size`) replacing the bound a Go buffered channel gives for free — the queue's own buffer is unbounded (an async queue has no other way to represent "waiting to be pulled"), but `check()`'s bundle loop awaits `waitUntilBelow(resourceBackpressureThreshold(n), eg.signal)` between bundles, capping buffered resources at O(n) instead of O(logSize); see ADR-0091 §1's resolution note; `atomic.Uint64` counters → plain `bigint` fields; `compact.NodeID` map keys → string keys (ADR-0050 precedent); `uint8(256)` full-tile wraparound reproduced explicitly; `klog` dropped, `klog.Exitf` invariant guards → thrown `Error`s; `New` → `newFsck` (reserved word) — ADR-0091. A worker failure is reported as `failed: <err>` and never hangs, where Go hangs with one worker (ADR-0091 §8); `n` is 1 when unset or 0 and a negative or fractional value throws `RangeError` — ADR-0192; a bundle with too few or too many entries is rejected — ADR-0194. `fsckTree.visit` needs no ADR-0052-style sync-visitor/async-I/O workaround (it does no I/O) — ADR-0092 |
| `fsck/fsck_test.go` | `src/fsck/fsck_test.ts` | done | 27 / 4 | `TestTrimFullToPartial`'s 4 subtests ported verbatim, plus 23 new cases not part of upstream: `check()` on a real and on a corrupted log, worker-failure reporting at `n` = 1, 2 and 3 and the caller's own abort, `newFsck`'s `n` validation ×7, `appendBundle`'s uint64 wrap and size checks ×4, the `uint8(256)` wrap, and 5 on `ResourceQueue.waitUntilBelow` and backpressure — see the `fsck.go` row and file header |
| `fsck/status.go` | `src/fsck/status.ts` | done | — | `State` (Go `uint8` + `String()`) → `number` consts + standalone `stateString` (primitives can't carry methods); `rangeTracker`'s `mu *sync.Mutex` dropped (every method is synchronous, ADR-0004); `Range`/`rangeTracker` exported lowercase per ADR-0010 (touched directly by `status_test.ts`); backed by the new `src/internal/gostd/list.ts` — ADR-0090, ADR-0091 |
| `fsck/status_test.go` | `src/fsck/status_test.ts` | done | 12 / 10 | all 10 `TestUpdate` subtests, plus 2 new cases pinning `stateString`'s and `update`'s panic branches, neither covered upstream |
| `integration/fault/posix/fault_test.go` | — | pending ADR | — | ADR-0001 `integration/` row. Proposed: not ported — ADR-0141 (awaiting review); Linux-only: injects `EIO` and `SIGKILL` into `posix-oneshot` with `strace` and runs `fsck`; no fault-injection equivalent exists for the web backends, which the ADR states |
| `integration/integration_test.go` | — | pending ADR | — | ADR-0001 `integration/` row. Proposed: not ported — ADR-0141 (awaiting review); drives a running personality over HTTP, skipped without `-run_integration_test`; end-to-end coverage is `describeDriverConformance` on every backend |
| `internal/fetcher/fallback.go` | `src/internal/fetcher/fallback.ts` | done | — | `ctx` → trailing `signal` on `f` too — ADR-0060 |
| `internal/fetcher/fallback_test.go` | `src/internal/fetcher/fallback_test.ts` | done | 5 / 5 | |
| `internal/future/future.go` | `src/internal/future/future.ts` | done | 8 / 0 | no upstream test file, `future_test.ts` is new; ported ahead of the `client` package because `storage/internal/queue.ts` needs it directly; self-contained, nothing for `client` to reconcile. Native `Promise` instead of `WaitGroup`+fields, and a `null` error counts as success, as Go's nil does — ADR-0056 |
| `internal/hammer/hammer.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review); load-test command over HTTP |
| `internal/hammer/hammer_test.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review); tests the leaf generator |
| `internal/hammer/loadtest/analysis.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review); statistics |
| `internal/hammer/loadtest/analysis_test.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review) |
| `internal/hammer/loadtest/client.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review); round-robin reader/writer |
| `internal/hammer/loadtest/hammer.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review); read/write coordinator |
| `internal/hammer/loadtest/throttle.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review) |
| `internal/hammer/loadtest/tui.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review); terminal UI (`tview`/`tcell`), cf. ADR-0093 |
| `internal/hammer/loadtest/workerpool.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review) |
| `internal/hammer/loadtest/workers.go` | — | pending ADR | — | ADR-0001 `internal/hammer/` row. Proposed: not ported — ADR-0141 (awaiting review) |
| `internal/migrate/migrate.go` | `src/internal/migrate/migrate.ts` | done | — | `MigrationWriter` interface only, no upstream test file; ported alongside `migrate_lifecycle.ts` (which needs it to compile) rather than left blocking — ADR-0076 |
| `internal/otel/cast.go` | — | not ported | — | `Clamp64` only feeds OTel calls, all dropped; bigint cannot overflow — ADR-0134 |
| `internal/parse/parse.go` | `src/internal/parse/parse.ts` | done | — | returns a named object — ADR-0031; needs `gostd/bytes.splitN` and strict base64 — ADR-0035 |
| `internal/parse/parse_test.go` | `src/internal/parse/parse_test.ts` | done | 5 / 5 | benchmark not ported — ADR-0034. `parse_fixtures_test.ts` cross-checks against the `checkpoint` fixture; no fixture is generated from `CheckpointUnsafe` itself — see Open items |
| `internal/witness/otel.go` | — | not ported | — | metrics dropped, extending ADR-0051's precedent to this package — ADR-0070 |
| `internal/witness/witness.go` | `src/internal/witness/witness.ts` | done | — | `WitnessGateway`/`newWitnessGateway`, `ErrPolicyNotSatisfied`, `sharedConsistencyProofFetcher`, `witness`/`update` (HTTP via `FetchFn`, the same stand-in `client/fetcher.ts` uses for `*http.Client`). OTel/klog dropped — ADR-0070. Channel-based result fan-in becomes promise racing (no goroutine-leak equivalent) — ADR-0072. `errors.Join(ErrPolicyNotSatisfied, err)` + partial-checkpoint return becomes `PolicyNotSatisfiedError`, a `JoinError` that `errorIs` searches for the sentinel and each witness error — ADR-0075. Requests omit credentials and refuse redirects — ADR-0197; response bodies are capped — ADR-0195; a stale-size reply is retried at most three times — ADR-0198 |
| `internal/witness/witness_test.go` | `src/internal/witness/witness_test.ts` | done | 30 / 22 | all 6 Go test functions (`TestWitnessGateway_Update` ×8, `TestWitness_UpdateRequest` ×2, `TestWitness_UpdateResponse` ×6, `TestWitnessConflict` ×4, `TestWitnessStateEvolution`, `TestWitnessReusesProofs`) serving the `client_log` fixture instead of a real posix driver/appender — ADR-0193, the same judgement call as `client/stream_test.ts`; plus 8 port additions: the global `fetch` called without a receiver (ADR-0131), credentials omitted and redirects refused (a 3xx or an opaque redirect), the 16 KiB response cap, the three-retry cap, an unparsable URL, posting with an already-aborted signal as Go does, and `PolicyNotSatisfiedError` as a `JoinError` |
| `keygen/main.go` | — | not ported | — | **No such file in upstream @ `4a6d9f9`** (`git ls-tree` finds none; the pinned tree has 106 `.go` files), and no `keygen/` directory. Kept only because rows are never deleted; the row was a mistake and ADR-0141 proposes withdrawing ADR-0001's `keygen/` row. Key generation is `generateKey` in `webtessera/note` |
| `lifecycle.go` | `src/lifecycle.ts` | done | 9 / 0 | root package; `LogReader`/`Follower`/`Antispam` interfaces ported faithfully, the concrete `Appender`/antispam wiring lives in `append_lifecycle.ts`; `Follower.follow` is typed `void \| Promise<void>` because callers start it as a detached task — ADR-0180. `identityHash` exported here, closing ADR-0044's `ct_only.ts` TODO — ADR-0055. `defaultIDHasher`/`defaultMerkleLeafHasher` exported (Go-unexported, no upstream test) so `lifecycle_test.ts` can reach them directly; no upstream `lifecycle_test.go` |
| `log.go` | `src/log.ts` | done | 8 / 0 | root package; `ErrPushbackAntispam`/`ErrPushbackIntegration` built directly with `new Error(..., {cause})` rather than `wrapError`, since Go's `fmt.Errorf("antispam %w", ...)` has no colon before `%w` (Port note in-file). No upstream `log_test.go` |
| `migrate.go` | `src/migrate.ts` | done | 17 / 0 | root package; `copier`/`newCopier`/`bundle` keep Go's lowercase names and `populateWork` is a method of the copier, as in Go, all exported per ADR-0010's pattern. No upstream `migrate_test.go`; upstream exercises migration only through `integration/`. Here `src/storage/objectstore/driver_migration_test.ts` drives the whole lifecycle against Go-written `log_<N>` fixtures — ADR-0105, closing ADR-0074; 17 new cases cover `populateWork`'s chunking arithmetic and `copier.copy`'s worker orchestration and retry policy against in-memory fakes. `todo` channel + producer goroutine become a shared generator — ADR-0077. `cenkalti/backoff` hand-rolled to follow v5.0.3's `Retry` step for step, including its 15-minute elapsed-time bound — ADR-0073. OTel/klog dropped — ADR-0070 |
| `migrate_lifecycle.go` | `src/migrate_lifecycle.ts` | done | 10 / 0 | root package; `newMigrationTarget`, `MigrationOptions` (fields grouped under `internal`, mirroring `Entry.internal` — closes `ct_only.ts`'s `WithCTLayout` TODO, ADR-0079; `withAntispam(null)` is a no-op, as Go's nil is), `MigrationTarget`/`migrate`, `awaitFollower`. No upstream test file; end-to-end coverage is in `src/storage/objectstore/driver_migration_test.ts` (ADR-0105, closing ADR-0074), except the `withAntispam` path, which has no persistent `Antispam` to drive it; 10 new cases cover `awaitFollower`'s polling loop, `MigrationOptions`'s defaults and `withAntispam`, `newMigrationTarget`'s driver-rejection path and its detached followers. The periodic "Progress: ..." printer goroutine is dropped (klog-only effect) — ADR-0070 — and so is `progress`, its only caller — ADR-0181 |
| `otel.go` | `src/otel.ts` | not ported | — | root package; real OpenTelemetry SDK dependency out of scope (AGENTS.md §7). Its tracer/meter and the append-lifecycle metric setup are dropped from `append_lifecycle.ts`/`await.ts`/`antispam.ts` — ADR-0080 (following ADR-0051/0061) |
| `README_test.go` | `src/README_test.ts` | done | 6 / 2 | upstream regions kept, memory driver for posix, extra regions for signer/publication/verification/IndexedDB/SQLite; README.md checked by `src/README_sync_test.ts` — ADR-0140, resolves ADR-0058 |
| `storage/aws/antispam/aws.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review); persistent antispam in a MySQL table |
| `storage/aws/antispam/aws_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review) |
| `storage/aws/aws.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review); S3 + MySQL (Aurora) driver |
| `storage/aws/aws_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review) |
| `storage/aws/otel.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review); OpenTelemetry keys |
| `storage/gcp/antispam/gcp.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review); persistent antispam in Spanner tables |
| `storage/gcp/antispam/gcp_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review) |
| `storage/gcp/antispam/otel.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review); OpenTelemetry keys |
| `storage/gcp/gcp.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review); GCS + Spanner driver |
| `storage/gcp/gcp_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review) |
| `storage/gcp/otel.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review); OpenTelemetry keys |
| `storage/internal/integrate.go` | `src/storage/internal/integrate.ts` | done | — | the Merkle tree-building engine every storage driver calls into. `TileID`/`compact.NodeID`-keyed Go maps become string-keyed `Map`s — ADR-0050. OTel/klog dropped — ADR-0051. `tileWriteCache`'s visitor is synchronous, so the tile reads it would make are done up front, in Go's order, and replayed to it — ADR-0190 (supersedes ADR-0052). Go's panics are `panicError`s that no wrapper rewraps; a tile with a gap is rejected where Go writes it short — ADR-0191. `errors.Join` ported as `joinErrors` — ADR-0057. `treeBuilder`/`tileWriteCache`/`populatedTile` exported (Go-unexported) so `integrate_test.ts` can reach them, mirroring ADR-0044's pattern |
| `storage/internal/integrate_test.go` | `src/storage/internal/integrate_test.ts` | done | 10 / 3 | `TestNewRangeFetchesTiles`, `TestTileVisit` (every visit permutation), `TestIntegrate` (200,000-entry test given an explicit 120s timeout — bigint + async-per-chunk overhead the Go original doesn't pay, Port note in-file); benchmark not ported — ADR-0034; plus 7 port additions: Go's exact `getTiles` call log for 0→255→256→257→557, extending a tile a crashed integration left behind, a failing read retried on every visit with the errors joined, three Go panic sites (a 257th leaf, no tile returned for a single read, too many tiles returned for `Prewarm`), and a `getTiles` failure wrapped with `cause` set, matching Go's `%w`. Golden fixtures in `integrate_fixtures_test.ts`: 11 cases across all 8 `log_<N>` sizes plus 255→256→257 boundary-crossing resumption — the strongest proof in this package, claims the previously-unclaimed `log_<N>.json` fixtures |
| `storage/internal/otel.go` | — | not ported | — | tracer + attribute keys; spans dropped — ADR-0051, ADR-0134 |
| `storage/internal/queue.go` | `src/storage/internal/queue.ts` | done | — | buffered channel + worker goroutine become an unbounded array drained by an async loop, since `add()` must stay synchronous and JS cannot block a synchronous caller the way Go blocks a goroutine on a full channel — ADR-0053; when storage reports a logic error, every pending future is settled with it. Mutexes in `add()`/`flush()` dropped (synchronous critical sections, ADR-0004) |
| `storage/internal/queue_test.go` | `src/storage/internal/queue_test.ts` | done | 13 / 6 | `TestQueue` (3 cases) + `TestNotify` (3 cases) ported with matching values, plus 7 port additions (maxSize-triggered flush, maxAge-triggered flush, FIFO order across a multi-batch flush, every item processed exactly once when adds interleave with an in-flight flush, a logic error settling every pending future, an aborted signal stopping the flushes, add() does not resolve before a flush). Benchmark not ported — ADR-0034 |
| `storage/internal/tileid.go` | `src/storage/internal/tileid.ts` | done | 8 / 0 | `TileID` is a 2-field value type, no upstream `tileid_test.go`; `tileIDKey` added for use as a `Map` key — ADR-0050 |
| `storage/mysql/mysql.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review); MySQL-only driver |
| `storage/mysql/mysql_test.go` | — | pending ADR | — | ADR-0001 cloud-driver row. Proposed: not ported — ADR-0141 (awaiting review) |
| `storage/posix/antispam/badger.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row. Proposed: not ported — ADR-0141 (awaiting review); persistent antispam in Badger, an embedded key-value database on a local directory |
| `storage/posix/antispam/badger_test.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row. Proposed: not ported — ADR-0141 (awaiting review) |
| `storage/posix/antispam/otel.go` | — | pending ADR | — | ADR-0001 `storage/posix/` row. Proposed: not ported — ADR-0141 (awaiting review); OpenTelemetry keys |
| `storage/posix/file_ops.go` | — | not ported | — | atomic, durable file writes (temp file, link/rename, directory `fsync`); the crash-safety contract is carried by the `ObjectStore` atomicity and durability requirements in `src/storage/objectstore/objectstore.ts`, which every backend must meet — ADR-0100 (argued in ADR-0141 §1) |
| `storage/posix/files.go` | `src/storage/objectstore/driver.ts` | done | — | ported onto the `ObjectStore` contract instead of a filesystem — ADR-0100–0104. Compared byte for byte with Go-written `log_<N>` fixtures by the golden suite — ADR-0106, ADR-0160. `publishCheckpoint` refuses to publish a checkpoint that does not parse and commit to exactly the size and root requested, and `initialise` refuses to start a new tree when `.state/treeState` is missing but a checkpoint is already published — ADR-0205 |
| `storage/posix/files_test.go` | `src/storage/objectstore/driver_test.ts` | done | 51 / 12 | `TestGarbageCollect`, `TestGarbageCollectOption` ×3 and `TestPublishTree` ×8 with Go's values (its fake publisher writes the root as base64, so that it parses — ADR-0205), on `MemoryObjectStore`, plus 39 driver-internal cases (version file, tree-state errors, lock naming and wrapping, fetch defaulting, partial-resource fallback, GC limit, tile widths, migration bounds, checkpoint-publication and initialisation refusals) — ADR-0106 |
| `storage/posix/otel.go` | — | not ported | — | histogram of POSIX operation durations; instrumentation dropped as elsewhere — ADR-0100, ADR-0051 |
| `storage/storage_test.go` | `src/storage/storage_test.ts` | done | 26 / 1 | `TestForbiddenFunction` via Vite glob + TypeScript AST — ADR-0132 |
| `testonly/testlog.go` | `src/testonly/testlog.ts` | done | — | memory driver in place of a POSIX temp dir; published as `webtessera/testonly` — ADR-0140 |
| `witness.go` | `src/witness.ts` | done | — | root package; policy DSL (`newWitnessGroupFromPolicy`, `keywords`/`isBadName`), `newWitness`/`Witness`, `newWitnessGroup`/`WitnessGroup`. `url.URL.JoinPath` has no platform equivalent, reimplemented narrowly, and policy URLs are kept as written — ADR-0078. `%w` errors keep their cause, white space and fields split as Go's `strings` does, and the 64 KiB line limit of `bufio.Scanner` is reproduced. Depends on a narrow vendor port of `formats/note`'s cosignature/v1 — ADR-0071, ADR-0174. Hardening with no Go counterpart: a policy rejects a group naming a child twice, one key under two witness names, and a threshold of 0 — ADR-0184; witness URLs must be `https`, or `http` to a loopback host — ADR-0185 |
| `witness_policy_test.go` | `src/witness_policy_test.ts` | done | 47 / 11 | `TestNewWitnessGroupFromPolicy` ×2, `TestNewWitnessGroupFromPolicy_GroupN` ×3, `TestNewWitnessGroupFromPolicy_Errors` ×6; 36 port additions: white space, line length, wrapped errors, URLs kept as written, the ambiguous-quorum rejections (ADR-0184) and the URL schemes (ADR-0185). Upstream's group tests gave two witnesses one key; `w3` uses the `Wit3` key from `witness_test.go` (Port note in-file) |
| `witness_test.go` | `src/witness_test.ts` | done | 27 / 18 | `TestWitnessGroup_Empty`, `TestWitnessGroup_Satisfied` ×12, `TestWitnessGroup_URLs` ×5, plus 9 port additions on `newWitness`: a fragment kept after the joined path, and the URL schemes it accepts and rejects (ADR-0185). `BenchmarkWitnessGroupSatisfaction` not ported — ADR-0034. The file's header carries no Tessera copyright line, because upstream's has none — ADR-0187 |

---

## Beyond the upstream files

Categories of file exist in `src/` with no row above, because they have no counterpart in the
Tessera repository. Add tables here as they land.

- **`src/vendor/`** — ports of Tessera's Go dependencies (`transparency-dev/merkle`,
  `transparency-dev/formats`, `golang.org/x/mod/sumdb/note`). Their upstreams and versions are listed
  in `AGENTS.md` §1. ADR-0002 explains why they live under `src/vendor/`.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | `golang.org/x/mod/sumdb/note/note.go` | `src/vendor/note/note.ts` | done | — | **BSD-3-Clause, not Apache-2.0** — ADR-0024. Error shape — ADR-0021. Optional signature lists and the `io.Reader` for randomness — ADR-0023. `verifyEd25519` transcribes Go's `ed25519.Verify` and `verifyWithDom`, so it accepts and rejects what Go does; `newVerifier` refuses small-order and non-canonical public keys, which Go accepts, and `checkEd25519PublicKey` is exported for the cosignature/v1 verifier — ADR-0206 (supersedes ADR-0025). Addition with no Go counterpart: `AsyncSigner` and `signAsync`, which delegates to the unchanged `sign` — ADR-0223 (tests in `note_async_test.ts`) |
  | `golang.org/x/mod/sumdb/note/note_test.go` | `src/vendor/note/note_test.ts` | done | 16 / 7 | 7 upstream tests + 9 port additions: signing non-ASCII text and a non-ASCII signer name (both asserted against Go's literal output), Go's verdicts on the audit's pinned Ed25519 vectors, the refusal of small-order and non-canonical verifier keys and the acceptance of what Go accepts, verifier, signer and `open` edge cases pinned to Go's errors, and a regression that rejects a cofactored-only signature Go rejects (ADR-0206). `BenchmarkOpen` not ported — ADR-0034 |
  | `golang.org/x/mod/sumdb/note/example_test.go` | `src/vendor/note/example_test.ts` | done | 4 / 3 | Go testable examples become assertion tests — ADR-0033. The extra case derives `EnochRoot`'s published verifier key from an all-zero seed |
  | `github.com/transparency-dev/formats/log/checkpoint.go` | `src/vendor/formats/log/checkpoint.ts` | done | — | `Checkpoint` is a class so the upstream test's embedded `moonLogCheckpoint` ports as a subclass — ADR-0032. `size` is `bigint` — ADR-0003, and a size outside the uint64 range throws — ADR-0207. Absent trailing data is `undefined`, mirroring Go's nil. An origin that is not valid UTF-8 is rejected by `unmarshal` and `marshal` — ADR-0203 |
  | `github.com/transparency-dev/formats/log/checkpoint_test.go` | `src/vendor/formats/log/checkpoint_test.ts` | done | 21 / 16 | 16 upstream cases + 5 port additions: marshalling and round-tripping a non-ASCII origin at `MaxUint64` (asserted against Go's literal output), and the rejection of an invalid-UTF-8 origin, of an origin UTF-8 cannot encode and of a size outside the uint64 range (ADR-0203, ADR-0207) |
  | `github.com/transparency-dev/formats/log/identifier.go` | `src/vendor/formats/log/identifier.ts` | done | — | |
  | `github.com/transparency-dev/formats/log/identifier_test.go` | `src/vendor/formats/log/identifier_test.ts` | done | 7 / 6 | 6 upstream cases + 1 pinning UTF-8 hashing of a non-ASCII origin |
  | `github.com/transparency-dev/formats/log/note.go` | `src/vendor/formats/log/note.ts` | done | — | `parseCheckpoint` returns a result object and throws `ParseCheckpointError`, which carries the note — ADR-0022. It rejects a root hash that is not 32 bytes — ADR-0202 — and adds its context only to errors the port returns, not to programming errors — ADR-0209 |
  | `github.com/transparency-dev/formats/log/note_test.go` | `src/vendor/formats/log/note_test.ts` | done | 17 / 14 | 14 upstream cases (includes a real `sum.golang.org` checkpoint) + 3 port additions: the 32-byte root rule, its precedence after the origin check, and the error wrapping (ADR-0202, ADR-0209). One upstream input carries a port note: `"abcdef"` is padded to 32 bytes. `BenchmarkParse`/`BenchmarkLotsOfIDs` not ported — ADR-0034 |
  | — | `src/vendor/formats/log/index.ts` | done | — | barrel for `webtessera/formats/log`; no Go counterpart, the package is the unit of import in Go |
  | `github.com/transparency-dev/formats/proof/tlog_proof.go` (v0.1.1) | `src/vendor/formats/proof/tlog_proof.ts` | done | — | `TLogProof` and its C2SP tlog-proof encoding, for the safe API's receipts — ADR-0224, ADR-0225 |
  | `github.com/transparency-dev/formats/proof/tlog_proof_test.go` (v0.1.1) | `src/vendor/formats/proof/tlog_proof_test.ts` | done | 34 / 14 | every upstream case, plus vectors recorded from Go v0.1.1 |
  | — | `src/vendor/formats/proof/index.ts` | done | — | barrel for `webtessera/formats/proof` |

  ### `github.com/transparency-dev/formats/note` @ `v0.0.0-20251017110053-404c0d5b696c`

  New dependency, discovered while porting `witness.go` (`NewWitness` calls
  `f_note.NewVerifierForCosignatureV1`). Scoped to `note_cosigv1.go`, the one file of the package that
  `witness.go` and the witness server call — ADR-0071, ADR-0174.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | `note_cosigv1.go` | `src/vendor/formats/note/note_cosigv1.ts` | done | — | `NewSignerForCosignatureV1`, `NewVerifierForCosignatureV1`, `VKeyToCosignatureV1` and `CoSigV1Timestamp` ported; the last returns the timestamp as `bigint` seconds, because a `Date` cannot hold every int64 — ADR-0071, ADR-0174. `newVerifierForCosignatureV1` refuses small-order and non-canonical keys, as `newVerifier` does — ADR-0206. BSD-3-Clause, like `src/vendor/note/` (ADR-0024). Re-exported by `webtessera/witness` |
  | `note_cosigv1_test.go` | `src/vendor/formats/note/note_cosigv1_test.ts` | done | 30 / 15 | all 7 upstream test functions (15 cases: `TestSignerRoundtrip`, `TestSignerVerifierRoundtrip`, `TestVerifierInvalidSig`, `TestSigCoversExtensionLines`, `TestCoSigV1NewVerifier` ×7, `TestCoSigV1Timestamp` ×3, `TestVKeyToCosignatureV1`); `TestCoSigV1NewVerifier`'s rows run against `newVerifierForCosignatureV1`, since upstream calls the unported `NewVerifier` dispatcher. 15 port additions: the key-hash field is only length-checked ×2, the timestamp field over the full int64 range ×6, a well-formed but cryptographically invalid cosignature, the three-line boundary, and the refusal of unsafe Ed25519 keys ×5 — ADR-0071, ADR-0174, ADR-0206 |
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
  | `compact/nodes.go` | `compact/nodes.ts` | done | — | `NodeID` is a class so Go's methods stay methods; `Coverage` wraps at 2^64 — ADR-0014; the constructor, `rangeNodes` and `rangeSize` reject values outside the uint64 range — ADR-0207. `rangeNodes` always reallocates — ADR-0013 |
  | `compact/nodes_test.go` | `compact/nodes_test.ts` | done | 33 / 31 | `TestGenRangeNodes` runs all 131k `(begin,end)` pairs; equality is computed directly and `expect` only reports the mismatch, else `toEqual` dominates the runtime. +2 port additions: the uint64 domain guards — ADR-0207 |
  | `compact/range.go` | `compact/range.ts` | done | — | `Range` fields are `_`-prefixed `@internal` — ADR-0010. uint64 wrapping in `getMergePath`/`decompose` — ADR-0014; bounds outside the uint64 range are rejected — ADR-0207. Errors thrown with upstream's message text — AGENTS.md §3.6 |
  | `compact/range_test.go` | `compact/range_test.ts` | done | 479 / 476 | mirrors Go's external `compact_test` package. +1: Go's trailing "GetRootHash accepts only [0,N)" assertion is a statement inside `TestGetRootHash`, here its own `it`; +2: the uint64 domain guards — ADR-0207. `TestMergeRandomly` uses a seeded PRNG — ADR-0012. `BenchmarkAppend` not ported — ADR-0034 |
  | `compact/range_internal_test.go` | `compact/range_internal_test.ts` | done | 27 / 27 | mirrors Go's in-package test; touches `Range._begin`/`._end` and `getMergePath` — ADR-0010 |
  | `compact/node_fuzz_test.go` | — | not ported | — | fuzz target; properties covered by `TestGenRangeNodes` + fixtures — ADR-0015 |
  | — | `compact/index.ts` | done | — | barrel; re-exports exactly Go's exported surface, with `Range` as a type only (its fields are unexported in Go) — ADR-0010, ADR-0208 |
  | `proof/proof.go` | `proof/proof.ts` | done | — | `Nodes.IDs` → `.ids`; `begin`/`end`/`ephem` → `_begin`/`_end`/`_ephem` — ADR-0010. `reverse` takes an explicit offset; `rehash` keeps its in-place contract — ADR-0013 |
  | `proof/proof_test.go` | `proof/proof_test.ts` | done | 73 / 71 | Go's `inclusion(t, …)` helper is dropped: the port's `inclusion` already throws, so the wrapper had nothing to do. +2: the uint64 domain guards — ADR-0207 |
  | `proof/verify.go` | `proof/verify.ts` | done | — | `RootMismatchError` renders bytes with Go's `%v` (`[1 2 3]`) so the message text matches. `size2 < size1`'s swapped format arguments kept verbatim. Every proof hash and root must be exactly the hasher's size, checked after upstream's own checks so that upstream's errors keep precedence — ADR-0202; sizes and indices outside the uint64 range are rejected — ADR-0207 |
  | `proof/verify_test.go` | `proof/verify_test.ts` | done | 40 / 31 | probe construction wraps uint64 explicitly (`leafIndex - 1` at index 0 is `MaxUint64` upstream) — ADR-0014. +9 port additions: hash sizes of proofs and roots ×7 (ADR-0202) and the uint64 domain guards ×2 (ADR-0207). `TestVerifyConsistency`'s "don't care" roots are hashed to 32 bytes (Port note in-file) |
  | — | `proof/index.ts` | done | — | barrel; re-exports exactly Go's exported surface, with `Nodes` as a type only and `LogHasher` (Go's root `merkle` package) re-exported as a type — ADR-0010, ADR-0208 |
  | `testonly/tree.go` | `testonly/tree.ts` | done | — | the independent reference implementation upstream cross-checks against; `New` → constructor — ADR-0011 |
  | `testonly/tree_test.go` | `testonly/tree_test.ts` | done | 72 / 70 | +2: Go's `validateTree(mt, 8)` and `ConsistencyProof(6,3)` rejection are statements inside `TestTreeConsistencyProof`, here their own `it`s. `TestTreeConsistencyProofFuzz` uses a seeded PRNG — ADR-0012 |
  | `testonly/constants.go` | `testonly/constants.ts` | done | — | pure data; no upstream test file |
  | `testonly/reference_test.go` | `testonly/reference.ts` + `testonly/reference_test.ts` | done | 12 / 12 | split in two: importing one `*_test.ts` from another double-registers its suites — ADR-0010 |
  | `testonly/tree_fuzz_test.go` | — | not ported | — | fuzz targets; properties covered by the ported tests + fixtures — ADR-0015 |

  Not ported and not listed above, because they are Go-toolchain artefacts with no counterpart:
  `go.mod`, `go.sum`, `.clusterfuzzlite/`, `testdata/FuzzRangeNodes/` (ADR-0015), `scripts/`.
- **`src/internal/gostd/`** — shims for the parts of the Go standard library the port relies on
  (`bytes`, `errors`, `strconv`, `strings`, `sync`, `bits`, …). Not Tessera logic. `api/layout`
  needed `bytes.splitN` and a `bytes.fromBase64` held to Go's strictness — ADR-0035; the `note` port
  then rewrote `fromBase64` as a transcription of Go's `decodeQuantum` so its error offsets match
  Go's too, and added `strconv.ts`, `unicode.ts`, `strings.ts` and `io.ts` — ADR-0020. Later work made
  `parseUint`, `quote` and the hex decoder transcriptions of Go's as well — ADR-0204. Files that are
  derived from Go's own code, wholly or in part, say so in their headers and are listed in `NOTICE`.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | `strconv.ParseUint`, `strconv.Quote` | `src/internal/gostd/strconv.ts` | done | 61 / — | `parseUint` is a line-by-line port of Go 1.25.5's: base 0, underscores, `NumError` with `ErrSyntax`/`ErrRange` as sentinels, an input quoted in an error cut at 64 characters, and time linear in the input — ADR-0204. `quote` uses Go's own `IsPrint` tables (Unicode 15.0.0), not the engine's — ADR-0020, ADR-0204. Mixed provenance: see `NOTICE` |
  | `unicode.IsSpace`, `utf8.Valid`, `utf8.ValidString` | `src/internal/gostd/unicode.ts` | done | 32 / — | `isSpace` is written out because `/\s/` differs from Unicode White_Space at U+0085 and U+FEFF — ADR-0020; mixed provenance (see `NOTICE`) |
  | `bufio.Scanner` (`ScanLines`) | `src/internal/gostd/bufio.ts` | done | 14 / — | the line scanner `formats/proof` needs, with Go's 64 KiB token limit and error text — ADR-0224 |
  | `strings.Cut`, `strings.TrimSpace`, `strings.Fields` | `src/internal/gostd/strings.ts` | done | 39 / — | cases from Go's `TestCut` (8), `TestTrimSpace` (9) and `TestFields` (14), plus 1 pinning how `open` splits a signature line and 7 at the code points where `String.prototype.trim` and `/\s/` differ from Go; `trimSpace` and `fields`, added for the policy parser in `witness.ts`, use Go's white-space set, which `String.prototype.trim` does not; they have no ADR of their own yet. `cut` — ADR-0020. Mixed provenance: see `NOTICE` |
  | `io.Reader`, `io.ReadFull` | `src/internal/gostd/io.ts` | done | 8 / — | needed by `note.generateKey` — ADR-0020, ADR-0023 |
  | `base64.StdEncoding.DecodeString`, `hex.DecodeString`, big-endian appenders | `src/internal/gostd/bytes.ts` | done | 71 / — | 3 byte helpers, 8 helper cases, 8 `splitN` cases, 13 hex and 39 base64 cases. Both decoders are transcriptions of Go's (base64's `decodeQuantum`, hex's `Decode`), with accept/reject vectors and byte offsets taken from Go 1.25.5 — ADR-0020, refines ADR-0035. `appendUint16BE`/`32BE`/`64BE` throw for a value outside their Go type instead of truncating — ADR-0200. Mixed provenance: see `NOTICE` |
  | `golang.org/x/crypto/cryptobyte/{builder,string}.go` | `src/internal/gostd/cryptobyte.ts` | done | 47 / 19 | BSD-3-Clause, not Apache-2.0. 19 of upstream's 23 tests ported; the 4 ASN.1 and fixed-builder ones go with the code that is not ported — ADR-0040. Buffer model — ADR-0041. Error and out-parameter shape, and a nil `String` that fails every read — ADR-0042. |
  | `golang.org/x/crypto/cryptobyte/example_test.go` | `src/internal/gostd/cryptobyte_example_test.ts` | done | 4 / 4 | BSD-3-Clause, not Apache-2.0. The 4 length-prefix and error-handling Examples become assertion tests — ADR-0033; the 2 ASN.1 Examples go with the ASN.1 code — ADR-0040 |
  | `golang.org/x/crypto/cryptobyte/asn1.go` | — | not ported | — | no Tessera caller — ADR-0040 |
  | `math/bits` (uint64 intrinsics) | `src/internal/gostd/bits.ts` | done | 26 / — | `trailingZeros64`, `len64`, `onesCount64` plus `asUint64`/`shiftLeft64`/`shiftRight64` for Go's uint64 wrapping and shift saturation — ADR-0014 — and `assertUint64`, the guard the exported uint64 entry points use — ADR-0207. Every compact/proof bit operation goes through it. Mixed provenance: see `NOTICE` |
  | `math/rand` (test use only) | `src/internal/gostd/rand.ts` | done | 4 / — | seeded splitmix64, deliberately not bit-compatible with Go — ADR-0012; `rand_test.ts` pins it to the reference implementation's published outputs. No production code imports it |
  | `container/list` | `src/internal/gostd/list.ts` | done | 10 / 10 | BSD-3-Clause, not Apache-2.0 (Go standard library itself, not just a dependency — same open item as `cryptobyte.ts`). `Element<T>`/`List<T>` generic instead of Go's pre-generics `any`; `New` → `newList` (reserved word; it sits above the class, since a class body cannot be interleaved with functions); `_root`/`_next`/`_prev`/`_list` are `_`-prefixed per ADR-0010 (cross-class access + `list_test.ts`'s direct field reads), `#len` stays genuinely private — ADR-0090. Added for `fsck/status.go`'s `rangeTracker` |
  | `errors.Is`/`As`/`Join`, `fmt.Errorf("%w")`, `os.ErrNotExist`, context cancellation checks | `src/internal/gostd/errors.ts` | done | 31 / — | `SentinelError`, `ErrNotExist`, `wrapError`, `errorIs`, `errorAs`, `joinErrors`/`JoinError`, `throwIfAborted`. `errorIs` and `errorAs` walk `JoinError.errors` depth-first, as Go does; `joinErrors` follows Go 1.25.5's rule for a single argument that already is a join. Errors are thrown with upstream's message text — ADR-0004, ADR-0057, AGENTS.md §3.6 |
  | `sync.Mutex`/`WaitGroup`/`Once`, `errgroup.Group`, `time.Ticker`, `time.Sleep` | `src/internal/gostd/sync.ts` | done | 42 / — | `Mutex` only where a critical section spans an `await`; a synchronous one is dropped with a Port note — ADR-0004. `ErrGroup` never runs more tasks than its limit, aborts its signal when `wait()` returns, and follows `setLimit`'s rules; `Once` memoises a synchronous throw; `ticker` keeps a fixed schedule and drops missed ticks — ADR-0004 |

- **`src/index.ts` and `src/testonly/`** — the package root and the test helpers published beside it. In Go the
  package is the unit of import, so neither has a file counterpart.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/index.ts` | done | — | package root barrel: re-exports by name the 37 identifiers Tessera's root package exports, under ADR-0002's names; identifiers the port exports only so its tests can reach them are not re-exported — ADR-0133 |
  | — | `src/index_test.ts` | done | 33 / — | no upstream test file; pins the barrel's runtime and type surface and checks it against the identifiers Go's root package exports — ADR-0133 |
  | — | `src/testonly/index.ts` | done | — | barrel for `webtessera/testonly` (`newTestLog`); the fixture loader below is deliberately not exported — ADR-0140 |
  | — | `src/testonly/testlog_test.ts` | done | 2 / — | no upstream test file; pins what a caller of `newTestLog` relies on: append, publish a checkpoint signed by `sigVerifier`, shut down, and a fresh store and key per log — ADR-0140 |
  | — | `src/testonly/fixtures.ts` | done | — | loader for `fixtures/data/*.json`: hex bytes, decimal `uint64` strings decoded to `bigint`, strict decoders. This repository's own test support — ADR-0006 |
  | — | `src/testonly/fixtures_test.ts` | done | 13 / — | the loader's decoders, rejections and header handling |

- **`src/README_sync_test.ts`** — a check upstream leaves as a TODO.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/README_sync_test.ts` | done | 9 / — | every fenced block in `README.md` tagged `file=<path> region=<name>` must equal that region of that file, so the README's snippets cannot drift from the code that is run as `src/README_test.ts` — ADR-0140 |

- **`src/storage/objectstore/`** — the web storage engine: the `ObjectStore` contract, and the helpers and
  suites around the driver ported from `storage/posix` (`driver.ts` and `driver_test.ts` have rows in the
  main table). Every backend below implements nothing but this contract. ADR-0100.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/storage/objectstore/objectstore.ts` | done | — | the `ObjectStore` contract: `get`, `stat`, `put`, `create`, `deletePrefix`, `lock`. Its atomicity and durability requirements are what carries `file_ops.go`'s crash-safety contract to each backend — ADR-0100, ADR-0103 |
  | — | `src/storage/objectstore/index.ts` | done | — | barrel for `webtessera/storage/objectstore`; names chosen for a flat TypeScript namespace — ADR-0104 |
  | — | `src/storage/objectstore/json.ts` | done | — | the `.state/treeState` and `.state/gcState` files encoded byte for byte as Go's `encoding/json` writes them, decoded strictly, `uint64` as `bigint` — ADR-0102 |
  | — | `src/storage/objectstore/json_test.ts` | done | 34 / — | no upstream test file; vectors recorded from Go 1.24's `encoding/json`: inputs Go accepts, inputs Go rejects, inputs only this decoder rejects — ADR-0102 |
  | — | `src/storage/objectstore/namedlocks.ts` | done | — | `NamedLocks`: the in-process half of `ObjectStore.lock` (exclusive locks by name, in arrival order, abandoned waiters leave the queue), used by the memory backend, by IndexedDB's single-writer mode and by the SQLite backend's local locking, and exported so a custom store can reuse it — ADR-0142 |
  | — | `src/storage/objectstore/namedlocks_test.ts` | done | 4 / — | no upstream test file; arrival order, handing the lock past a waiter that gave up, no state kept for idle names, `fn` not run when the signal is already aborted — ADR-0142 |
  | — | `src/storage/objectstore/testing/conformance.ts` | done | — | `describeObjectStoreConformance`: the 19 contract cases every backend runs. Test-only, excluded from the published build — ADR-0100 |
  | — | `src/storage/objectstore/testing/driver_conformance.ts` | done | — | `describeDriverConformance`: 10 end-to-end cases (sequencing, publication, proofs from served tiles, restart, shared store, garbage collection, migration, shutdown) run on every backend. Test-only — ADR-0106 |
  | — | `src/storage/objectstore/driver_fixtures_test.ts` | done | 25 / — | the golden suite on the memory backend: the driver against the Go-written `log_<N>` fixtures — the same paths and bytes, in one batch, in batches of 37 with garbage collection, across restarts, and resuming Go-written state — ADR-0106, ADR-0160 |
  | — | `src/storage/objectstore/testing/golden.ts` (with `golden_fixtures.ts`, `golden_log.ts`) | done | — | `describeGoldenCompatibility`: the golden suite, 25 cases per backend (8 fixture sizes, and the cases above) that every backend runs in every runtime it supports. Derived from the fixtures and the tlog-tiles layout rules, never from the driver under test. Test-only — ADR-0160, ADR-0161 |
  | — | `src/storage/objectstore/driver_migration_test.ts` | done | 7 / — | the migration lifecycle end to end against Go-written source logs — ADR-0105 (closes ADR-0074) |

- **`src/storage/memory/`** — the in-memory backend, the browser's counterpart of `storage/posix` and the
  reference backend for the suites. ADR-0104.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/storage/memory/memory.ts` | done | — | `MemoryObjectStore` (with `keys()`, outside the contract; locks through `NamedLocks`) and `newMemoryDriver` — ADR-0104, ADR-0142 |
  | — | `src/storage/memory/index.ts` | done | — | barrel for `webtessera/storage/memory` — ADR-0104 |
  | — | `src/storage/memory/memory_test.ts` | done | 26 / — | the 19 `ObjectStore` contract cases plus 7 memory-specific ones (key listing, copying a view, abandoned lock waiters, `newMemoryDriver`'s store and `fetch`) — ADR-0104, ADR-0142 |
  | — | `src/storage/memory/memory_driver_test.ts` | done | 10 / — | `describeDriverConformance("memory")` — ADR-0106 |
  | — | `src/storage/memory/memory_golden_workers_test.ts` | done | 25 / — | the golden suite on the memory backend inside workerd (`bun run test:workers`) — ADR-0160 |

- **`src/storage/indexeddb/`** — browser persistence in an IndexedDB database, with cross-tab exclusion
  through Web Locks. Tested under Node against `fake-indexeddb` (`bun run test:unit`) and in real Chromium
  (`bun run test:browser`).

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/storage/indexeddb/indexeddb.ts` | done | — | `IndexedDBObjectStore`: one record per key, one transaction per method, strict durability. Opening it throws without Web Locks unless `singleWriter: true` declares the only writer, and `lockScope` (`"origin"` or `"realm"`) says which guarantee the store has; `newIndexedDBDriver` returns an `IndexedDBDriver` tied to an `AbortSignal` — ADR-0110, ADR-0111, ADR-0113, ADR-0201 |
  | — | `src/storage/indexeddb/locks.ts` | done | — | Web Locks, and an in-process lock (`NamedLocks`) used only for a declared single writer where `navigator.locks` is absent — ADR-0112, ADR-0142, ADR-0201 |
  | — | `src/storage/indexeddb/index.ts` | done | — | barrel for `webtessera/storage/indexeddb` — ADR-0113 |
  | — | `src/storage/indexeddb/testing/` (`keys.ts`, `locks.ts`, `log.ts`, `other_realm_worker.ts`, `prefix_cases.ts`) | done | — | test-only helpers: key listing for the golden suite, `newInProcessLockManager` (a stand-in `LockManager`, so that browser code runs unchanged in Node), the worker that stands in for a second tab. Excluded from the published build |
  | — | `src/storage/indexeddb/indexeddb_test.ts` | done | 83 / — | Node with `fake-indexeddb`: the 19 contract cases under both lock implementations, the 10 driver cases, and IndexedDB-specific cases (opening and upgrading, locks, lock scope, `deletePrefix`, `newIndexedDBDriver`) |
  | — | `src/storage/indexeddb/indexeddb_browser_test.ts` | done | 47 / — | real Chromium via `vitest.browser.config.ts`: both conformance suites, persistence across reopen, strict durability, closing so another context can upgrade or delete the database, Web Locks across realms, lock scope, two realms writing one log |
  | — | `src/storage/indexeddb/indexeddb_golden_test.ts`, `indexeddb_golden_browser_test.ts` | done | 25 / — each | the golden suite on `fake-indexeddb` in Node and in real Chromium — ADR-0160 |

- **`src/storage/sqlite/`** — the SQLite backend: one `ObjectStore` over any SQLite engine, through a small
  structurally typed adapter per engine. It replaces the Durable Object backend, which was one engine's
  worth of it (ADR-0120 to ADR-0123 are superseded). Tested on node:sqlite and libSQL in Node
  (`bun run test:unit`), sqlite-wasm in Chromium (`bun run test:browser`), D1 and SQLite-backed Durable Objects in
  workerd (`bun run test:workers`), and a live rqlite (`bun run test:services`); `scripts/smoke-sqlite.mjs` checks
  the built package on Node, Bun and Deno. ADR-0150 to ADR-0155.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/storage/sqlite/sqlite.ts` | done | — | `SqliteObjectStore` (`openSqliteObjectStore`) and `newSqliteDriver`, `DefaultMaxChunkBytes`: the `ObjectStore` contract over an engine-neutral `SqlDatabase`, with objects chunked below each engine's row limit — ADR-0150, ADR-0151, ADR-0154 |
  | — | `src/storage/sqlite/database.ts` | done | — | `SqlDatabase` (an async `query` and an atomic `batch`, with optional `defaultLocking` and `leaseClock`), `SqlStatement`, `SqlRow`, `SqlValue`, `SqliteLocking` — ADR-0150, ADR-0154 |
  | — | `src/storage/sqlite/schema.ts`, `keys.ts`, `values.ts`, `params.ts` | done | — | five tables per namespace with validated identifiers, and versioned, idempotent migrations (a database written by a newer version is refused); keys stored as TEXT but bound as UTF-8 bytes, `deletePrefix` as an exact byte range and never `LIKE`; the engines' value and parameter quirks — ADR-0151 |
  | — | `src/storage/sqlite/lease.ts` | done | — | local and lease locking: a lease is a random token renewed while held, and every write batch made under a lease is fenced on it in the same transaction (`ErrLeaseLost`) — ADR-0152 |
  | — | `src/storage/sqlite/adapters/` (`sync.ts`, `syncengine.ts`, `wasm.ts`, `libsql.ts`, `rqlite.ts`, `d1.ts`, `durableobject.ts`, `normalize.ts`) | done | — | `fromSqliteSync` (node:sqlite, bun:sqlite, better-sqlite3), `fromSqliteWasm`, `fromLibsql`, `fromRqlite`, `fromD1`, `fromDurableObjectStorage`; each states its default locking and what \"durable\" means on that engine — ADR-0153, ADR-0154 |
  | — | `src/storage/sqlite/index.ts` | done | — | barrel for `webtessera/storage/sqlite` — ADR-0154 |
  | — | `src/storage/sqlite/sqlite_test.ts` | done | 288 / — | node:sqlite: the 19 contract and 10 driver cases on 7 variants (memory and file, namespaced, local and lease locking, D1's limits with 4 KiB chunks), the 22 behaviour cases twice, and 8 engine-specific cases — ADR-0155 |
  | — | `src/storage/sqlite/sqlite_golden_test.ts` | done | 125 / — | the golden suite ×5: node:sqlite in memory, on a file with lease locking over a second connection, under D1's limits, libSQL on a file, and rqlite's wire format against an in-process fake — ADR-0155, ADR-0160 |
  | — | `src/storage/sqlite/adapters/libsql_test.ts` | done | 165 / — | libSQL (memory, file, lease locking over a second client, D1's limits): both conformance suites, the behaviour suite twice, and `fromLibsql` |
  | — | `src/storage/sqlite/adapters/rqlite_test.ts` | done | 60 / — | an in-process fake of rqlite's HTTP API (`testing/fake_rqlite.ts`): both conformance suites, the behaviour suite, and `fromRqlite` |
  | — | `src/storage/sqlite/adapters/sync_test.ts`, and `src/storage/sqlite/` `keys_test.ts`, `lease_test.ts`, `schema_test.ts` | done | 6, 16, 13 and 9 / — | `fromSqliteSync`; key encoding and prefix ranges; lease acquisition, renewal, expiry and fencing; the schema and its versioning |
  | — | `src/storage/sqlite/adapters/wasm_browser_test.ts`, `wasm_golden_browser_test.ts` | done | 113 and 25 / — | sqlite-wasm in real Chromium (memory, lease locking, D1's limits), and the golden suite |
  | — | `src/storage/sqlite/adapters/d1_workers_test.ts`, `durableobject_workers_test.ts`, `sqlite_golden_workers_test.ts` | done | 85, 87 and 50 / — | workerd: D1 and a SQLite-backed Durable Object, plain and under production limits with 4 KiB chunks, concurrent drivers on one database, reset, resume and eviction of an object, and the golden suite on both |
  | — | `src/storage/sqlite/adapters/rqlite_workers_test.ts` | done | 1 / — | workerd accepts the rqlite adapter's fetch policy — ADR-0213. `testing/append_process.ts` is a test-only child process for the multi-process append test — ADR-0210 |
  | — | `src/storage/sqlite/adapters/rqlite_services_test.ts` | done | 78 / — | a live rqlite (`bun run test:services`, configured through `RQLITE_URL`; counted from the source, which `bun run test:unit` does not run): both conformance suites, the behaviour suite, concurrent drivers on separate clients, and the golden suite — ADR-0155 |
  | — | `src/storage/sqlite/testing/` | done | — | test-only: `behaviour.ts` (the 22 engine-neutral behaviour cases), `concurrent.ts`, `fake_rqlite.ts`, `prefix_cases.ts`, `stores.ts`, `strict.ts` (a `SqlDatabase` double enforcing D1's and Durable Objects' limits), `node.d.ts`, and `workers/` (the test Worker, its Durable Object class and Wrangler config). Excluded from the published build |

- **`src/http/`** — serving a log over HTTP, as a handler of the Fetch API's `Request` and `Response`. Upstream
  leaves serving to each personality; its `cmd/conformance/*` servers each carry a copy of the same routing.
  Published as `webtessera/http`. ADR-0170.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/http/log_handler.ts`, `handler.ts` | done | — | `newLogHandler` serves `GET` and `HEAD` for `checkpoint`, `tile/<L>/<N>[.p/<W>]` and `tile/entries/<N>[.p/<W>]` from any `LogReader`; `Handler` resolves to `undefined` for a request that is not its own, and `combineHandlers` answers 404 when none matches — ADR-0170 |
  | — | `src/http/resources.ts`, `partial.ts` | done | — | path parsing over `api/layout` that accepts only canonical spellings (anything else under `tile/` is a 400 naming the canonical one), the specification's content types, `DefaultCacheControl`, and a partial resource trimmed to the width its path names — ADR-0170 |
  | — | `src/http/cors.ts`, `add.ts`, `node.ts` | done | — | opt-in CORS and preflight; `POST /add` helpers (`readEntryBody`, which refuses an entry over 65535 bytes as it streams, `addResponse` and `addErrorResponse`); `toNodeListener`, an adapter that imports nothing from `node:*` — ADR-0170 |
  | — | `src/http/index.ts`, `testing/testlog.ts` | done | — | barrel for `webtessera/http`, with the module documentation; a test log for the handler's tests (test-only) — ADR-0170 |
  | — | `src/http/resources_test.ts`, `log_handler_test.ts`, `node_test.ts` | done | 39, 19 and 7 / — | path grammar ×29, headers, partial trimming; the handler, `combineHandlers` and `POST /add` answers; the Node listener |
  | — | `src/http/log_handler_browser_test.ts` | done | 1 / — | real Chromium: serves a log from the tab, verifies it through the client, and gets a cosignature from a witness |

- **`src/witness/`** — a C2SP tlog-witness server. The root package holds a log's side of the protocol (ported
  from `witness.go` and `internal/witness`); this is the side that answers, which Tessera does not have.
  Published as `webtessera/witness`. ADR-0171, ADR-0172.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/witness/server.ts` | done | — | `newWitnessServer` and `WitnessServer`: `add-checkpoint` with the specification's checks in its order and its status codes, a fixed list of logs or `lookupLog` for an open-ended set, and the check and the write under one per-log lock, durable before the cosignature is returned — ADR-0171 |
  | — | `src/witness/http.ts`, `request.ts`, `checkpoint.ts` | done | — | the HTTP mapping and the monitoring endpoint; the request grammar (`parseAddCheckpointRequest`, at most 63 proof lines of exactly 32 bytes, a 16 KiB body cap); strict checkpoint parsing — ADR-0171 |
  | — | `src/witness/cosign.ts`, `keycheck.ts`, `state.ts`, `errors.ts` | done | — | timestamped cosignature/v1 signatures whose timestamps never go backwards for a log; a key-separation check that refuses a log whose key is one of the witness's own; `WitnessStore` and `originHash`, one object per log on any `ObjectStore`; one sentinel error per status — ADR-0171, ADR-0172 |
  | — | `src/witness/index.ts` | done | — | barrel for `webtessera/witness`, which also re-exports the cosignature/v1 key functions of `formats/note`, there being no `./formats/note` entry point — ADR-0174 |
  | — | `src/witness/request_test.ts`, `server_test.ts` | done | 21 and 29 / — | the request grammar; `addCheckpoint` and `handle`, including the cosignature/v1 signer check and cached key checks (ADR-0171) |
  | — | `src/witness/interop_test.ts` | done | 2 / — | a Tessera appender (the root package's client) witnessed by `WitnessServer`: every published checkpoint is cosigned, and a 409 on a log the witness has not seen is recovered |

- **`src/mirror/`** — copying a log into storage you control. `mirror.ts` is the port of
  `cmd/experimental/mirror/internal/mirror.go` (row in the main table); the rest is added around it.
  Published as `webtessera/mirror`. ADR-0173, ADR-0175, ADR-0176.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/mirror/retry.ts` | done | — | `retry.Do`'s defaults (10 attempts, `100ms << n` plus up to 100ms of jitter, `Unrecoverable`), reimplemented rather than ported, as ADR-0073 did for `backoff`; the signal aborts the waits — ADR-0173 |
  | — | `src/mirror/sink.ts` | done | — | `Sink` (a `put`, and an optional `get` to resume), satisfied by every `ObjectStore` and by an R2-style binding; `newSinkTarget` is the `Target` that writes each resource at its tlog-tiles path, and also reads it back — ADR-0175 |
  | — | `src/mirror/s3.ts`, `sigv4.ts` | done | — | `newS3Sink`: PutObject and GetObject over `fetch` for any S3-compatible service, with conditional writes for immutable resources and no redirects; `signV4`, a synchronous AWS Signature Version 4 signer on `@noble/hashes` — ADR-0175 |
  | — | `src/mirror/verify.ts`, `fetch.ts` | done | — | `newVerifiedMirror` and `VerifyingSource`: the source checkpoint's signature, its consistency with what was mirrored, and every tile and bundle against it, checked before anything is written; `newSourceFetch` reads URL sources without redirects and with capped responses — ADR-0176 |
  | — | `src/mirror/index.ts`, `testing/` | done | — | barrel for `webtessera/mirror`, with the module documentation; test-only: `fakes3.ts` (a fake S3 that checks every request's signature) and `sigv4_suite.ts` (the AWS SigV4 test vectors, whose attribution is in `NOTICE`) |
  | — | `src/mirror/mirror_test.ts`, `sink_test.ts`, `s3_test.ts`, `verify_test.ts` | done | 12, 3, 14 and 16 / — | `jobs`, `Mirror` (including the zero-stride case, which hangs without the fix) and `retry`; sinks and targets; the S3 sink against the fake; the verifying source and mirror |
  | — | `src/mirror/sigv4_test.ts` | done | 38 / — | 27 cases from the AWS SigV4 test suite and one that lists the 11 it does not run, with a reason for each (they normalise paths, carry dot segments `fetch` cannot send, or leave the token unsigned), 6 S3 request shapes against `aws4fetch`, and 4 helper cases |
  | — | `src/mirror/s3_workers_test.ts` | done | 1 / — | workerd accepts the S3 sink's fetch policy (credentials omitted, redirects refused) — ADR-0213 |
  | — | `src/mirror/s3_services_test.ts` | done | 3 / — | a live S3-compatible server (`bun run test:services`, configured through the `S3_*` variables; counted from the source): storing and reading objects with the tlog-tiles metadata, and a verified mirror that resumes — ADR-0175 |

- **`src/safe/`, `src/server/`, `src/browser/`** — the safe API: a small layer that composes ported functions
  into a log that cannot be misused, with no Go counterpart (ADR-0220 to ADR-0227). Published as
  `webtessera/server` and `webtessera/browser`; `src/safe/` is shared by both and not published on its own.
  Golden tests replay Go's `note` signing fixtures and the `log_*` checkpoints through non-extractable
  WebCrypto keys, in Node, Chromium and workerd, and require Go's bytes.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `src/safe/runtime.ts` | done | — | `detectRuntime`: server runtimes are identified first, by globals only they define, and only then browsers — ADR-0221 |
  | — | `src/safe/keys.ts` | done | — | `LogKey`: Ed25519 through WebCrypto (non-extractable by default) or, when asked, `@noble/curves`; the secret never reaches an error, `toString` or JSON — ADR-0222 |
  | — | `src/safe/receipt.ts` | done | — | receipts as C2SP tlog-proofs; `verifyReceipt` reuses the ported `note`, `formats/log`, `formats/proof` and `merkle/proof` code — ADR-0225 |
  | — | `src/safe/log.ts` | done | — | the high-level log: `append` returns a verified receipt once a published checkpoint covers the entry — ADR-0226 |
  | — | `src/server/` | done | — | `openServerLog`, `importLogKey`; `browser_guard.ts` is what the `browser` export condition resolves to, so a browser bundle fails to build — ADR-0221 |
  | — | `src/browser/` | done | — | `openBrowserLog`, device keys persisted as non-extractable `CryptoKey`s in IndexedDB — ADR-0227 |
  | — | `src/safe/*_test.ts`, `src/server/server_test.ts`, `src/browser/browser_test.ts` | done | see the files / — | guardrails, key custody, receipts (including tampering), export conditions under Node's resolver and a real esbuild bundle |
  | — | `src/server/guard_browser_test.ts`, `src/browser/log_browser_test.ts`, `src/server/server_workers_test.ts` | done | see the files / — | the guard in a window and a module worker, device keys across a reopen, and D1 and Durable Objects in workerd |

- **`examples/`** — one small, tested application per use case, built on the safe API. None is part of the
  published package. Each has a README and a `ci` script that CI runs; `docs/guides/` has a guide for each.

  | Go path | TS path | status | tests (TS/Go) | notes |
  | --- | --- | --- | --- | --- |
  | — | `examples/client-only/` | done | 7 / — | a browser's own log in IndexedDB with a device key; two tabs share it; it refuses to open without Web Locks (Chromium) |
  | — | `examples/session-receipts/` | done | 9 + 1 / — | the browser logs every exchange; the server witnesses it and commits a verified mirror to S3 or an ObjectStore; an auditor checks both (Node and Chromium; the S3 case runs when `S3_*` is set) |
  | — | `examples/notary/` | done | 10 / — | digest plus Ed25519 signature in, C2SP tlog-proof out, verified offline by a CLI; forged and altered receipts fail |
  | — | `examples/log-server/` | done | 4 / — | `POST /add` and the tlog-tiles API on SQLite with lease locking, one source on Node, Bun and Deno; an optional script verifies it with Tessera's Go client |
  | — | `examples/monitor/` | done | 9 / — | follows a log with `LogStateTracker`, keeps its state durably, and reports forks and rollbacks against a deliberately forking fake log |
  | — | `examples/edge/` | done | 5 / — | the log server as a Worker on a SQLite-backed Durable Object (workerd) |

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
| `log_{0,1,2,255,256,257,1000,5000}.json` | `src/storage/internal/integrate_fixtures_test.ts`, `src/storage/objectstore/driver_migration_test.ts`, and the golden suite (`describeGoldenCompatibility`, `src/storage/objectstore/testing/golden.ts`) in each backend's test file: `driver_fixtures_test.ts` (memory), `memory_golden_workers_test.ts`, `indexeddb_golden_test.ts`, `indexeddb_golden_browser_test.ts`, `sqlite_golden_test.ts`, `sqlite_golden_workers_test.ts`, `wasm_golden_browser_test.ts` | 11 in `integrate_fixtures_test.ts` (8 build-from-scratch, one per size, + 3 resumption cases across the 255/256/257 boundaries); 25 per backend run of the golden suite (the same paths and bytes, `.state/` files and signed checkpoint included, in one batch, in batches of 37, across restarts, and resuming Go-written state); 7 in `driver_migration_test.ts` (`log_0`, `log_1`, `log_257` and `log_5000` migrated into an empty store, a migration continued from a smaller tree, a wrong source root rejected, and no checkpoint published) |

### Everything the generator emits

`fixtures/gen` produces the 22 files below (3.4 MB), and the differential corpora that
[`compatibility.md`](compatibility.md) describes. Load them with `loadFixture(...)` from
`src/testonly/fixtures.ts`. Fixtures not yet claimed by a test are marked **unclaimed** — they are ready
to use, nothing needs regenerating.

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
| `log_{0,1,2,255,256,257,1000,5000}.json` | 64 files' worth of tiles + bundles | complete logs built by the real POSIX driver: every tile, every entry bundle, the signed checkpoint, and the driver's `.state/` files (ADR-0161) — asserted by `src/storage/internal/integrate_fixtures_test.ts`, `src/storage/objectstore/driver_migration_test.ts` and the golden suite on every backend (ADR-0160) |
| `client_log.json` | 15 entries | upstream's static `testdata/log`: 16 checkpoints, 15 tiles, 15 entry bundles and the log's signing key — read back by `src/client/client_test.ts`, `src/fsck/fsck_test.ts` and `src/internal/witness/witness_test.ts` |

The full-log fixtures were the strongest evidence available and previously unclaimed; they are now
asserted end to end by `storage/internal/integrate_fixtures_test.ts`, which builds each size from
scratch via `integrate()` and separately resumes integration across the 255→256→257 tile boundary
(both pairwise and one entry at a time), checking the resulting tiles and root hash against the
fixture byte-for-byte. The ObjectStore driver reuses the same fixtures the same way:
`storage/objectstore/driver_fixtures_test.ts` appends the entries the generator appended and compares
every path and byte with the Go POSIX driver's output (checkpoint signature included), and loads
Go-written logs into a store to resume and grow them; `driver_migration_test.ts` migrates them into an
empty store and compares the result (ADR-0105, ADR-0106).

Every storage backend runs the same suite on the same fixtures, as `describeGoldenCompatibility`
(ADR-0160): memory, IndexedDB and each SQLite engine, in every runtime that engine supports. The suite
compares every path and byte with the Go POSIX driver's output (checkpoint signature included), and
loads Go-written logs, `.state/` files included, into a store to resume and grow them.
[`compatibility.md`](compatibility.md) explains it, the Go interop harness and the differential
corpora, which record Go's verdicts on large sets of generated inputs.

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
  assertion is missing; the fixture rows are simply unusable. Fix belongs in the generator:
  add `leftBegin`/`leftEnd` to `errorCase` and regenerate.

- ~~`src/vendor/note/` is BSD-3-Clause (ADR-0024) and its file headers point at a `LICENSE` file the
  package does not contain.~~ **Resolved at the repository level**, as ADR-0024 and ADR-0040
  anticipated: the verbatim Go licence text is `LICENSES/BSD-3-Clause-Go.txt` (with the Go patent
  grant beside it), and `NOTICE` lists every Go-derived file group — `src/vendor/note/`,
  `src/vendor/formats/note/` (ADR-0071) and the Go-derived files and declarations of
  `src/internal/gostd/`. The file headers have since been changed to point at
  `LICENSES/BSD-3-Clause-Go.txt`, as `AGENTS.md` §9 prescribes; none still says "the LICENSE file".
