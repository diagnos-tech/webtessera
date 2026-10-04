# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below
1.0.0, minor releases may contain breaking changes; they are called out here.

## [Unreleased]

Initial public release.

webtessera is a faithful TypeScript port of
[Tessera](https://github.com/transparency-dev/tessera) (pinned at commit `4a6d9f9`), the tile-based
transparency log framework, for browsers, servers and edge functions. A log lives in memory, in
IndexedDB, in any SQLite engine, or in a store of your own, and is byte-for-byte the log Tessera
writes. File names, declaration order, comments and error messages follow the Go source; every
divergence is recorded in an ADR under `docs/decisions/`, and every upstream file has a row in
`docs/PORTING-MAP.md`.

### Added

- **The safe API**, a small layer over the port for applications that want a log they cannot misuse
  (ADR-0220 to ADR-0227). `webtessera/server` (`openServerLog`, `importLogKey`) is for servers and edge
  runtimes: it fails the build of a browser bundle and refuses to run in a browser. `webtessera/browser`
  (`openBrowserLog`, device keys kept in IndexedDB) never accepts a private key string. Both use
  non-extractable WebCrypto Ed25519 keys where the runtime has them (falling back to `@noble/curves`
  only when asked), resolve `append` only once a published checkpoint covers the entry, and return
  [C2SP tlog-proof](https://c2sp.org/tlog-proof) receipts that are verified before they are returned and
  verify offline with `verifyReceipt`.
- **Examples and guides**, one per use case, each a small tested application built on the safe API:
  `client-only` (a browser's own log), `session-receipts` (a browser log witnessed by its server and
  mirrored to S3-compatible storage), `notary` (offline-verifiable receipts for signed digests),
  `log-server` (one source on Node, Bun and Deno, on any SQLite), `monitor` (fork and rollback detection)
  and `edge` (a Worker on a SQLite-backed Durable Object). `docs/guides/` has a guide for each, and one
  on choosing storage.
- **`webtessera/formats/proof`**, a port of `transparency-dev/formats`'s `proof` package (v0.1.1).
- **Async signers**: `note.signAsync`, `AsyncSigner` and `AppendOptions.withCheckpointAsyncSigner`, so a
  log can sign with a key that never leaves WebCrypto (ADR-0223). The synchronous path is unchanged.
- **The Tessera port**: the `api` and `api/layout` packages (tlog-tiles paths, tiles and entry
  bundles), the integration engine and queue (`storage/internal`), the append lifecycle (`Appender`,
  await, antispam), witnessing (a log's side: witnesses, witness groups and the policy language),
  migration, and the root-package entry types.
- **Package root and subpaths**: `webtessera` re-exports the names Tessera's root package exports
  (`newAppender`, `newEntry`, `newPublicationAwaiter`, `newWitnessGroupFromPolicy`, `newMigrationTarget`,
  `newCertificateTransparencyAppender` and the rest), and each Go sub-package has a subpath:
  `webtessera/api`, `/api/layout`, `/client`, `/fsck`, `/ctonly`, `/storage/objectstore`,
  `/storage/memory`, `/storage/indexeddb`, `/storage/sqlite`, `/http`, `/witness`, `/mirror` and
  `/testonly`.
- **`client`**: log-state tracking with consistency verification, an HTTP fetcher, proof building and
  entry streaming.
- **`fsck`**: log verification against a fetcher, with progress reporting.
- **Certificate Transparency**: the `ctonly` entry types and the CT-only lifecycle (RFC 6962
  leaf encoding on top of `cryptobyte`): `newCertificateTransparencyAppender`, and `withCTLayout` for
  both append and migration options.
- **Ports of Tessera's dependencies**, importable as subpaths: `merkle/rfc6962`, `merkle/compact`,
  `merkle/proof` (from `transparency-dev/merkle`), `note` (from `golang.org/x/mod/sumdb/note`),
  and `formats/log` (from `transparency-dev/formats`). The cosignature/v1 key functions of
  `transparency-dev/formats/note` are ported too and re-exported by `webtessera/witness`.
- **Storage**: the `ObjectStore` contract (`webtessera/storage/objectstore`), a driver ported from
  Tessera's POSIX driver that runs on top of it (`newObjectStoreDriver`), and these backends:
  - **memory** (`newMemoryDriver`);
  - **IndexedDB** (`newIndexedDBDriver`): browser persistence with strict durability and cross-tab
    locking through Web Locks;
  - **SQLite** (`webtessera/storage/sqlite`: `newSqliteDriver`, `openSqliteObjectStore`): the log in
    five tables of an ordinary SQLite database, through one small adapter per engine: node:sqlite,
    bun:sqlite and better-sqlite3 (`fromSqliteSync`), libSQL/Turso (`fromLibsql`), rqlite
    (`fromRqlite`), Cloudflare D1 (`fromD1`), SQLite-backed Durable Objects
    (`fromDurableObjectStorage`) and sqlite-wasm (`fromSqliteWasm`). The adapters are typed
    structurally, so webtessera depends on none of the engines, and any other SQLite can be used by
    implementing `SqlDatabase`. Locking is a renewed lease with fencing in the database (`lease`), the
    default for every database another process or connection could reach, or in-process (`local`) for a
    private database or a declared single writer; objects larger than
    `maxChunkBytes` are chunked to fit each engine's row limits; `namespace` keeps several logs, or a
    log and your own tables, in one database; the schema is versioned.

  `NamedLocks`, the in-process half of `ObjectStore.lock`, is exported so that a custom store can
  reuse it. One conformance suite holds every backend to the same behaviour.
- **Serving** (`webtessera/http`): `newLogHandler` serves the tlog-tiles read API (checkpoint, tiles and
  entry bundles, `GET` and `HEAD`) from any `LogReader`, as a fetch-style handler that runs in Deno,
  Bun, Workers, service workers and, through `toNodeListener`, `node:http`. It sets the specification's
  content types and cache headers, accepts only canonical paths, and adds CORS headers when asked.
  `combineHandlers` composes handlers; `readEntryBody`, `addResponse` and `addErrorResponse` give a
  `POST /add` endpoint Tessera's conventions.
- **Witnessing** (`webtessera/witness`): `newWitnessServer`, a C2SP tlog-witness server that checks each
  checkpoint against the last one it cosigned for the same log, for a fixed list of logs or an
  open-ended set (`lookupLog`), with its state in any `ObjectStore` and timestamped cosignature/v1
  signatures. It is the other side of the witness client in the root package; a Tessera appender
  witnessed by it is part of the test suite. The optional `sign-subtree` call and ML-DSA cosignatures
  are not implemented.
- **Mirroring** (`webtessera/mirror`): `Mirror`, the port of Tessera's experimental mirror
  (`cmd/experimental/mirror/internal/mirror.go`), which copies a log's tiles and entry bundles in
  parallel and writes the source checkpoint last. It also fixes a hang upstream has when the source is
  fewer entries ahead than there are workers. `newVerifiedMirror` verifies the source's signature on the
  checkpoint, that the checkpoint extends what was mirrored before, and every tile and bundle against it,
  before writing anything. Targets are any `ObjectStore`, any store with a `put` method, or a bucket on a
  service that speaks the S3 API, such as AWS S3, Cloudflare R2 or MinIO (`newS3Sink`), signed with AWS
  Signature Version 4 on `@noble/hashes`, with no SDK; CI runs the S3 tests against MinIO.
- **Test helpers**: `webtessera/testonly` provides `newTestLog`, a ready-made log on the memory driver with
  its own signing key, for testing code built on webtessera, as Tessera's `testonly` package does for Go.
- **Documentation and project tooling**: contributor guide, `PORTING.md` (the fidelity rules), ADRs, the porting map, `docs/compatibility.md`, `docs/RELEASING.md`, a
  security policy, a landing page generated from the code, and CI on Node 22 and 24, real Chromium,
  workerd, and live rqlite and S3-compatible servers, with a smoke test of the built package on Node, Bun
  and Deno. The README's code snippets run as tests, and a check fails if `README.md` drifts from them.
  Releases publish one tested tarball, with provenance, to npm and GitHub Packages.

### Behaviour and API details

Details of the API that a caller would otherwise find out the hard way. Where the port differs from Go,
an ADR says why.

- `PublicationAwaiter.await` returns `[Index, Uint8Array]`: Go's nil checkpoint never reaches a
  caller, because a successful `await` always has one.
- The SQLite schema is version 2, and `SqlDatabase.defaultLocking` may be a function, so that an
  adapter can ask the database whether it is private. `RqliteOptions.followRedirects` and
  `AddErrorResponseOptions` are new.
- `Follower.follow` is typed `void | Promise<void>` and is started as a detached task, as Go starts it
  on a goroutine: it must not block, owns its own errors, and must return when its signal is aborted
  (ADR-0180).
- `MigrationOptions.withAntispam(null)` does nothing, as `WithAntispam(nil)` does in Go.
- An `add` that arrives while `shutdown` is running waits for `shutdown` to finish, then fails, as Go's
  read lock makes it do.
- Witness URLs in a policy are kept as written, as Go keeps them, and not normalised by the platform URL
  parser; only the scheme is lower-cased. Bytes that are not validly percent-encoded are kept rather than
  re-escaped, and a few malformed URLs that Go rejects are accepted (ADR-0078).
- `newHTTPFetcher(url, fetch, { redirect })` takes the Fetch API's redirect mode, which defaults to
  following redirects, as Go's client does (ADR-0197).
- `fsck` reports a failing worker as `failed: <error>` and stops, where Go hangs when run with one
  worker.

### Security

Hardening beyond Tessera, from input validation that upstream lacks. None of it changes the bytes of a
valid log.

- **SQLite locking fails closed**: stores default to lease locking unless the adapter shows the database
  is private, and an explicit `locking: "local"` declares a single writer. Otherwise two connections or
  processes on one file could assign one index twice, and two witnesses could roll a log back
  (ADR-0210). The lease fence is a NOT NULL column that `PRAGMA ignore_check_constraints` cannot turn
  off (schema version 2, ADR-0211). A database whose text encoding is not UTF-8 is refused at open
  (ADR-0151).
- **Mirroring**: the S3 sink accepts a 412 only over identical bytes, and otherwise fails before the
  checkpoint is written. `newSinkTarget(s3, { prefix })` keeps metadata and conditional writes. A
  verified mirror verifies afresh on every run, refuses overlapping runs and copies what it verifies
  (ADR-0175, ADR-0176).
- **HTTP and witness inputs**: `toNodeListener` accepts only origin-form request-targets; every size
  cap and count must be a positive integer; `addErrorResponse` answers 500 without the error's text
  unless asked for `{ detail: true }` (ADR-0212). `newWitnessServer` requires cosignature/v1 signers,
  and caches its key checks for `lookupLog` (ADR-0171).
- **rqlite and S3 requests** omit credentials; rqlite refuses redirects unless `followRedirects: true`,
  and reads only at `linearizable` or `strong` (ADR-0213).
- **Entries**: `newEntry` throws for data longer than 65535 bytes, which an entry bundle cannot encode,
  where Go silently truncates the length prefix (ADR-0182). Big-endian length prefixes reject values their
  width cannot hold (ADR-0200).
- **Checkpoint publication fails closed**: a checkpoint is published only if it parses and commits to
  exactly the size and root requested, and a new tree is never started over a published checkpoint when
  the tree state is missing (ADR-0205). When a witness fails and `failOpen` is set, the checkpoint
  published after an error other than an unmet policy is the log-signed one, not an empty one
  (ADR-0183).
- **Witness policies and URLs**: a policy that names the same child twice, gives one Ed25519 key two
  witness names, or sets a threshold of 0 is rejected (ADR-0184); witness URLs must use `https`, or `http`
  to a loopback address (ADR-0185); witness requests do not follow redirects, and an update retries a
  stale tree size at most three times (ADR-0197, ADR-0198).
- **Verification**: every hash in a Merkle proof, and every root passed to the verifiers, must be a
  node hash of the hasher's size (ADR-0202); a parsed checkpoint's root must be 32 bytes, and an origin
  must be valid UTF-8 (ADR-0202, ADR-0203); Ed25519 verification follows Go's rules exactly, and a
  verifier configured with a small-order or non-canonical key is refused (ADR-0206);
  `LogStateTracker.update` throws `ErrInconsistency` for a checkpoint of the tracked size with a
  different root, or a smaller one that is not consistent with it (ADR-0196).
- **Tiles, bundles and responses**: a tile or an entry bundle holding more than the tlog-tiles maximum
  of 256 hashes or entries is rejected, response bodies are read with a size cap, and the log fetcher and the
  witness client omit credentials on every request (ADR-0194, ADR-0195, ADR-0197).
- **Locks**: opening an IndexedDB log without Web Locks throws, unless the caller passes
  `singleWriter: true` to promise that only one tab or worker writes the log;
  `newIndexedDBDriver` returns an `IndexedDBDriver` whose `lockScope` says which guarantee the log has
  (ADR-0201).
- **Numbers**: the exported `uint64` entry points of the Merkle, compact-range and checkpoint code throw
  `RangeError` for a value outside the `uint64` range instead of computing with it (ADR-0207).
  `parseUint`, the hex decoder and `quote` are transcriptions of Go's, so malformed input is accepted or
  rejected as Go does, in time linear in its length (ADR-0204).
- **Worker counts**: `entryBundles`, `entries` and `fsck` reject a worker count below one with a
  `RangeError` instead of hanging (ADR-0192).

### Compatibility evidence

How the claim of byte compatibility with Tessera is proven; `docs/compatibility.md` has the details and
how to reproduce each check.

- **Golden fixtures**: a Go generator that executes the real Tessera and records its output, including
  complete logs with their `.state/` files, and the committed JSON the TypeScript tests assert against
  byte for byte. `bun run upstream` checks out the pinned Tessera source; `bun run fixtures` regenerates the
  fixtures reproducibly, and CI fails if they change.
- **A golden suite for every backend**: the same suite runs on memory, IndexedDB and each SQLite engine, in
  every runtime that engine supports (Node, Chromium, workerd), and requires the backend to store
  exactly the files Tessera's POSIX driver stores for the fixture logs, and to carry on logs Go wrote
  (ADR-0160, ADR-0161).
- **Go interop**: `bun run interop` has Tessera's Go code verify and extend logs that webtessera wrote on
  every backend that runs in Node, and has webtessera verify and extend logs that Go wrote, byte for byte
  (ADR-0162).
- **Differential corpora**: Go's verdicts, error text and outputs on large sets of generated inputs,
  most of them malformed, replayed in Node, Chromium and workerd; every difference is either a named
  divergence with an ADR or a failure.
- **Test parity**: `bun run test:parity` lists every test, example, fuzz target and benchmark of Tessera and
  of the vendored modules, and fails unless each has a passing TypeScript test of the same name or an
  allow-list entry that cites the ADR that leaves it out (ADR-0217).

### Not included

These upstream parts are not part of the port. Where a decision is recorded, the ADR is cited.

- OpenTelemetry tracing and klog logging (ADR-0051, ADR-0061, ADR-0070, ADR-0080).
- `FileFetcher`, which reads a POSIX filesystem (ADR-0064).
- The `fsck` command-line tool and terminal UI (ADR-0093), and the mirror's POSIX command (ADR-0141,
  proposed).
- Tessera's GCP, AWS and MySQL storage drivers, its filesystem-backed POSIX driver as such (the web
  driver reuses its engine over an `ObjectStore`), and its other `cmd/` binaries, load generator and
  integration suite. ADR-0001's register tracks the status of each, and ADR-0141 proposes a disposition for
  every one.
- Persistent antispam indexes (Badger, MySQL, Spanner). The in-memory antispam is included, and the
  `Antispam` interface accepts an implementation supplied from outside (ADR-0141, proposed).
- Durable Object classes that do not use SQLite storage: the adapter needs the SQL API.

### Licensing

The package is Apache-2.0. Files derived from Go sources (`sumdb/note`, `cryptobyte`, the cosignature
code of `formats/note`, and the parts of the standard library listed in `NOTICE`: `container/list`,
`strings`, `strconv`, `unicode`, `math/bits`, `crypto/ed25519`, and the `base64` and `hex` decoders) are
BSD-3-Clause, wholly or in the declarations their headers name; their licence text is in `LICENSES/` and
the attributions are in `NOTICE`. The AWS Signature Version 4 test vectors used by the mirror's tests are Apache-2.0 test material
from AWS C Auth, not part of the published package.

[Unreleased]: https://github.com/diagnos-tech/webtessera/commits/main
