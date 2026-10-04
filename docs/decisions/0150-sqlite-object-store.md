# ADR-0150: Keep logs in any SQLite through one engine-neutral ObjectStore, replacing the Durable Object KV backend

- **Status:** accepted; its default locking is superseded by ADR-0210
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
- **An ORM or query builder (Kysely, Drizzle).** A runtime dependency, which PORTING.md §7 rules out, for a
  dozen fixed statements.
- **One adapter per engine with engine-specific SQL.** The engines all speak SQLite's dialect; the differences
  are transport, transactions and value types, which the adapters absorb. One SQL text per operation keeps
  every engine on the same, tested statements.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Checked the Decision against `src/storage/sqlite/{database,sqlite,index}.ts` and the six adapters. `SqlDatabase` has exactly `query`, `batch`, `defaultLocking` and `leaseClock`; statements use anonymous `?` only and never transaction control (`StrictSqlDatabase` rejects both, and every engine suite runs through it); the adapter table matches the code, its Default-locking column as amended by ADR-0210; `src/storage/durableobject/` and its export are gone, `./storage/sqlite` is exported, the edge example runs on `fromDurableObjectStorage`, and ADR-0120 to 0123 are marked superseded by 0150 to 0153. There is no Go file to compare with; `storage/posix/files.go` is the model for the driver, not for this layer, and `storage/mysql` is correctly rejected as a model (different engine and schema).
  - Ran, not taken from the author: `vitest` over `src/storage/sqlite src/http src/witness src/mirror` (22 files, 989 tests pass), `src/storage/objectstore src/storage/indexeddb src/storage/memory` (9 files, 286 pass), the workerd config (8 files, 300 pass) and the Chromium config (8 files, 265 pass).
  - Probes beyond the repo's suites (scratch directory, nothing added to the repo): real better-sqlite3 (installed from npm into a scratch directory) through `fromSqliteSync` passes the object-store conformance, driver conformance, SQLite behaviour and golden suites (0, 1, 256 and 1000 entries), which the ADR-0155 stand-in could not show; `scripts/smoke-sqlite.mjs` passes on Node (node:sqlite) and on Bun (bun:sqlite); better-sqlite3 does treat `?1` as a named parameter ("Too many parameter values were provided"), as the ADR says.
  - Alternatives are real (KV backend kept, sync interface, ORM, per-engine SQL) and their rejections hold. Consequences are honest about what is not checked: minimum engine versions (SQLite 3.35, rqlite 8.32) are documented but not tested against old engines.
  - Could not verify: Deno (not installed), Turso or a remote sqld, and a SQLite older than 3.35.
  - Status: proposed becomes accepted; the existing note that its default locking is superseded by ADR-0210 stays (it is accurate). The default-locking caveat in my notes on ADR-0210 applies to the libSQL row.

## Update (2026-10-03)

The "Default locking" column of the adapter table is superseded by
[ADR-0210](0210-sqlite-locking-fails-closed.md): locking now fails closed. `fromSqliteSync` defaults to
local only for an in-memory or temporary database (by `PRAGMA database_list`) and to lease for a file;
`fromLibsql` asks the database the same way for a `file:` client, so an embedded replica gets lease;
`fromSqliteWasm`, `fromD1`, `fromRqlite` and `fromDurableObjectStorage` are unchanged; and an adapter that
leaves `defaultLocking` undefined now means lease. `defaultLocking` may be a function returning a promise,
for an adapter that has to ask the database. The review found the old default let two connections to one
file assign one index twice.

*Review of this update: approved, ADR reviewer (independent), 2026-10-04. Matches the code of ADR-0210: `fromSqliteSync` and `fromLibsql` ask `PRAGMA database_list`, `defaultLocking` may be a function, and an adapter that leaves it undefined means lease (`sqlite.ts` `defaultLockingOf`; tested in `sqlite_test.ts`, `sync_test.ts`, `libsql_test.ts`). See my change request on ADR-0210 for the libSQL `file:` case.*
