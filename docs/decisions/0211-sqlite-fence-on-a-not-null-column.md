# ADR-0211: Fence lease-mode writes on a NOT NULL column, at schema version 2

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** Gustavo Simões (security-review fixes)
- **Upstream reference:** n/a (no upstream counterpart: upstream's POSIX driver holds `flock`s, which need
  no fencing); amends ADR-0151 (tables and versioning) and ADR-0152 (fencing)

## Context

ADR-0152 fences every write a lease-mode store makes while it holds leases: the batch starts with
`INSERT INTO fence (lost) SELECT 1 WHERE <a lease is no longer ours>`, and
`CONSTRAINT webtessera_lease_lost CHECK (lost IS NULL)` makes the insert, and with it the batch, fail.

`PRAGMA ignore_check_constraints = ON` turns CHECK constraints off for a connection. The review's proof
of concept sets it, has another holder take the lock over, and the stalled store's write is accepted,
leaving a row in the fence table: a holder whose lease lapsed overwrites what the lock's next holder
wrote, which is the forked tree fencing exists to prevent. The pragma is per connection, so whoever
shares the connection with the store (an application's own code, an ORM's settings) can set it, at
open or at any time after.

## Decision

The fence moves to a constraint nothing turns off: NOT NULL. Schema version 2 is the first migration:

```sql
ALTER TABLE <fence> ADD COLUMN webtessera_lease_lost INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO <meta> (name, value) VALUES ('instance_id', <48 random bits>);
```

and the fence statement becomes

```sql
INSERT INTO <fence> (webtessera_lease_lost) SELECT NULL WHERE (SELECT count(*) FROM <locks> WHERE holder IN (…)) < ?
```

SQLite names the column in the error (`NOT NULL constraint failed: webtessera_fence.webtessera_lease_lost`),
so `isLeaseLost` still recognises a fenced-out batch by `webtessera_lease_lost`, now the name of both the
column and the old CHECK constraint, on every engine (checked on node:sqlite, libSQL, live rqlite 9.4.5,
and D1 and Durable Objects in workerd).

- A store of schema version 1 still running against migrated tables keeps inserting `lost = 1`; the new
  column takes its default, and the CHECK constraint, still there, fences it as before. Version 2 never
  writes `lost`, so the CHECK never stands in its way.
- The migration is a single batch with the version bump, as ADR-0151 requires. Two openers racing make
  the second `ALTER TABLE` fail on the duplicate column; the batch rolls back, and `ensureSchema` re-reads
  the version and carries on, as its comment describes. On rqlite, which commits the rest of a
  transaction past a statement that fails to compile (ADR-0153), the rest is the `INSERT OR IGNORE` and a
  version bump conditioned on the old version, both no-ops by then.
- The same migration records the database's identity, which local locking keys on (ADR-0210).
- A fresh database is created at version 1 and migrated at once, so every database follows one path.

## Consequences

- `SchemaVersion` is 2. Tables written by this release are refused by earlier releases, with ADR-0151's
  message naming both versions.
- The fence holds whatever pragmas the connection sets; no check at open is needed for it.
- The fence table keeps its version 1 column and constraint until a later migration drops them, which
  can happen once no version 1 store can be running.

## Alternatives considered

- **Check `PRAGMA ignore_check_constraints` at open and refuse to open if it is on.** The pragma can be
  set after open, on the same connection, and D1 and Durable Objects restrict which pragmas run at all.
  A check at open narrows the hole; a NOT NULL constraint closes it.
- **A trigger that raises (`RAISE(ABORT, 'webtessera_lease_lost')`).** Triggers can be disabled per
  connection through `sqlite3_db_config(SQLITE_DBCONFIG_ENABLE_TRIGGER)`, and a trigger is one more
  schema object for rqlite's parser to rewrite.
- **Inserting a non-integer into the fence's rowid (a datatype mismatch).** Not disabled by anything,
  but the error names nothing the store could recognise reliably.
- **A new fence table instead of a column.** Idempotent with `CREATE TABLE IF NOT EXISTS`, but a fifth
  table to explain, and version 1 stores would keep fencing on the old one anyway.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
