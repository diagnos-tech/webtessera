# ADR-0151: Store objects as TEXT-keyed rows chunked below the row limit, in versioned, namespaced tables

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/file_ops.go` (`overwrite`, `createEx`: atomic replace and
  `O_CREAT|O_EXCL`); `storage/posix/files.go` (`removeDirAll`); the ObjectStore contract
  (`src/storage/objectstore/objectstore.ts`)

## Context

The contract requires every method to be atomic per key, `create` to be `O_CREAT|O_EXCL`, `deletePrefix` to be
`os.RemoveAll`, `stat` to report size and modification time, and writes to resolve only once durable. Entry
bundles reach 16 MiB (256 entries of up to 65,535 bytes), while D1 and Durable Objects cap a row, a BLOB and a
string at 2,000,000 bytes. JavaScript strings are UTF-16 and may hold lone surrogates; SQLite's BINARY
collation compares TEXT by its UTF-8 bytes. Several logs may need to share one database (one D1 database per
account is common), and a later webtessera must be able to change the tables without stranding logs.

Engine probes that shaped the decision:

1. node:sqlite binds a zero-length `Uint8Array` whose buffer was never allocated (`new TextEncoder().encode("")`)
   as NULL.
2. rqlite binds any string parameter spelled like a hex literal (`X'00'`, after trimming) as a BLOB.
3. `CAST(? AS TEXT)` over a BLOB parameter reinterprets its bytes, NUL included, and `key = CAST(... AS TEXT)`
   still searches the primary key index (`EXPLAIN QUERY PLAN`: `SEARCH ... USING INDEX ... (key=?)`), as do the
   range comparisons.
4. rqlite rewrites statements that contain time or random functions, `RETURNING` or `EXPLAIN` with its own SQL
   parser before running them; it handled the store's `RETURNING` statement (verified on rqlite 9.4.5).

## Decision

**Tables.** Five per namespace, created by `schema.ts`, all named `webtessera_<table>` or, with
`namespace`, `webtessera_<namespace>_<table>`. A namespace is 1 to 64 of `[a-z0-9_]`: lowercase because SQLite
compares names case-insensitively; no table suffix contains `_`, so two namespaces can never yield one name.
Identifiers are validated, never quoted user input; every value is a bound parameter.

- `meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`: `schema_version`. Frozen forever, so any version can
  read any other's version.
- `objects (key TEXT PRIMARY KEY, size INTEGER NOT NULL, mod_time INTEGER NOT NULL, data BLOB NOT NULL)`: one
  row per object, holding its first `maxChunkBytes` bytes.
- `chunks (key TEXT, seq INTEGER, data BLOB, PRIMARY KEY (key, seq))`: the rest, numbered from 1.
- `locks` and `fence`: ADR-0152.

Rowid tables, not `WITHOUT ROWID`: SQLite advises against `WITHOUT ROWID` for rows of more than a fraction of a
page, and chunk rows are up to a megabyte. Sizes and times are INTEGER milliseconds, far below 2^53, read back
exactly whether an engine returns `number`, `bigint` or decimal text.

**Versioning.** Opening runs `CREATE TABLE IF NOT EXISTS meta`, reads the version, creates version 1 in one
batch if there is none (`IF NOT EXISTS`, `INSERT OR IGNORE`, so concurrent openers race safely), applies each
pending migration in one batch with a conditional version bump (re-reading the version if a concurrent opener
won), and fails with both versions named if the tables are newer than the code. There are no migrations yet;
the mechanism is tested with an injected one.

**Keys.** A key is bound as its UTF-8 bytes and cast in SQL: `CAST(COALESCE(?, X'') AS TEXT)` (`params.ts`).
Every engine then stores and compares exactly those bytes (probes 2 and 3), NUL included, and the tables stay
readable with any SQLite tool. `COALESCE(?, X'')` undoes probe 1; every BLOB the store binds goes through it.
A key with a lone surrogate is rejected: UTF-8 cannot represent it, and encoding it as U+FFFD would make two
keys collide.

**deletePrefix** is a key range, never `LIKE`. For a well-formed prefix p, the keys starting with p are
exactly those in `[utf8(p), successor)`, where the successor is `utf8(p)` with its last byte incremented (UTF-8
never contains 0xFF, so it never carries; the bound need not be valid UTF-8, which the BLOB-cast binding
allows). A prefix ending in a high surrogate selects the 1024 code points its pair can complete, which is again
one byte range; any other ill-formed prefix selects nothing; the empty prefix selects everything. `keys_test.ts`
checks the ranges against `String.prototype.startsWith` on 20,000 random strings over the encoding edges, and
every engine runs the same 13 boundary cases against its own SQL.

**Chunking.** An object of n bytes is one `objects` row with its first `maxChunkBytes` bytes and
`ceil(n / maxChunkBytes) - 1` chunk rows. `DefaultMaxChunkBytes` is 1 MiB, which leaves D1's and Durable
Objects' 2,000,000-byte rows room for the key and other columns; tiles and checkpoints always fit one row.

**Operations.**

- `get` is one compound query, `SELECT 0 AS seq, size, mod_time, data FROM objects WHERE key = ? UNION ALL
  SELECT seq, NULL, NULL, data FROM chunks WHERE key = ? ORDER BY seq`. One statement reads one snapshot, so a
  concurrent overwrite can never be mixed in; rows that do not add up to `size`, a missing chunk, or chunks
  without an object row are reported as corruption.
- `stat` reads `size, mod_time` from the object row.
- `put` is one batch: delete the key's chunks, `INSERT OR REPLACE` the object row, insert the new chunks. No
  stale chunk survives a shrink.
- `create` is one batch: the chunks, each `INSERT ... SELECT ... WHERE NOT EXISTS (object row)`, then
  `INSERT INTO objects ... VALUES (...) ON CONFLICT (key) DO NOTHING RETURNING 1 AS created`. The primary key
  decides, and the returned row is the result. Inside the batch's transaction nothing else writes, so the
  chunks are written exactly when the final insert succeeds.
- `deletePrefix` is one batch deleting the range from `chunks` and from `objects`.

Every input is copied (`slice`) before the first `await`, so the caller may reuse its array at once and no
engine is handed a view of a larger buffer.

## Consequences

- Stores never read keys back, so how an engine returns TEXT with NUL in it does not matter; the test helpers
  that list keys use `hex(key)`.
- A get of a 16 MiB bundle returns 16 MiB in one result. That is within every engine's limits today; an engine
  with a smaller response limit would need chunk-ranged reads with per-version chunk names (ADR-0120's
  generations), which a schema migration could add.
- The tables hold only the store's own data: `deletePrefix("")` empties them, and anything else written into
  them is reported as corrupt.
- `modTime` comes from the store's clock (`Date.now` by default), because the driver compares it with
  `Date.now` to decide when to republish a checkpoint.

## Alternatives considered

- **BLOB keys.** Exact by construction, but unreadable in every database tool, and no simpler: the
  lone-surrogate rule and the surrogate-prefix range are the same.
- **TEXT parameters.** Simpler SQL, but rqlite rebinds hex-literal-shaped strings and drivers disagree about
  NUL; casting a BLOB costs nothing measurable and removes both.
- **`LIKE prefix || '%'` with `ESCAPE`.** Case-insensitive for ASCII by default (`PRAGMA case_sensitive_like`
  is per connection and deprecated), and not index-friendly with `ESCAPE`; a byte range is exact.
- **Detecting `create`'s result with `changes()` or by matching `UNIQUE constraint failed`.** `changes()` relies
  on statement adjacency on one connection, error text matching on engine wrapping; `RETURNING` reports the
  result as data.
- **Per-version chunk names, as ADR-0120 did.** Needed only for reads split across statements; one compound
  query reads a consistent snapshot without them.
- **One table per log fixed by the caller (a raw prefix option).** Validating a short namespace and composing
  the names ourselves keeps every identifier inside a pattern we control.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
