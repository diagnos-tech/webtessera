# ADR-0150: Keep logs in any SQLite through one engine-neutral ObjectStore, replacing the Durable Object KV backend

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go`, `storage/posix/file_ops.go` (the model the ObjectStore
  driver is ported from), `storage/mysql/mysql.go` (upstream's own SQL backend, for contrast); no upstream
  counterpart for the engines below

## Context

ADR-0120 to ADR-0123 gave the port a Durable Object backend over the Durable Object key/value API. That
served exactly one runtime, while the same small `ObjectStore` contract (`src/storage/objectstore/objectstore.ts`)
fits every SQLite: the in-process bindings of Node.js (`node:sqlite`, also in Deno), Bun (`bun:sqlite`) and
better-sqlite3; libSQL and Turso, local or remote; rqlite; Cloudflare D1; SQLite-backed Durable Objects, whose
SQL API is now the recommended storage for new classes; and SQLite compiled to WebAssembly in a browser. The
maintainer's direction is that the public story is "works with any SQLite", vendor-neutral, and that
`webtessera/storage/durableobject` goes: a Durable Object becomes one SQLite engine among others.

The engines differ in everything but SQL: synchronous or asynchronous; transactions through `BEGIN`
(in-process engines), through `batch()` (D1, libSQL), through `transactionSync()` with `BEGIN` forbidden
(Durable Objects) or through an HTTP flag (rqlite); BLOBs returned as `Uint8Array`, `ArrayBuffer`, base64 text
or arrays of numbers; integers as `number`, `bigint` or text; and limits from SQLite's billion bytes per value
down to D1's and Durable Objects' 2,000,000 bytes per row, 100 bound parameters and 100 KB of SQL.

Upstream's MySQL driver is not a model to port: it is a different engine (tiles and bundles in MySQL tables
with its own schema and `SELECT ... FOR UPDATE` locking), and the port's golden fixtures are judged against
the POSIX driver, which the ObjectStore driver already ports.

## Decision

`src/storage/sqlite/` implements the `ObjectStore` contract once, in `sqlite.ts`, over a minimal asynchronous
interface, `SqlDatabase` (`database.ts`):

- `query(statement)` runs one statement and resolves to its rows, keyed by column name;
- `batch(statements)` runs several in order as one transaction, all or nothing, and resolves to each one's rows;
- optional hints from the adapter: `defaultLocking` (ADR-0152) and `leaseClock` (ADR-0152).

Statements use anonymous `?` placeholders only (better-sqlite3 treats `?NNN` as named), SQLite 3.35 syntax
(`RETURNING`, UPSERT), and never transaction control. Values are `null | number | bigint | string | Uint8Array`.

One small file per engine under `adapters/` maps an engine handle the caller already has onto that interface.
Every adapter types its engine **structurally**, by the methods it calls, so the library depends on no engine
SDK and no runtime types; a test assigns the real type to the structural one wherever the real types are
installed (workers types, `@libsql/client`, sqlite-wasm).

| Adapter | Engines | Transactions | Default locking |
| --- | --- | --- | --- |
| `fromSqliteSync(db)` | node:sqlite, bun:sqlite, better-sqlite3 | `BEGIN IMMEDIATE`/`COMMIT`, run synchronously | local |
| `fromSqliteWasm(db)` | @sqlite.org/sqlite-wasm OO1 `DB` | the same | local for private VFSes, else lease |
| `fromLibsql(client)` | @libsql/client (file, sqld, Turso) | `batch(…, "write")` | local for `file:`, else lease |
| `fromD1(db)` | Cloudflare D1 binding | `batch()` | lease |
| `fromDurableObjectStorage(ctx.storage)` | SQLite-backed Durable Object | `transactionSync()` | local |
| `fromRqlite({ url, fetch? })` | rqlite ≥ 8.32 over HTTP | `/db/request?transaction` | lease |

`src/storage/durableobject/` is deleted. The Durable Object example now runs on
`newSqliteDriver({ database: fromDurableObjectStorage(ctx.storage) })`.

The store's layout, keys and chunking are ADR-0151; locking and fencing ADR-0152; durability ADR-0153; the
public API ADR-0154; the tests ADR-0155.

## Consequences

- One implementation, held to the shared conformance, driver and golden suites on eight engine
  configurations (ADR-0155), replaces a backend that ran on one runtime.
- KV-backed Durable Objects are no longer supported: their classes have no SQL API. Cloudflare recommends
  SQLite-backed classes for new code, and a class's backend is fixed at creation, so an existing KV-backed log
  would have to be migrated (`newMigrationTarget` into a SQLite-backed object) by its operator.
- Each adapter is a few lines, so supporting another SQLite (a future Deno-native binding, op-sqlite on
  mobile) is a matter of the same few lines, in the library or in user code against `SqlDatabase`.
- The library cannot check engine versions it never imports. The minimums (SQLite 3.35, rqlite 8.32) are
  documented, and a too-old engine fails with its own SQL error on the first statement.

## Alternatives considered

- **Keep the Durable Object KV backend and add SQLite beside it.** Two backends for one runtime, the KV one
  serving only legacy classes; rejected by the maintainer's direction and by the maintenance cost.
- **A synchronous `SqlDatabase`.** Simpler for in-process engines, impossible for D1, libSQL remote and rqlite.
  Sync engines wrap results in resolved promises at negligible cost.
- **An ORM or query builder (Kysely, Drizzle).** A runtime dependency, which AGENTS.md §7 rules out, for a
  dozen fixed statements.
- **One adapter per engine with engine-specific SQL.** The engines all speak SQLite's dialect; the differences
  are transport, transactions and value types, which the adapters absorb. One SQL text per operation keeps
  every engine on the same, tested statements.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
