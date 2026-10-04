# Choosing storage

A log is a set of objects under [tlog-tiles](https://c2sp.org/tlog-tiles) paths (`checkpoint`,
`tile/0/x001/234`, `tile/entries/000.p/7`, …) plus a little private state, and every storage webtessera
supports holds exactly that, byte for byte as Tessera's POSIX driver writes it. What differs is how
long it lasts, where it runs, and **who else can write it at the same time**: two writers that do not
exclude each other fork the log, and a forked log is one no client will trust again. This guide
covers each option, and the locking that decides that last question.

## At a glance

| Storage | Runs in | Lasts | Writers it excludes | Use it for |
| --- | --- | --- | --- | --- |
| Memory | anywhere | until the process or page ends | this realm | tests, demos, ephemeral logs |
| IndexedDB | browsers, workers | until site data is cleared or evicted | every tab and worker of the origin (Web Locks) | a device's own log |
| SQLite, local file | Node, Bun, Deno, sqlite-wasm | durable | every process, with lease locking | a log on a server |
| SQLite, networked (D1, rqlite, Turso) | wherever the client runs | durable | every instance, with lease locking | a log shared by many instances |
| Durable Object | Cloudflare Workers | durable | the one instance (local locking) | a log at the edge |
| Your own ObjectStore | anywhere | yours to decide | yours to guarantee | anything else |
| S3-compatible bucket | via `newS3Sink` | durable | — (a mirror target, not a live log) | publishing, mirroring, committing |

## Memory

`{ memory: true }` with `openServerLog` or `openBrowserLog`. The safe API makes you ask for it by name,
because a log in memory loses its tree when the process ends while its checkpoints live on in
clients: the next log under the same key cannot be consistent with them. Use it for tests, and for
logs whose receipts never outlive the process.

## IndexedDB

The default storage of `openBrowserLog`, in a database named after the log's origin
(`webtessera-log:<origin>`). Every tab and worker of the page's origin opens the same database, and
**Web Locks** (`navigator.locks`) make their writes take turns: `log.lockScope` is `"origin"`.

Browsers provide Web Locks only in secure contexts (HTTPS and `localhost`). Without them the log
**refuses to open**, rather than run with locks that cannot exclude other tabs. If one tab is
certainly the only writer, say so: `storage: { indexedDB: name, singleWriter: true }`
(`lockScope` is then `"realm"`). Ask for `navigator.storage.persist()` for a log that matters; see
[a client-only log](client-only-log.md).

## SQLite

`webtessera/storage/sqlite` keeps the log in five tables of an ordinary SQLite database, through an
adapter for the engine you already have. Every engine runs the same store and writes byte-identical
logs; `namespace` keeps several logs (or a log and your own tables) apart in one database.

| Engine | Adapter | Locking when none is chosen |
| --- | --- | --- |
| node:sqlite (Node 22.13+, Deno 2.2+), bun:sqlite, better-sqlite3 | `fromSqliteSync(db)` | `"local"` for an in-memory or temporary database, `"lease"` for a file |
| SQLite in WebAssembly ([sqlite-wasm](https://sqlite.org/wasm)) | `fromSqliteWasm(db)` | `"local"` in memory or a private VFS (`memdb`, `opfs-sahpool`), `"lease"` otherwise |
| libSQL, Turso | `fromLibsql(client)` | `"local"` for an in-memory `file:` database, `"lease"` otherwise |
| rqlite | `fromRqlite({ url })` | `"lease"` |
| Cloudflare D1 | `fromD1(env.DB)` | `"lease"` |
| SQLite-backed Durable Objects | `fromDurableObjectStorage(ctx.storage)` | `"local"` |

That column is what the ported API (`newSqliteDriver`, `openSqliteObjectStore`) and the safe API's
`openServerLog` do. Every adapter fails closed: it answers `"lease"` unless it can show that nothing
outside this JavaScript realm can reach the database, and a custom `SqlDatabase` that does not say gets
`"lease"` too ([ADR-0210](../decisions/0210-sqlite-locking-fails-closed.md)). Pass `locking` to
override it.

### Lease or local?

- **`"lease"`** locks are rows in the database, held for a bounded time (`lease.ttlMs`, 30 s by
  default) and renewed while held, and every write made under a lease is fenced on it in the same
  transaction. They exclude every connection, process, isolate or machine that reaches the database,
  and a writer that stalls past its lease can never overwrite what the next holder wrote. They are
  correct for every database; they cost a few writes per lock.
- **`"local"`** locks are held in memory and exclude only the stores of this JavaScript realm.
  Choosing them declares that this realm is the database's only writer, as IndexedDB's `singleWriter`
  does. They suit a database that is private by construction: in memory, a Durable Object's, a
  WebAssembly SQLite in a private VFS.

Two rules follow. **Declare a single writer only where it is one**: `locking: "local"` over a database
another process can open forks the log the first time two of them append; the adapter's default never
does. And **every store over one database must use the same locking**: local locks and leases do not
see each other.

Writers on one file also wait for each other's SQLite locks. `fromSqliteSync` gives its connection a
5 s busy timeout when it has none. `fromLibsql` cannot do that: the libSQL client keeps a pool of
connections, and only its own `timeout` option reaches all of them. So create a libSQL client for a
`file:` database that other processes or clients also open with a busy timeout,
`createClient({ url, timeout: 5000 })`. Without one, a writer that meets another's lock fails with
`SQLITE_BUSY` instead of waiting. The log is not forked, and the error says what to change
([ADR-0210](../decisions/0210-sqlite-locking-fails-closed.md)).

Durability: an index or receipt the log hands back is on durable storage. The in-process adapters
raise `synchronous` to `FULL`, and the networked engines resolve a write only once committed.

## Your own ObjectStore

Implement `ObjectStore` from `webtessera/storage/objectstore` (`get`, `stat`, `put`, `create`,
`deletePrefix`, `lock`) and pass `storage: { objectStore }`. The contract, in
[`src/storage/objectstore/objectstore.ts`](../../src/storage/objectstore/objectstore.ts), is the whole
specification: every operation atomic per key and durable when it resolves, and **`lock` excluding
every holder that can reach the same data**, which is the part that keeps the log from forking. The
conformance suites in `src/storage/objectstore/testing/` show what a backend must pass.

ObjectStores also hold other state that needs the same guarantees: the witness server keeps its
latest cosigned checkpoints in one, and its check-then-write is atomic only because `lock` excludes
every writer ([session receipts](session-receipts.md)).

## S3-compatible buckets, and other sinks

A bucket is not a live log's storage (S3 has no lock the log could rely on), but it is the natural
place to **publish** one: `webtessera/mirror` copies a log into any `Sink`, writing every tile and
bundle with the `Content-Type` and `Cache-Control` tlog-tiles prescribes, and the checkpoint last, so
the bucket is a static tlog-tiles log any CDN can serve.

- `newS3Sink({ endpoint, bucket, region, accessKeyId, secretAccessKey, prefix })` for AWS S3,
  Cloudflare R2, Google Cloud Storage (XML API), Backblaze B2, MinIO, Ceph and the like, signed with
  SigV4 over `fetch`, with conditional writes so that a bucket never ends up holding two trees.
- Any `ObjectStore` is a sink as it is, and so is anything with `put(key, bytes)` (an R2 binding, a
  wrapper around another SDK); `get` lets a mirror resume.
- `newVerifiedMirror` checks the source's signature, its consistency with what was mirrored before,
  and every resource against the checkpoint, before writing anything: use it for any log you do not
  operate, or any upload you do not trust ([session receipts](session-receipts.md) commits with it).

The library's own S3 tests, and the session-receipts example's, run against a real bucket when
`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set.
