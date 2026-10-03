# ADR-0154: `webtessera/storage/sqlite` exports `newSqliteDriver`, the store, and one adapter per engine

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go` (`New`, `Config`); no upstream counterpart for SQLite engines

## Context

Every upstream driver has a one-call constructor whose result a personality hands to `NewAppender`. The port's
other backends follow suit: `newMemoryDriver(cfg)` and `newIndexedDBDriver(cfg, signal)` return the engine's
`ObjectStoreDriver`, and their stores are exported for callers that need them (ADR-0104, ADR-0113). The
package's `exports` map already reserves `./storage/sqlite`. ADR-0123's `webtessera/storage/durableobject`
goes with the backend it exported (ADR-0150).

## Decision

`src/storage/sqlite/index.ts`, published as `webtessera/storage/sqlite`, exports:

- `newSqliteDriver(cfg: SqliteDriverConfig, signal?): Promise<ObjectStoreDriver>`: opens the store and returns
  `newObjectStoreDriver({ store, fetch })`, interchangeable with the other backends' drivers. It is
  asynchronous because opening creates or checks the tables; `signal` bounds only the opening, and the database
  stays the caller's.
- `openSqliteObjectStore(opts: SqliteObjectStoreOptions, signal?): Promise<SqliteObjectStore>`, for callers that
  need the store itself (to read resources without an appender, to build a migration target, to wrap it). The
  `SqliteObjectStore` interface adds `locking` and `namespace` to `ObjectStore`.
- The options: `database` (required), `namespace`, `locking`, `maxChunkBytes`, `lease` (`ttlMs`,
  `renewIntervalMs`, `maxPollIntervalMs`), `clock`; and `SqliteDriverConfig` adds `fetch`.
- The adapters, each with its structural engine types: `fromSqliteSync` (`SqliteSyncDatabase`,
  `SqliteSyncStatement`), `fromSqliteWasm` (`SqliteWasmDatabaseLike`, `SqliteWasmExecOptions`), `fromLibsql`
  (`LibsqlClientLike`, `LibsqlStatementLike`, `LibsqlResultSetLike`), `fromD1` (`D1DatabaseLike`,
  `D1PreparedStatementLike`), `fromDurableObjectStorage` (`DurableObjectStorageLike`,
  `DurableObjectSqlStorageLike`, `DurableObjectSqlCursorLike`), `fromRqlite` (`RqliteOptions`,
  `RqliteReadLevel`).
- The engine-neutral interface for other engines: `SqlDatabase`, `SqlStatement`, `SqlRow`, `SqlValue`,
  `SqliteLocking`.
- `ErrLeaseLost`, the sentinel cause of a fenced-out write (ADR-0152); `DefaultMaxChunkBytes`; and
  `SchemaVersion`, the version of the tables this release writes.

Adapter names say what they take (`fromD1(env.DB)`, `fromDurableObjectStorage(ctx.storage)`), not a vendor
product line, and the documentation presents every engine with equal weight. `fromSqliteSync` names the shape
three bindings share rather than one of them.

## Consequences

- Swapping engines changes one adapter call; everything else, including the tables, is identical, so a log
  can be moved between engines with any SQLite tool or with `newMigrationTarget`.
- The structural types are public API: widening what an adapter calls on its engine is a breaking change for
  users who pass their own objects, and needs a minor version and a CHANGELOG entry.
- The barrel exports nothing Go-unexported because the package has no Go counterpart; internals (`keys.ts`,
  `schema.ts`, `lease.ts`) stay reachable only by importing their files, as tests do.

## Alternatives considered

- **One `newSqliteDriver` that detects the engine from the object passed.** Duck-typing a D1 binding against a
  libSQL client against a node:sqlite connection is fragile and hides which semantics (locking default,
  clock) apply; explicit adapters make the choice visible at the call site.
- **One package entry point per adapter (`webtessera/storage/sqlite/d1`, …).** More entries for a few hundred
  bytes each; the package is `sideEffects: false`, so bundlers drop the adapters a program does not import.
- **A synchronous constructor that creates tables lazily on first use.** Hides schema-version errors until the
  first write and complicates every method; opening is the natural place to fail.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

## Update (2026-10-03)

API changes from the security review:

- `SqlDatabase.defaultLocking` is `SqliteLocking | (() => Promise<SqliteLocking>) | undefined`, and
  undefined now means lease ([ADR-0210](0210-sqlite-locking-fails-closed.md)). `fromLibsql`'s is a function
  for `file:` clients.
- `RqliteOptions.followRedirects` is new, and `fromRqlite` throws a `RangeError` for a `level` other than
  `"linearizable"` or `"strong"` ([ADR-0213](0213-rqlite-and-s3-requests-omit-credentials-and-refuse-redirects.md)).
- `SchemaVersion` is 2 ([ADR-0211](0211-sqlite-fence-on-a-not-null-column.md)).
- `openSqliteObjectStore` rejects a database that does not store text as UTF-8 (ADR-0151's update), and
  lease timings that are not positive whole milliseconds.
