# ADR-0100: Run one port of the POSIX driver over a minimal key/value contract

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go`, `storage/posix/file_ops.go`, `storage/posix/otel.go`,
  `storage/storage_test.go`

## Context

Tessera ships four drivers: `posix` (a directory on a local filesystem), and `gcp`, `aws` and `mysql`, which
sequence through a transactional database and serve resources from an object store or a table. None of them
runs in a browser or a Cloudflare Durable Object. This port needs at least three backends there, an in-memory
one, IndexedDB and Durable Object storage, and callers will want others (OPFS, a remote object store).

Of the upstream drivers, `posix` is the one whose needs are smallest. Reading `files.go` end to end, every
interaction it has with its storage is one of six operations:

| `files.go` / `file_ops.go` | what it needs |
| --- | --- |
| `os.ReadFile` (`readAll`, `ReadCheckpoint`, `readTreeState`, ...) | read a whole object, or learn it does not exist |
| `os.Stat` (`stat`, used by `ensureVersion` and `publishCheckpoint`) | existence and modification time |
| `overwrite` (`createOverwrite`): temp file, `rename`, `fsync` of the directory | atomic create-or-replace |
| `createEx` (`createExclusive`): temp file, `link`, `fsync` | atomic create-if-absent |
| `os.RemoveAll` (`removeDirAll`, GC only) | delete everything under a prefix |
| `lockFile`: `fcntl(F_SETLKW)` on `.state/<name>.lock` | a named, exclusive lock shared by every process using the log |

`mkdirAll` exists only because a filesystem needs directories before files. The rest of `files.go`
(sequencing into bundles, integration via `storage/internal`, checkpoint publication, garbage collection,
version checks, the migration target) is pure logic on top of those six operations.

## Decision

**One engine.** `src/storage/objectstore/driver.ts` is a port of `files.go`, declaration by declaration, onto
the `ObjectStore` contract in `src/storage/objectstore/objectstore.ts`, which has exactly the six operations
above (`get`, `stat`, `put`, `create`, `deletePrefix`, `lock`). Backends implement only the contract
(`src/storage/memory/`, `src/storage/indexeddb/`, `src/storage/durableobject/`); none of them contains log
logic.

**Keys are tlog-tiles paths.** Every public resource is stored under the path
[C2SP tlog-tiles](https://c2sp.org/tlog-tiles) assigns it, computed exactly as `files.go` computes it:
`layout.CheckpointPath`, `layout.TilePath(level, index, p)` and `opts.EntriesPath()(index, p)`. The driver
never calls `layout.EntriesPath` itself, which upstream's `storage/storage_test.go` forbids so that
`WithCTLayout` keeps working (`src/storage/storage_test.ts` enforces the same rule here). Private state uses
the POSIX driver's own names, `.state/treeState`, `.state/gcState` and `.state/version`, with the same
contents byte for byte (ADR-0102), and locks are named after the files POSIX flocks, `.state/treeState.lock`,
`.state/publish.lock` and `.state/gcState.lock` (ADR-0103).

The mapping is one ObjectStore call per filesystem operation: `os.ReadFile` is `get`, `os.Stat` is `stat`,
`overwrite` is `put`, `createEx` is `create`, `os.RemoveAll` is `deletePrefix` (every caller passes a path
ending in `/`, so prefix and directory semantics coincide), `lockFile` is `lock`, and `mkdirAll` is nothing.
Error texts that name an `os` function name the ObjectStore method instead (`error in get(".state/treeState")`
for `error in ReadFile(...)`); every other error text is upstream's.

**Not ported.** `file_ops.go` (its temp-file, link/rename and directory-`fsync` dance is how POSIX provides
atomic, durable writes; providing them is now each backend's obligation under the contract) and
`storage/posix/otel.go` and every `klog` call (as ADR-0051 and ADR-0080 do for the rest of the port).
`files.go`'s `context.Context` parameters that only fed metrics become no parameter at all; the ones that
reach a lock, a queue, integration or a checkpoint publisher become a trailing `AbortSignal`.

Where the port diverges from `files.go` beyond this mapping it says so in a `Port note:` and an ADR: partial
tiles are not relinked (ADR-0101), the state files are encoded by hand (ADR-0102), the in-process mutex is
dropped (ADR-0103), and the public names differ (ADR-0104).

## Consequences

- A store holds a byte-for-byte static tlog-tiles log. Serving the public part over HTTP is a matter of
  mapping a request path to a key, for example in a Service Worker or a Worker's `fetch` handler, and the store
  can be exported to, or imported from, a POSIX log directory. `driver_fixtures_test.ts` proves both
  directions against logs written by the real Go POSIX driver: built from scratch the store holds exactly the
  fixture's paths and bytes, checkpoint signature included, and a Go-written log loaded into a store resumes
  and grows into the next fixture.
- Log logic exists once and is tested once, against the reference memory backend; each other backend is held
  to `testing/conformance.ts` (the contract) and `testing/driver_conformance.ts` (a whole log end to end).
- A batch is several independent writes (bundles, tiles, then `.state/treeState`), exactly as on POSIX: a
  crash part-way leaves resources beyond the recorded tree size, which the next batch overwrites because it
  starts from the recorded size. The contract needs no multi-key transactions for this reason.
- Each tile and bundle is one round trip. Backends with high per-operation latency pay for that; batching
  writes would need a contract change and a divergence from `files.go` that has not been justified by a
  measurement yet.
- The contract is now shared by several backends, so changing it is expensive. That is deliberate: it is
  small enough that changing it should rarely be necessary.

## Alternatives considered

- **A driver per backend**, each written against its storage API directly. Rejected: three copies of the
  sequencing, integration, publication and GC logic, each free to drift from upstream differently, and three
  times the review.
- **Port a cloud driver (`gcp` or `aws`) instead of `posix`.** Rejected: they sequence through a database
  with multi-row transactions (Spanner, MySQL, DynamoDB-style conditional writes) and a separate integration
  loop. That machinery buys horizontal scale, which a browser tab or a single Durable Object does not need,
  and would require far more from every backend.
- **Store resources under compact or hashed keys.** Rejected: it gives up the property that a store *is* a
  static tlog-tiles log, and with it direct serving, import/export and byte-for-byte fixture comparison.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `storage/posix/files.go` and `file_ops.go` in full against all of `src/storage/objectstore/driver.ts` and
    `objectstore.ts`. The six-operation table is exact: files.go touches storage only through `os.ReadFile`
    (`readAll`, `ReadCheckpoint`, `readTreeState`, `readGCState`), `os.Stat` (`ensureVersion`, `publishCheckpoint`),
    `overwrite`, `createEx` (only `ensureVersion`'s version file), `os.RemoveAll` (`removeDirAll`, called only from
    `garbageCollect`) and the fcntl `lockFile`; `mkdirAll` exists only for directories. Each maps one to one onto
    `get`/`stat`/`put`/`create`/`deletePrefix`/`lock`.
  - Declaration and branch walk. Every function of files.go has its counterpart in Go's order (`newAppender` with
    the 100 ms minimum rendered as Go's `%v` Duration, `Add`, the three readers through `partialOrFullResource`,
    `sequenceBatch`, `doIntegrate`, `readTile(s)`, `storeTile`, `writeTile`, `writeBundle`, `initialise`,
    `ensureVersion`, tree/GC state read and write, `publishCheckpoint`, `publishedSize`, `garbageCollectorJob`,
    `garbageCollect` including the `d > maxBundles` bound, `isLastLeafInParent`, `MigrationWriter`, `MigrationStorage`
    with `buildTree` and `fetchLeafHashes`). The constants and the six state and lock names equal Go's. I compared
    every error text: all are Go's except where an `os` function is named (`ReadFile` becomes `get`), which the ADR
    says; the one other departure, the ADR-0205 refusals, is a later ADR. `driver.ts` never imports `entriesPath`
    (`storage_test.ts` enforces it).
  - Consequences, by running: `driver_fixtures_test.ts` runs `describeGoldenCompatibility("memory")` and passes for
    every `log_<N>` (tiles, bundles, signed checkpoint, `.state/treeState` and `.state/version` byte-identical to what
    the real POSIX driver wrote; a Go-written state continued into the next fixture). `vitest run` over
    `src/storage/objectstore` and `src/storage/memory`: 7 files, 178 tests, all passed (45.75 s).
  - Alternatives are fair (a driver per backend, a cloud driver as the model, compact keys). Dropping `file_ops.go` is
    right: it is only the write primitives, and the contract restates what they guarantee (see ADR-0141 section 1).
  - Not blocking, but the record should be kept straight with an Update line: (1) the Decision names
    `src/storage/durableobject/`, which ADR-0150 deleted (ADR-0120 to ADR-0123 carry the supersession); (2) "every other
    error text is upstream's" is no longer exact after ADR-0205 added `initialise`'s refusal and `checkPublishable`.

## Update (2026-10-04)

The Durable Object backend that the Context and Consequences name (`src/storage/durableobject/`, ADR-0120 to
ADR-0123) was removed. ADR-0150 replaced it with the SQLite backend, of which a SQLite-backed Durable Object is one
engine (`fromDurableObjectStorage`). The backends today are memory, IndexedDB and SQLite (ADR-0104, ADR-0110 to
ADR-0113, ADR-0150 to ADR-0155).
