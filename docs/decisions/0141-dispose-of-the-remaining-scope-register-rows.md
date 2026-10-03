# ADR-0141: Dispose of the remaining scope-register rows

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** `storage/posix/` (with `antispam/`), `storage/aws/`, `storage/gcp/` and
  `storage/mysql/` (each with `antispam/` where it has one), `internal/hammer/` (with `loadtest/`),
  `cmd/conformance/`, `cmd/examples/`, `cmd/experimental/`, `integration/` (with `integration/fault/`).
  `keygen/` does not exist at `4a6d9f9`.

## Context

[ADR-0001](0001-scope-and-module-inclusion.md) made "port it" the default and left five module rows of its
register, and four rows of its table of additions, `pending`. Its rules are that a row leaves that state only
when an ADR argues it and the ADR's `## Review` is signed (rule 3), and that an exclusion says what capability
is lost and what replaces it (rule 4).

Those rows were written before any storage driver existed, when "what replaces it" could only be promised. It
can now be answered with code. The ObjectStore driver is a port of `storage/posix/files.go`
([ADR-0100](0100-objectstore-driver.md) to [ADR-0106](0106-objectstore-driver-test-strategy.md)), and the
memory, IndexedDB and Durable Object backends run it ([ADR-0104](0104-objectstore-public-api.md),
[ADR-0110](0110-indexeddb-object-store.md) to [ADR-0113](0113-indexeddb-driver-convenience-and-lifetime.md),
[ADR-0120](0120-durable-object-object-store.md) to
[ADR-0123](0123-durable-object-public-api.md)).

This ADR argues one disposition for every row that is still open, from the upstream code at `4a6d9f9` and not
from the row names. It proposes. Nothing here is in force until a reviewer other than its author has signed
the `## Review` below. Until then `docs/PORTING-MAP.md` keeps the affected files at `pending ADR`, with the
proposal in their `notes` column and not as a decision. The exceptions are the four `storage/posix/` files that
[ADR-0100](0100-objectstore-driver.md) already covers, whose rows carry the status that ADR gives them, and are
no more settled than that ADR is.

What the rows contain. Counts are the rows of `docs/PORTING-MAP.md`, so every `.go` file is accounted for.

| Register row | Files | What it is upstream |
| --- | --- | --- |
| `storage/posix/` | 4 | The POSIX driver. `files.go` (1031 lines) sequences entries into bundles, integrates them through `storage/internal`, publishes checkpoints, garbage-collects, checks the version and implements the migration target, all as files in a directory. `file_ops.go` is its write primitives: `createTemp` (a temporary file written with `O_SYNC`), `overwrite` (temporary file, `rename`, `fsync` of the directory), `createEx` (temporary file, `link`, so an existing target is an error, `fsync` of the directory), `syncDir` and `mkdirAll` (which also syncs the parents it creates). `otel.go` is a histogram of the duration of those operations. |
| `storage/posix/antispam/` | 3 | A persistent duplicate-detection index kept in Badger, an embedded key-value database opened on a local directory. |
| `storage/aws/`, `storage/gcp/`, `storage/mysql/` | 13 | Drivers for server infrastructure. `aws` keeps tiles and bundles in S3 and coordinates frontends through MySQL (Aurora); `gcp` keeps them in GCS and coordinates through Spanner; `mysql` keeps everything in MySQL tables (`Checkpoint`, `TreeState`, `Subtree`, `TiledLeaves`). The `aws` and `gcp` packages each carry an `antispam/` package: the same index as Badger's, in a MySQL table and in Spanner tables. |
| `internal/hammer/` | 10 | `hammer.go` is a command that loads a running log with writes and reads; `loadtest/` is its library: worker pool, throttle, statistics, and a terminal UI (`tview`/`tcell`). It talks to the log only over HTTP, through `client.NewHTTPFetcher` and `POST <write_log_url>/add`. |
| `cmd/conformance/`, `cmd/examples/`, `cmd/experimental/` | 13 | Binaries. `conformance/{aws,gcp,mysql,posix}` are personalities: a web server with `POST /add` and a file server for the read API (`cmd/conformance/README.md`: "a simple example of a personality" and "a conformance and performance harness" for the hammer). `examples/posix-oneshot` adds files to a POSIX log and exits once they are integrated. `experimental/migrate/*` are command-line wrappers around `NewMigrationTarget` and `Migrate`. `experimental/mirror` is a separate library, `internal/mirror.go`, plus a POSIX command. |
| `integration/`, `integration/fault/` | 2 | `TestLiveLogIntegration` (skipped unless `-run_integration_test`) drives a running personality over HTTP, and the fault test injects `EIO` and `SIGKILL` into `posix-oneshot` with `strace`. |
| `keygen/` | 0 | Nothing. |

Non-Go files (`deployment/`, `docs/`, `.github/`) are not register rows.

## Decision

| Row | Proposed disposition | Lost | Replaced by |
| --- | --- | --- | --- |
| `storage/posix/` (`files.go`, `files_test.go`) | ported as the ObjectStore engine (ADR-0100) | a driver that writes a directory with `os` calls | `src/storage/objectstore/driver.ts` on any `ObjectStore` |
| `storage/posix/` (`file_ops.go`, `otel.go`) | not ported (ADR-0100) | the file-system mechanism for atomic, durable writes; the duration histogram | the `ObjectStore` atomicity and durability requirements (section 1); nothing for the histogram (ADR-0051) |
| `storage/posix/antispam/`, `storage/{aws,gcp}/antispam/` | not ported | a persistent, best-effort duplicate index that survives restarts | `newInMemoryDedup` through `withAntispam`; the `Antispam` interface for an implementation supplied from outside |
| `storage/aws/`, `storage/gcp/`, `storage/mysql/` | not ported | running a log on S3, GCS or MySQL, and horizontal scale-out coordinated by a database | any store through the `ObjectStore` contract and `newObjectStoreDriver` |
| `internal/hammer/` | not ported | an upstream load-test harness shipped with the library | none in the library; upstream's own hammer where a personality matches its HTTP conventions (section 4) |
| `cmd/conformance/*`, `cmd/examples/*` | not ported | runnable reference personalities and a one-shot CLI | `examples/cloudflare-durable-object`, `examples/browser`, the README snippets |
| `cmd/experimental/migrate/*` | not ported | four commands | the ported `migrate` library, tested end to end (ADR-0105) |
| `cmd/experimental/mirror/*` | not ported (but see the Update: `internal/mirror.go` is now ported as `webtessera/mirror`) | verbatim mirroring of a log's static resources | partly `migrate`; otherwise a few lines of user code (section 5) |
| `keygen/` | none: the row was a mistake | nothing | `generateKey` in `webtessera/note` |
| `integration/`, `integration/fault/` | not ported as files | an HTTP-level suite and syscall fault injection | `describeDriverConformance` on every backend (section 7), without fault injection |
| `storage/memory/`, `storage/indexeddb/`, `storage/sqlite/` (additions) | implemented | n/a | ADR-0104; ADR-0110 to ADR-0113; ADR-0150 to ADR-0155 (the SQLite backend replaces `storage/durableobject/`, ADR-0120 to ADR-0123) |
| `http/`, `witness/` (additions) | implemented | n/a | ADR-0170; ADR-0171, ADR-0172, ADR-0174 |
| `storage/s3/` (addition) | deferred | n/a | the `ObjectStore` contract is the extension point |

### 1. `storage/posix/`: ported, with `file_ops.go` carried by the contract

`files.go` and `files_test.go` are ported (`driver.ts`, `driver_test.ts`; ADR-0100 to ADR-0106). `file_ops.go`
and `otel.go` are the two files ADR-0100 leaves out. ADR-0001's "Alternatives considered" says why they cannot
be dismissed as "obviously irrelevant": `file_ops.go` "encodes the crash-safety contract every driver must
meet". This is how that contract reaches the web backends.

| `file_ops.go` | What it guards against | `ObjectStore` counterpart |
| --- | --- | --- |
| `overwrite` (temporary file, `rename`, directory `fsync`) | a reader or a crash observing a half-written tile or checkpoint at its final path | `put`: "atomically creates or overwrites" |
| `createEx` (temporary file, `link`, directory `fsync`) | two writers both believing they created a file; a torn file | `create`: atomic create-if-absent, "the counterpart of POSIX `O_CREAT\|O_EXCL`" |
| `createTemp` (`O_SYNC`) | acknowledging bytes that are not yet on disk | every method "resolve[s] only once the write is durable for the backend in question" |
| `syncDir` | a directory entry that is lost although the file is not, and an error that is swallowed | the same durability requirement; an `ObjectStore` has no directories |
| `mkdirAll` | none of its own: a file system needs directories before files | nothing (ADR-0100: "`mkdirAll` is nothing") |

The requirement is stated once, at the interface (`src/storage/objectstore/objectstore.ts`): "Every method must
be atomic with respect to the key(s) it touches: a reader observes either the previous contents of a key or the
new ones, never a mix. Methods resolve only once the write is durable for the backend in question." What
differs is who provides it. IndexedDB runs one transaction per method, resolves on its `complete` event and
asks for strict durability (ADR-0110, ADR-0111). A Durable Object relies on its transactional storage and
output gates (ADR-0120, ADR-0122). The memory backend is atomic because one realm runs one synchronous step at a
time, and it is not durable beyond that realm, which is its purpose.

Crash consistency of the log as a whole never came from `file_ops.go`. It comes from the order of the writes in
`files.go`: bundles and tiles first, `.state/treeState` last, so a crash part-way leaves resources beyond the
recorded size that the next batch overwrites. `driver.ts` keeps that order (ADR-0100, Consequences).

What is lost is the mechanism, and with it the one guarantee specific to a file system, that the directory
entry itself is durable. What is checked: `describeObjectStoreConformance` holds every backend to per-key
atomicity (exactly one of several concurrent `create`s wins, `put` replaces whole objects, stored bytes are
independent of the caller's arrays) and to lock exclusion. What is not: whether a write survives a crash or a
power failure is a property of the platform, and no test in this repository can exercise it. Section 7 comes
back to this.

`otel.go` records the duration of POSIX operations in an OpenTelemetry histogram. It goes with the rest of the
instrumentation (ADR-0051, ADR-0080), and nothing replaces it.

### 2. Persistent antispam: not ported

The three `antispam/` packages share one design. They keep an index from an entry's identity hash to the index
it was assigned, in a database separate from the log's own storage. A decorator answers a duplicate `Add` with
the recorded index (`IsDup: true`). A follower tails the log's entry bundles to populate the index, and the
decorator pushes back (`ErrPushbackAntispam`) once the follower is more than `PushbackThreshold` entries behind.
The three differ in the database they use, Badger, a MySQL table or Spanner tables, and in its tuning options.
All three are labelled "experimental" in their doc comments.

Not ported. What is lost is a duplicate index that outlives the process. What replaces it is
`AppendOptions.withAntispam(inMemEntries, antispam)` with `antispam` null, which installs `newInMemoryDedup`
(`src/antispam.ts`, a port of `antispam.go` with its LRU ADR-0081). It works with every web driver, because it
sits in front of `Add` and never touches storage. Upstream treats this as a supported configuration, not a
degraded one: `newInMemoryDedup`'s comment says it "can be used in isolation", and Tessera's own MySQL
conformance personality runs with `WithAntispam(tessera.DefaultAntispamInMemorySize, nil)`.

The loss is a loss of an optimisation, not of a guarantee. `docs/design/antispam.md` calls the mechanism "best
effort" and lists strong deduplication among its non-goals: a duplicate entry is still discoverable, it only
costs operators and monitors storage and bandwidth. With the in-memory index alone, an entry resubmitted after
a restart, after the cache has evicted it (`DefaultAntispamInMemorySize` is 262,144 entries), or to another tab
of a browser log, which has its own cache, is admitted again under a new index.

The `Antispam` and `Follower` interfaces are ported (`src/lifecycle.ts`) and `withAntispam` accepts any
implementation, so a persistent one can be supplied from outside the library. A persistent antispam shipped by
this repository, over IndexedDB or Durable Object storage, would be an addition with no upstream counterpart and
would need its own ADR (AGENTS.md section 6). None is proposed here.

### 3. Cloud and MySQL drivers: not ported

`aws`, `gcp` and `mysql` exist to run a log on server infrastructure: object storage or tables as the log's
home, and, for `aws` and `gcp`, a transactional database through which several personality instances take turns
integrating. S3 and GCS are HTTP APIs, which is why a store over them is something an `ObjectStore` could be.
What a browser tab cannot run is the layer that makes several writers safe: Spanner and MySQL are reached over
gRPC and TCP, and each of S3, GCS, Spanner and MySQL comes with a server SDK, where AGENTS.md section 7 allows
the library no runtime dependency beyond `@noble/*`. ADR-0100 already weighs and rejects using one of the cloud
drivers as the model for the web drivers.

What is lost: running a log on S3, GCS or MySQL as Tessera ships it, and horizontal scale-out coordinated by a
database. What replaces it: `newObjectStoreDriver({ store })` runs on any object that implements the six
`ObjectStore` operations, so a server-side deployment can supply a store of its own over S3, GCS, a file system
or anything else, and the package has no Node built-ins to prevent it. That replacement is narrower than the
original in one way that matters: coordination is `ObjectStore.lock`, which the contract requires to exclude
"every holder that can reach the same underlying data". Whoever writes a store for shared infrastructure must
provide that, and a lock that is wrong forks the log (ADR-0103). `NamedLocks`
([ADR-0142](0142-shared-named-locks.md)) supplies the in-process half and nothing beyond it. Tessera's
multi-frontend scale-out is not claimed.

### 4. `internal/hammer/`: not ported

`hammer` is a command-line load generator with a terminal UI. It is an HTTP client of a log, and nothing else
imports it. Not ported: it is a command, not a library, and the part of it a port could reuse, the HTTP client
side, is `client`, which is ported. Its terminal UI (`tview`, `tcell`) has no meaning in a browser or a Worker,
for the reason ADR-0093 gives for `cmd/fsck`'s.

What is lost is a load and latency harness shipped with the port. What replaces it is, at best, upstream's own
hammer. Its read side needs only a tlog-tiles endpoint and the log's public key. Its write side expects
`POST <write_log_url>/add` to answer with a body that starts with the decimal index (`httpWriter` calls
`strconv.ParseUint` on the first line, and `integration_test.go` does the same). A personality that answers
that way can be loaded with the unmodified hammer, and `examples/cloudflare-durable-object` answers exactly
that way (the bare decimal index), so the hammer and `integration_test.go`'s client can drive it as it stands.

### 5. `cmd/`: not ported

- **`cmd/conformance/*`** are HTTP personalities, one per driver, and each wires up a driver this port does
  not have as such (a directory, S3 and MySQL, GCS and Spanner, MySQL). Their role as the example personality is
  played by `examples/cloudflare-durable-object` (a Worker with `POST /add` and the tlog-tiles read API) and
  `examples/browser` (a log in a tab). Their role as the hammer's target is not replaced (section 4).
- **`cmd/examples/posix-oneshot`** adds files from a glob to a POSIX log, with an optional witness policy, and
  exits once they are integrated. Its job is to show how to use the appender; the README snippets do that
  (`src/README_test.ts`, ADR-0140), and `withWitnesses` is ported.
- **`cmd/experimental/migrate/*`** are four copies of the same wrapper: fetch the source checkpoint with
  `client.NewHTTPFetcher`, call `tessera.NewMigrationTarget` on a driver, call `Migrate` with the fetcher's
  `ReadEntryBundle`. `newMigrationTarget`, `migrate` and `HTTPFetcher` are ported, and migration is tested end
  to end against logs the Go POSIX driver wrote (ADR-0105). A command adds flag parsing around them.
- **`cmd/experimental/mirror/*` is not a wrapper around `migrate`.** `internal/mirror.go` is its own copier. It
  walks the source's tiles and bundles by range, copies each verbatim with retries, and writes the source's
  checkpoint last. Its comment says it "_only copies the data_" and does no self-consistency check. What is lost
  is verbatim mirroring of a log's static resources into a target. `migrate` covers part of it: it copies entry
  bundles, rebuilds the tiles locally and fails unless the recomputed root equals the source's. That is a
  stronger check than the mirror makes, but it is not a verbatim copy of the tiles, and a migration target
  publishes no checkpoint (it reports `ErrNotExist`, ADR-0105). A store that is a static tlog-tiles log
  (ADR-0100) can be mirrored into with `HTTPFetcher` and `ObjectStore.put` in a few lines, but shipping that
  would be an addition and needs its own ADR. None is proposed.

### 6. `keygen/`: no such directory

ADR-0001's register lists `keygen/`, and `docs/PORTING-MAP.md` carries a `keygen/main.go` row, but the pinned
tree has no `keygen/` directory and no file of that name. The 106 `.go` files contain no key generator; the
tests call `note.GenerateKey` and `.github/workflows/aws_integration_test.yml` fetches
`generate_keys` from the `serverless-log` repository. The row was a mistake and this ADR proposes withdrawing
it from the register when ADR-0001 is next revised. Nothing is lost. Key generation is `generateKey` in
`webtessera/note` (a port of `note.GenerateKey`), which the Cloudflare example's `pnpm keygen` script calls.
The `PORTING-MAP` row stays, as rows are never deleted, marked `not ported` with this explanation.

### 7. `integration/` and `integration/fault/`: not ported as files

Both drive something that does not exist here: `TestLiveLogIntegration` a running personality over HTTP
(`-log_url`, `-write_log_url`, a public key), CI starting the MySQL and POSIX conformance binaries to give it
one, and `fault_test.go` a `posix-oneshot` binary under `strace`. Neither can be reproduced as files without
the binaries, so the question is what keeps their guarantees.

`describeDriverConformance` (`src/storage/objectstore/testing/driver_conformance.ts`, ADR-0106) runs one set of
ten end-to-end cases against every backend: memory, IndexedDB under Node with `fake-indexeddb` and in real
Chromium, and Durable Objects in workerd. The cases are: sequential indices and a checkpoint committing to
them; a `PublicationAwaiter` resolving; tiles and bundles from which a client verifies inclusion and
consistency proofs, including against an older checkpoint's partial tiles; `ErrNotExist` for missing
resources; deduplication only when antispam is configured; resuming after a restart; two drivers sharing a
store never assigning an index twice; garbage collection below the published size only; migration into an
empty store; and no store call after shutdown and abort (nor, on Node, any pending timer). That is the content of
`TestLiveLogIntegration` (add entries, wait for a checkpoint that covers them, read the entries back, verify
inclusion proofs against the checkpoint root) plus restart, sharing, garbage collection and migration. Beyond
it, `driver_fixtures_test.ts` shows the driver writes the paths and bytes the Go POSIX driver wrote, and
`indexeddb_browser_test.ts` runs two realms, a page and a worker, as writers of one log.

What it does not cover:

- **Fault injection.** `fault_test.go` fails each of a run's file-system calls, with `EIO` and with `SIGKILL`,
  and requires `fsck` to pass afterwards. Nothing here fails a backend operation part-way. The Durable Object
  driver tests reset an instance in two cases, at fixed points, and check that the log resumes (ADR-0122).
  IndexedDB has no equivalent, and no test can check durability across an operating-system crash. The
  six-method contract makes a backend-independent equivalent possible, a store that fails or stops at its *n*th
  call for every *n*, with `fsck` afterwards, which would test the write ordering of section 1. It is not
  written, and is the largest gap this ADR leaves.
- **HTTP.** A personality's `/add` handler, status codes and cache headers, and `HTTPFetcher` against a live
  server. `fetcher_test.ts` covers the fetcher against stubs and the Cloudflare example has its own tests.
- **Other processes.** The upstream tests run the personality as a separate process. Here the shared-store
  cases run in one realm (and in two realms in Chromium), and a Durable Object is a single instance by
  construction (ADR-0121).
- **Scale.** The suite keeps logs small. `driver_test.ts` runs Go's 60,000-entry garbage-collection batches on
  the memory backend, and the fixtures reach 5,000 entries, against 1,024 concurrent entries for
  `TestLiveLogIntegration` by default.

### 8. Additions upstream does not have

- **`storage/memory/`, `storage/indexeddb/`, `storage/durableobject/`: implemented.** Each argues itself in its
  own ADRs: memory as the reference backend and the browser's counterpart of `storage/posix` (ADR-0104, ADR-0106),
  IndexedDB (ADR-0110 to ADR-0113), Durable Objects (ADR-0120 to ADR-0123). Each implements nothing but
  `ObjectStore`, is held to `describeObjectStoreConformance` and `describeDriverConformance`, and has its own
  rows in `docs/PORTING-MAP.md`. ADR-0001 asked each addition to be argued as a faithful extension of an
  upstream interface and not as a fork of upstream behaviour. They implement the upstream `Driver` and
  `LogReader` contracts from the outside, through the one shared engine (AGENTS.md section 8).
- **`storage/s3/`: not implemented in this release; mark the row `deferred`.** The row's "level-2 sync to an
  S3-compatible object store" is two different things. An `ObjectStore` over S3 puts the log's home in a bucket
  and must supply `lock` for every client that can reach it, which S3 does not provide as a primitive and which
  would have to be built, for example from conditional writes, with ADR-0103's warning that a wrong lock forks
  the log. Publishing a log held in IndexedDB or a Durable Object to a bucket is replication: the store already
  holds a static tlog-tiles log (ADR-0100), but the contract has no listing operation, so a copier has to derive
  keys from the tree size as `mirror.go` does. Neither has an upstream counterpart other than the AWS driver this
  ADR leaves unported, and nothing in the library prevents either. Dropping the row would be equally defensible;
  `deferred` keeps the idea visible to the reader who would otherwise wonder whether it was considered.

## Consequences

- If this ADR is accepted, every `.go` file in the pinned tree has a recorded disposition. The register's open
  rows cover 45 files: 2 ported (`files.go` and `files_test.go`) and 43 not ported. `keygen/main.go` stays a
  `docs/PORTING-MAP.md` row for a file that does not exist.
- What a user cannot do with this port that Tessera can, stated plainly: keep a persistent antispam index; run
  a log on S3, GCS or MySQL with a database coordinating several instances; use ports of upstream's command-line tools;
  mirror a log verbatim; run `integration/` and the fault-injection test.
- The hammer works against a web personality only if the personality's `/add` answers in upstream's format
  (section 4). That is a property of the example, not of the library, and is left to its owner.
- The fault-injection gap (section 7) is real. It is the one place where an upstream test checks something
  this port checks only by argument.
- Until review, ADR-0001's register shows these rows as `proposed — ADR-0141`, not `accepted`. If the reviewer
  rejects a disposition, that row goes back to `pending` and `docs/PORTING-MAP.md` is already correct.
- Nothing here changes a byte the library produces, and no code changes.

**Update (2026-10-03).** Three things in this ADR were overtaken by later work, which is proposed and
awaits review like this ADR:

- **The Durable Object backend is gone.** `storage/sqlite/` replaces it: one `ObjectStore` over any SQLite
  engine, with a SQLite-backed Durable Object as one engine among node:sqlite, bun:sqlite, better-sqlite3,
  libSQL/Turso, rqlite, Cloudflare D1 and sqlite-wasm ([ADR-0150](0150-sqlite-object-store.md) to
  [ADR-0155](0155-sqlite-test-strategy.md)). ADR-0120 to ADR-0123 are superseded. Wherever section 8 and the
  Context name the Durable Object backend, read the SQLite backend. The register row above is updated.
- **`cmd/experimental/mirror/internal/mirror.go` is ported** as `webtessera/mirror`
  ([ADR-0173](0173-mirror-port.md)), with S3-compatible sinks ([ADR-0175](0175-mirror-sinks.md)) and
  verification of what it copies ([ADR-0176](0176-mirror-verification.md)). Section 5's "a few lines of user
  code" is superseded for that file; `cmd/experimental/mirror/posix/main.go`, the command, stays not ported.
- **Two additions with no upstream counterpart** are implemented: `http/`, the tlog-tiles read API as a
  fetch-style handler ([ADR-0170](0170-http-log-handler.md)), and `witness/`, a tlog-witness server
  ([ADR-0171](0171-witness-server.md), [ADR-0172](0172-witness-state-on-objectstore.md),
  [ADR-0174](0174-formats-note-cosigv1-timestamp-and-vkey-conversion.md)). The `storage/s3/` row stays
  `deferred`: replicating a log into a bucket is now the S3 sink of `webtessera/mirror`, while an
  `ObjectStore` over S3, which needs a `lock`, is still not provided.

## Alternatives considered

- **Port the cloud drivers over the server SDKs.** Rejected: they need database connections (Spanner, MySQL)
  that a browser tab cannot make and server SDKs that AGENTS.md section 7 does not allow as dependencies, and
  ADR-0100 explains why the engine is `posix`'s.
- **Port a persistent antispam now, over IndexedDB or Durable Object storage.** Rejected for this ADR: it is
  new design with no upstream counterpart and needs an ADR and a follower test suite of its own. The loss is
  one upstream itself calls best-effort, and upstream runs its MySQL personality without the persistent index.
- **Port the hammer as a Node command.** Rejected: it is a command whose only target is an HTTP URL, so a port
  adds nothing that the Go original does not already do for a conforming personality.
- **Port `integration/` as a Vitest suite against the Cloudflare example.** Rejected here: it would test the
  example's HTTP layer rather than the driver, and `describeDriverConformance` already tests the driver on every
  backend. A test of the example's endpoints belongs to the example.
- **Leave the rows `pending`.** Rejected: ADR-0001 itself says a `pending` row must not be quietly reclassified,
  and equally should not stay unargued once the argument can be made. The proposal is recorded, and the rows
  keep the `pending ADR` status until it is reviewed.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
