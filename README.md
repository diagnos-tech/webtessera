# webtessera

[![CI](https://github.com/diagnos-tech/webtessera/actions/workflows/ci.yml/badge.svg)](https://github.com/diagnos-tech/webtessera/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/webtessera)](https://www.npmjs.com/package/webtessera)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A faithful TypeScript port of [Tessera](https://github.com/transparency-dev/tessera), the tile-based
transparency log, that runs in the browser, on any SQLite database, and anywhere else modern
JavaScript runs.**

A transparency log is an append-only, tamper-evident record: anyone can verify that an entry is in
it, and that the log never rewrote its history. Tessera is the transparency-dev project's library
for building such logs in Go, serving them in the [C2SP tlog-tiles](https://c2sp.org/tlog-tiles)
format. webtessera brings the same log to places Go does not reach — a browser tab backed by
IndexedDB, a server or an edge function backed by whichever SQLite it already has — while staying
byte-for-byte compatible with it: a log written by webtessera can be read and verified by Tessera's
Go client, and the other way round.

> [!NOTE]
> webtessera is an independent port. It is not an official Google or transparency-dev project.

## Features

- **The whole append lifecycle**: batching, pushback, antispam deduplication, signed checkpoints
  ([signed notes](https://c2sp.org/signed-note), Ed25519), witnessing with witness policies and
  cosignatures, garbage collection of partial tiles, and migration of existing logs.
- **Storage for the web and the server**: an in-memory driver, an IndexedDB driver (durable, shared
  safely between tabs through Web Locks), and a SQLite driver that runs on any SQLite engine —
  node:sqlite, bun:sqlite, better-sqlite3, libSQL/Turso, rqlite, Cloudflare D1, SQLite-backed Durable
  Objects or sqlite-wasm — with lease locks and fencing when several processes share one database.
  Any key/value store can be plugged in by implementing a six-method contract.
- **Verification**: checkpoint fetching, inclusion and consistency proofs, entry streaming, a
  client-side log state tracker, and `fsck` for whole-log integrity checks.
- **Serving, witnessing and mirroring**: a fetch-style handler that serves the tlog-tiles API, a
  [tlog-witness](https://c2sp.org/tlog-witness) server, and a mirror that verifies a log before it
  copies it into any S3-compatible bucket or `ObjectStore`.
- **Static CT API** support for Certificate Transparency logs.
- **Small and portable**: ESM with type declarations, no Node built-ins, and only two runtime
  dependencies, the audited [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) and
  [`@noble/curves`](https://github.com/paulmillr/noble-curves).

## Install

```sh
npm install webtessera
# or: bun add webtessera / pnpm add webtessera / yarn add webtessera
```

## The safe API

Most applications want a log that cannot be misused more than they want Tessera's full API. webtessera
ships a small layer for them, in two entry points that say where the code runs:

| Import | For | Holds |
| --- | --- | --- |
| `webtessera/server` | Node.js, Deno, Bun, Cloudflare Workers and other server and edge runtimes | the log's key, imported from your secret store into a non-extractable WebCrypto key |
| `webtessera/browser` | browser windows and workers | a device key generated in the browser, which no script can export |

A log on a server, kept in SQLite:

```ts file=src/README_test.ts region=safe_server_example
// The key comes from your secret store, never from source code.
const log = await openServerLog({
  key: await importLogKey(env.LOG_SKEY),
  storage: { sqlite: fromSqliteSync(new DatabaseSync(file)) },
});

// Resolves once a published checkpoint commits to the entry, with a receipt that
// proves it offline: a C2SP tlog-proof, already verified.
const receipt = await log.append(entry);
```

Receipts verify anywhere, without the log:

```ts file=src/README_test.ts region=safe_verify_example
// Anyone with the log's vkey and the entry can check a receipt, offline.
const { index, checkpoint } = verifyReceipt(receipt.text, { vkey: log.vkey, data: entry });
```

A log of the browser's own, kept in IndexedDB:

```ts file=src/README_test.ts region=safe_browser_example
// A key generated on this device and kept in IndexedDB, which no script can export.
const key = await openDeviceKey("device.example/7f3a");
const log = await openBrowserLog({ key });

const receipt = await log.append(new TextEncoder().encode("signed the form"));
```

The layer refuses the mistakes that are easy to make with the full API. `webtessera/server` fails the build of a
browser bundle and refuses to run in a browser; `webtessera/browser` never accepts a private key string. Storage
is durable unless memory is asked for by name, SQLite is locked so that several processes cannot fork the log,
`append` resolves only once a published checkpoint covers the entry, every receipt is verified before it is
returned, and a log refuses to open with a key that did not create it. Receipts are
[C2SP tlog-proofs](https://c2sp.org/tlog-proof), and witnesses, such as your own server running
`webtessera/witness`, can cosign every checkpoint.

The [safe API guide](docs/guides/safe-api.md) covers key custody, receipts, session receipts with a witness, a
notary, and when to use the full API underneath, which every log exposes as `log.reader` and `log.appender`.

## Quick start: the full API

Underneath the safe API is the faithful port of Tessera's own API, for everything the safe API does
not cover: custom storage, migration, antispam, witness policies, Static CT. Pick a storage driver and
start an appender on it:

```ts file=src/README_test.ts region=common_imports
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";

// Choose one!
import { newMemoryDriver } from "webtessera/storage/memory";
// import { newIndexedDBDriver } from "webtessera/storage/indexeddb";
// import { newSqliteDriver, fromSqliteSync } from "webtessera/storage/sqlite";
```

```ts file=src/README_test.ts region=construct_example
const driver = newMemoryDriver();
const signer = createSigner();

const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));
```

The log signs its checkpoints with a [note](https://c2sp.org/signed-note) signer, whose name is the
log's origin:

```ts file=src/README_test.ts region=create_signer_example
// Generate the key pair once. Keep skey secret; publish vkey so that clients can
// verify the log's checkpoints.
const { skey, vkey } = generateKey(undefined, "example.com/my-log");
const signer = newSigner(skey);
```

Adding an entry returns a future that resolves to the index the log durably assigned to it:

```ts file=src/README_test.ts region=use_appender_example
const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));

const index = await appender.add(newEntry(data))();
```

At that point the entry is sequenced and integrated into the tree, but clients can only verify it
once a published checkpoint commits to it, which happens within the checkpoint interval (ten
seconds by default; see `withCheckpointInterval`). If you need to wait for that — to hand back an
inclusion proof, say — use a `PublicationAwaiter`:

```ts file=src/README_test.ts region=await_publication_example
// One awaiter per log, shared by every request: it polls the published checkpoint
// only while somebody is waiting.
const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 100, signal);

const [index, checkpoint] = await awaiter.await(appender.add(newEntry(data)));
```

Call `shutdown()` before you abort the signal passed to `newAppender`: it waits until every entry
the appender accepted is integrated and covered by a published checkpoint.

## Storage drivers

| Driver | Import | Runs in | Persistence |
| --- | --- | --- | --- |
| Memory | `webtessera/storage/memory` | anywhere | none (tests, demos, ephemeral logs) |
| IndexedDB | `webtessera/storage/indexeddb` | browsers, web/service workers | durable, shared between tabs |
| SQLite | `webtessera/storage/sqlite` | wherever a SQLite engine runs (see below) | durable, shared between processes |
| Your own | `webtessera/storage/objectstore` | wherever your store runs | yours |

All of them run the same storage engine, a port of Tessera's POSIX driver, on top of a small
key/value contract. They store every public resource under the path the tlog-tiles spec gives it
(`checkpoint`, `tile/0/x001/234`, `tile/entries/000.p/7`, …), so a store's contents *are* a static
tlog-tiles log, ready to be served over HTTP as they are.

### In the browser

```ts file=src/README_test.ts region=indexeddb_example
// The log survives reloads, and several tabs may share it: Web Locks serialise
// their writes.
const driver = await newIndexedDBDriver({ name: "my-log" }, signal);
const { appender, shutdown } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer), signal);
```

The driver needs the [Web Locks API](https://developer.mozilla.org/docs/Web/API/Web_Locks_API), which
browsers provide in secure contexts (HTTPS and `localhost`). Without it, opening the log throws rather
than run with locks that cannot exclude other tabs, unless you pass `singleWriter: true` to promise that
only one tab or worker will ever write it; `driver.lockScope` tells you which guarantee you got.

See [`examples/browser`](examples/browser) for a complete page you can open in two tabs.

### On any SQLite

The SQLite driver keeps the log in five tables of an ordinary SQLite database, through a small
adapter for the engine you already use. Nothing engine-specific leaks past that adapter: every engine
runs the same store, passes the same conformance suites, and writes byte-identical logs.

```ts file=src/README_test.ts region=sqlite_example
// node:sqlite here; any other engine only changes this line (see the table below).
const database = fromSqliteSync(new DatabaseSync(file));
const driver = await newSqliteDriver({ database }, signal);
const { appender, shutdown } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer), signal);
```

| Engine | Adapter | Default locking |
| --- | --- | --- |
| node:sqlite (Node.js, Deno), bun:sqlite, better-sqlite3 | `fromSqliteSync(db)` | local |
| SQLite compiled to WebAssembly ([sqlite-wasm](https://sqlite.org/wasm)) | `fromSqliteWasm(db)` | local for memory and `opfs-sahpool`, else lease |
| libSQL / Turso | `fromLibsql(client)` | local for `file:` URLs, else lease |
| rqlite 8.32 or later | `fromRqlite({ url })` | lease |
| Cloudflare D1 | `fromD1(db)` | lease |
| SQLite-backed Durable Objects | `fromDurableObjectStorage(ctx.storage)` | local |

The adapters are typed structurally, so webtessera depends on none of these engines. Any other SQLite
can be used by implementing `SqlDatabase`: an async `query` and an atomic `batch`.

- **Locking.** "local" locking serialises the writers of one process. "lease" locking lets several
  processes or instances append to the same database: each lock is a lease renewed while it is held,
  and every write made under a lease is fenced on it in the same transaction, so a writer that stalled
  past its lease can never overwrite what the next holder wrote. Choose `locking: "lease"` explicitly
  when several processes open the same SQLite file.
- **Durability.** An index the appender returns is on durable storage: the in-process adapters raise
  `synchronous` to `FULL`, and the networked engines resolve a write only once they have committed it.
- **Sharing a database.** `namespace` keeps a log in tables of its own, so several logs, or a log and
  your application's own tables, can live in one database.
- **Lifetime.** Create the driver and the appender once per process or instance and keep them:
  batching and checkpoint publication run on timers. When a process stops, the next one resumes from
  the database, and every index the appender returned was already durably integrated.

The limits of each engine (row sizes, bound parameters) are handled for you: any object larger than
`maxChunkBytes` (1 MiB by default) is stored in chunks, and read back whole.

### Bring your own store

Implement `ObjectStore` — `get`, `stat`, `put`, `create`, `deletePrefix` and `lock` — for any
backend and hand it to `newObjectStoreDriver({ store })`. The contract, including the atomicity and
locking guarantees the engine relies on, is documented in
[`src/storage/objectstore/objectstore.ts`](src/storage/objectstore/objectstore.ts). `NamedLocks`, from
the same package, implements the in-process half of `lock`; the shared conformance suites in
`src/storage/objectstore/testing/` show what a backend must pass.

## Reading and verifying a log

The `webtessera/client` package reads any tlog-tiles log — one written by webtessera, by Tessera, or
by any other compatible implementation — and verifies what it reads:

```ts file=src/README_test.ts region=verify_example
const verifier = newVerifier(verifierKey);
const log = newHTTPFetcher(new URL("https://log.example.com/"));

// Fetch the latest checkpoint and check the log's signature on it.
const { checkpoint } = await fetchCheckpoint((s) => log.readCheckpoint(s), verifier, verifier.name());

// Prove that the entry at `index` is committed to by that checkpoint.
const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => log.readTile(l, i, p, s));
const proof = await proofs.inclusionProof(index.index);
verifyInclusion(DefaultHasher, index.index, checkpoint.size, DefaultHasher.hashLeaf(data), proof, checkpoint.hash);
```

A `LogReader` from `newAppender` can stand in for the HTTP fetcher when the log is local.

## Serving, witnessing and mirroring

Three packages put a log to use once it exists. Tessera leaves serving and witnessing to the programs
built on it, and its mirror is an experimental command; here they are libraries. Each one's module
comment (`src/http/index.ts`, `src/witness/index.ts`, `src/mirror/index.ts`) has a worked example.

- **Serving.** `newLogHandler` from `webtessera/http` serves the [tlog-tiles](https://c2sp.org/tlog-tiles)
  read API (the checkpoint, tiles and entry bundles, for `GET` and `HEAD`) from any `LogReader`: the one
  `newAppender` returns, or an `HTTPFetcher`, which turns the handler into a caching proxy for a remote log.
  It is a plain function from `Request` to `Response`, so it runs unchanged in Deno, Bun, Workers and
  service workers, and `toNodeListener` adapts it to `node:http`. It sets the content types and cache
  headers the specification gives, accepts only canonical paths, and adds CORS headers when asked, so
  that a log in a browser tab can be verified from another origin. `combineHandlers` joins several
  handlers into the one function a runtime expects. Appending stays the application's job, as in
  Tessera; `readEntryBody`, `addResponse` and `addErrorResponse` give a `POST /add` endpoint the
  conventions Tessera's own personalities follow.
- **Witnessing.** The root package already holds a log's side of the
  [tlog-witness](https://c2sp.org/tlog-witness) protocol (`newWitnessGroupFromPolicy`, `withWitnesses`).
  `newWitnessServer` from `webtessera/witness` is the other side: it checks that each checkpoint a log
  submits is consistent with the last one it cosigned, then returns a cosignature. It keeps its state in
  any `ObjectStore`, so it runs wherever a log does, and it can be given a fixed list of logs or a
  `lookupLog` function for an open-ended set. Its `handle` is a `webtessera/http` handler, and
  `addCheckpoint` makes the same call without HTTP. `vKeyToCosignatureV1` turns the witness's public key
  into the form a log operator names in a witness policy. A log's witness URLs must use `https`, or
  `http` for a loopback address.
- **Mirroring.** `Mirror` from `webtessera/mirror` is the port of Tessera's experimental mirror: it
  copies the tiles and entry bundles a target lacks, in parallel, and writes the source checkpoint last.
  Like the original, it copies bytes without checking them, so for a log you do not operate use
  `newVerifiedMirror`: it checks the log's signature on the checkpoint, that the checkpoint extends what
  was mirrored before, and every tile and bundle against it, before anything is written. A target is any
  `ObjectStore`, a bucket on a service that speaks the S3 API (AWS S3, Cloudflare R2 or MinIO, say)
  through `newS3Sink`, which signs requests with AWS Signature Version 4 over `fetch` and needs no SDK, or
  anything with a `put` method.

## Packages

The package is split the way Tessera is split into Go packages:

| Import | Go counterpart | Contents |
| --- | --- | --- |
| `webtessera` | `tessera` | appender, options, publication awaiter, antispam, witnessing, migration |
| `webtessera/client` | `tessera/client` | fetchers, proof building, entry streaming, log state tracking |
| `webtessera/storage/*` | `tessera/storage/*` | storage drivers (see above) |
| `webtessera/storage/sqlite` | — | the SQLite driver and one adapter per engine |
| `webtessera/api`, `webtessera/api/layout` | `tessera/api`, `tessera/api/layout` | tile and entry-bundle formats, tlog-tiles paths |
| `webtessera/fsck` | `tessera/fsck` | whole-log verification |
| `webtessera/ctonly` | `tessera/ctonly` | Static CT API entries |
| `webtessera/server` | — (safe API) | `openServerLog`, `importLogKey`, receipts; refuses to run in browsers |
| `webtessera/browser` | — (safe API) | `openBrowserLog`, device keys, receipts |
| `webtessera/testonly` | `tessera/testonly` | an in-memory test log for your own tests |
| `webtessera/http` | — | serves a log over the tlog-tiles HTTP API, as a fetch-style handler |
| `webtessera/witness` | — | a tlog-witness server, the other side of the witnessing in `webtessera` |
| `webtessera/mirror` | `tessera/cmd/experimental/mirror` | copies a log into S3-compatible storage or any `ObjectStore` |
| `webtessera/note` | `golang.org/x/mod/sumdb/note` | signed notes, signers and verifiers |
| `webtessera/formats/log` | `transparency-dev/formats/log` | checkpoints |
| `webtessera/formats/proof` | `transparency-dev/formats/proof` | [C2SP tlog-proof](https://c2sp.org/tlog-proof) encoding |
| `webtessera/merkle/*` | `transparency-dev/merkle/*` | RFC 6962 hashing, compact ranges, proofs |

Names follow Go's, with functions in camelCase (`NewAppender` is `newAppender`). Go's `uint64` is
`bigint`, durations are milliseconds, errors are thrown with Go's message text, and
`context.Context` is an optional trailing `AbortSignal`.

## Fidelity and compatibility

webtessera is a translation, not a reimplementation, and is built to be reviewed against the
original:

- Every source file mirrors an upstream file of the same name, with the upstream comments carried
  over. [`docs/PORTING-MAP.md`](docs/PORTING-MAP.md) tracks the status of every Go file, and each
  divergence, however small, is recorded as an ADR in [`docs/decisions`](docs/decisions).
- The golden fixtures in [`fixtures/data`](fixtures/data) are produced by running the real Tessera,
  at a pinned commit, through the Go program in [`fixtures/gen`](fixtures/gen). The tests assert
  byte-for-byte equality against them — tiles, entry bundles, checkpoints, proofs, notes — and CI
  regenerates them from upstream and fails on any difference.
- The same golden suite runs against every storage backend — memory, IndexedDB and each SQLite
  engine — and a Go interop test has Tessera's Go client verify logs written by webtessera, and
  webtessera continue logs written by Tessera, byte for byte.
- The test suites run in Node, in a real Chromium, in workerd, and against live rqlite and
  S3-compatible servers.

## Runtime support

Node.js 22 or later, Deno 2, Bun, current browsers (IndexedDB and Web Locks for the IndexedDB driver),
and edge runtimes built on web standards. CI runs the test suites on Node 22 and 24, in Chromium
and in workerd, and an end-to-end smoke test of the built package, including the SQLite driver, on
Node, Bun and Deno. The published build is ES2022.

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains the setup and the workflow,
and [`AGENTS.md`](AGENTS.md) the porting rules every change follows. To report a vulnerability,
see [`SECURITY.md`](SECURITY.md).

## License

Apache License 2.0; see [`LICENSE`](LICENSE). Files translated from Go's own libraries
(`golang.org/x/mod/sumdb/note`, parts of `golang.org/x/crypto` and the standard library) keep their
BSD 3-Clause license, reproduced in [`LICENSES`](LICENSES); [`NOTICE`](NOTICE) lists every source.

webtessera exists because of the work of the Tessera authors, to whom it owes its design, its
comments, and its tests.
