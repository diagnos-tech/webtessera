# Choosing storage

This guide compares the storage that webtessera supports and explains how locking keeps a log from
forking; read it before you decide where a log lives.

Every backend holds the same thing: objects under [tlog-tiles](https://c2sp.org/tlog-tiles) paths
(`checkpoint`, `tile/0/x001/234`, `tile/entries/000.p/7`, …) plus a little private state under
`.state/`, byte for byte as Tessera's POSIX driver writes them. A store's contents are therefore a
static tlog-tiles log, ready to be served over HTTP as they are. All backends run the same storage
engine, a port of that POSIX driver, on a six-method key/value contract.

What differs is how long the log lasts, where it runs, and **who else can write it at the same
time**. Two writers that do not exclude each other fork the log, and no client trusts a forked log
again.

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

Each section names the safe API option and the ported API call for that storage.

## Memory

- Safe API: `storage: { memory: true }`, with `openServerLog` or `openBrowserLog`.
- Ported API: `newMemoryDriver()` from `webtessera/storage/memory`.

The safe API makes you ask for memory by name. A log in memory loses its tree when the process ends,
while its checkpoints live on in clients, so the next log under the same key cannot be consistent with
them. Use it for tests, and for logs whose receipts never outlive the process.

## IndexedDB

- Safe API: the default storage of `openBrowserLog`, a database named after the log's origin
  (`webtessera-log:<origin>`). Pass `storage: { indexedDB: name }` to choose the name.
- Ported API: `newIndexedDBDriver({ name }, signal)` from `webtessera/storage/indexeddb`.

Every tab and worker of the page's origin opens the same database, and **Web Locks**
(`navigator.locks`) make their writes take turns: `lockScope` is `"origin"`.

Browsers provide Web Locks only in secure contexts (HTTPS and `localhost`). Without them, opening the
log **throws**, rather than run with locks that cannot exclude other tabs. If one tab or worker is
certainly the only writer, say so with `singleWriter: true`; `lockScope` is then `"realm"`.
`singleWriter` has no effect where Web Locks exist. Ask for `navigator.storage.persist()` for a log
that matters; see [a client-only log](client-only-log.md).

## SQLite

- Safe API: `storage: { sqlite: adapter, namespace?, locking?, lease? }` with `openServerLog`.
- Ported API: `newSqliteDriver({ database: adapter }, signal)`, or `openSqliteObjectStore` for the
  store alone, from `webtessera/storage/sqlite`.

The SQLite backend keeps the log in five tables of an ordinary SQLite database, through an adapter for
the engine you already use. Every engine runs the same store, passes the same conformance suites, and
writes byte-identical logs. `namespace` keeps a log in tables of its own, so several logs, or a log
and your application's tables, can share one database.

| Engine | Adapter | Locking when none is chosen |
| --- | --- | --- |
| node:sqlite (Node 22.13+, Deno 2.2+), bun:sqlite, better-sqlite3 | `fromSqliteSync(db)` | `"local"` for an in-memory or temporary database, `"lease"` for a file |
| SQLite in WebAssembly ([sqlite-wasm](https://sqlite.org/wasm)) | `fromSqliteWasm(db)` | `"local"` in memory or a private VFS (`memdb`, `opfs-sahpool`), `"lease"` otherwise |
| libSQL, Turso | `fromLibsql(client)` | `"local"` for an in-memory database, `"lease"` for a `file:` database, an embedded replica or a remote database |
| rqlite 8.32 or later | `fromRqlite({ url })` | `"lease"` |
| Cloudflare D1 | `fromD1(env.DB)` | `"lease"` |
| SQLite-backed Durable Objects | `fromDurableObjectStorage(ctx.storage)` | `"local"` |

The adapters are typed structurally, so webtessera depends on none of these engines. For any other
engine, implement `SqlDatabase`: an async `query` and an atomic `batch`.

Every adapter fails closed: it answers `"lease"` unless it can show that nothing outside this
JavaScript realm can reach the database, and a custom `SqlDatabase` that does not say gets `"lease"`
too ([ADR-0210](../decisions/0210-sqlite-locking-fails-closed.md)). Both APIs keep the adapter's
default unless you pass `locking`.

### Lease or local?

- **`"lease"`** locks are rows in the database, held for a bounded time (`lease.ttlMs`, 30 s by
  default) and renewed while held, and every write made under a lease is fenced on it in the same
  transaction. They exclude every connection, process, isolate or machine that reaches the database,
  and a writer that stalls past its lease can never overwrite what the next holder wrote. They are
  correct for every database. They cost the lease's own writes: about a third of append throughput on
  a file at the default batch size.
- **`"local"`** locks are held in memory and exclude only the stores of this JavaScript realm.
  Choosing them declares that this realm is the database's only writer, as IndexedDB's `singleWriter`
  does. They suit a database that is private by construction: in memory, a Durable Object's, a
  WebAssembly SQLite in a private VFS.

Two rules follow. **Declare a single writer only where there is one**: `locking: "local"` over a
database that another process can open forks the log the first time two of them append; the
adapter's default never does. And **every store over one database must use the same locking**: local
locks and leases do not see each other.

A libSQL embedded replica, or any setup that serves reads from a replica, is not safe for a log that
several clients write, with either locking.

### Busy timeouts

Writers on one file also wait for each other's SQLite locks. `fromSqliteSync` gives its connection a
5 s busy timeout when it has none. `fromLibsql` cannot: the libSQL client keeps a pool of connections,
and only its own `timeout` option reaches all of them. So when other processes or clients also open a
libSQL `file:` database, create its client with a busy timeout, `createClient({ url, timeout: 5000 })`.
Without one, a writer that meets another's lock fails with `SQLITE_BUSY` instead of waiting. The log is
not forked, and the error says what to change.

### Durability and lifetime

- **Durability.** An index or receipt the log hands back is on durable storage. The in-process
  adapters raise `synchronous` to `FULL`, and the networked engines resolve a write only once they
  have committed it.
- **Lifetime.** Create the log (or the driver and the appender) once per process or instance, and
  keep it: batching and checkpoint publication run on timers. When a process stops, the next one
  resumes from the database, and every index already returned was durably integrated.
- **Engine limits.** Row sizes and bound-parameter limits are handled for you: an object larger than
  `maxChunkBytes` (1 MiB by default) is stored in chunks and read back whole.

## Your own ObjectStore

- Safe API: `storage: { objectStore }`.
- Ported API: `newObjectStoreDriver({ store })` from `webtessera/storage/objectstore`.

Implement `ObjectStore`: `get`, `stat`, `put`, `create`, `deletePrefix` and `lock`. The contract, in
[`src/storage/objectstore/objectstore.ts`](../../src/storage/objectstore/objectstore.ts), is the whole
specification: every operation atomic per key and durable when it resolves, and **`lock` excluding
every holder that can reach the same data**, which is the part that keeps the log from forking.
`NamedLocks`, from the same package, implements the in-process half of `lock`. The conformance suites
in `src/storage/objectstore/testing/` show what a backend must pass.

ObjectStores also hold other state that needs the same guarantees: the witness server keeps its
latest cosigned checkpoints in one, and its check-then-write is atomic only because `lock` excludes
every writer.

## S3-compatible buckets, and other sinks

A bucket is not storage for a live log, because S3 has no lock the log could rely on. It is the
natural place to **publish** one: `webtessera/mirror` copies a log into any S3-compatible bucket with
`newS3Sink`, into any `ObjectStore`, or into anything with `put(key, bytes)`, writing the checkpoint
last, so the bucket is a static tlog-tiles log that any CDN can serve. Use `newVerifiedMirror` for any
log you do not operate, or any upload you do not trust. [Mirror a log](serve-witness-mirror.md#mirror-a-log)
covers both.
