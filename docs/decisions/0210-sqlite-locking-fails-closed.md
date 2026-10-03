# ADR-0210: Default SQLite stores to lease locking unless the database is provably private

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** Claude (security-review fixes)
- **Upstream reference:** `storage/posix/files.go` (`lockFile`, and its `flock`s, which exclude every
  process that opens the log directory); supersedes the default-locking parts of ADR-0150 (the "Default
  locking" column of its adapter table) and ADR-0152 (its first paragraph of **Decision** and its
  **Local** paragraph); follows ADR-0201

## Context

ADR-0152 gave each SQLite store `locking: "local" | "lease"`, defaulting to the adapter's
`defaultLocking`, and to `"local"` when the adapter said nothing. `fromSqliteSync` (node:sqlite,
bun:sqlite, better-sqlite3) and `fromLibsql` for `file:` URLs defaulted to `"local"`, and local locks
were a `NamedLocks` keyed by the `SqlDatabase` object. The documentation asked callers to choose
`"lease"` themselves when several processes open the same file.

That default excludes nothing outside one connection object. The security review's proof of concept
opens one SQLite file twice with node:sqlite, as two processes would, with default options: of 400
entries appended through the two appenders, 160 indices were assigned twice (only 240 distinct), a
forked log under one signing key. Two witness servers on one file, the same way, both cosigned from
old size 0 (sizes 5 and 3), and the stored state ended at 3: a rollback, which tlog-witness exists to
prevent. A libSQL embedded replica (`file:` URL with a `syncUrl`) reports protocol `file` too, and got
the same default.

The `ObjectStore` contract requires a lock that "excludes every holder that can reach the same
underlying data". ADR-0201 already answered the same failure for IndexedDB: a corruption hazard whose
only guard is something the caller must remember is not a guard. Unlike IndexedDB without Web Locks,
SQLite has a mechanism that is correct everywhere (leases in the database itself), so failing closed
need not mean refusing to open.

## Decision

**Locking fails closed.** A store's default locking is `"lease"` unless its adapter can show that
nothing outside this JavaScript realm can reach the database; `SqlDatabase.defaultLocking` left
undefined now means `"lease"`, not `"local"`. It may also be a function returning a promise, for an
adapter that has to ask the database; the store calls it once at open.

| Adapter | Default locking |
| --- | --- |
| `fromSqliteSync` | `"local"` when `PRAGMA database_list` reports an empty file name for `main` (an in-memory or temporary database); `"lease"` for a file |
| `fromSqliteWasm` | unchanged: `"local"` for an empty file name or the `memdb` / `opfs-sahpool` VFS, else `"lease"` |
| `fromLibsql` | `"lease"` for a remote protocol; for protocol `file`, asks `PRAGMA database_list`: `"local"` for in memory, `"lease"` for a file, which includes every embedded replica (the client refuses an in-memory replica) |
| `fromD1`, `fromRqlite` | `"lease"` (unchanged) |
| `fromDurableObjectStorage` | `"local"` (unchanged): the runtime runs one instance of an object at a time |

`fromSqliteSync` asks SQLite rather than the binding. node:sqlite's `location()`, better-sqlite3's
`memory` and bun:sqlite's `filename` are all derived from the same `sqlite3_db_filename` that
`PRAGMA database_list` reports, so one query covers the three bindings and any other with the same
statement API. The agreement is tested for node:sqlite (`location()` against the adapter, for
`:memory:`, `""`, a path, a `file:` URI and `file::memory:`), checked by hand on Bun 1.3.14 (`filename`
`":memory:"` and `""` give local, a path gives lease), and exercised for better-sqlite3's statement
API through the existing stand-in, which gets its answer from SQLite alone.

**An explicit `locking: "local"` is the caller's single-writer declaration**, like IndexedDB's
`singleWriter: true`: the statement that this realm is the database's only writer. The option's
documentation, `SqliteLocking`'s, and the error for an invalid value all say so.

**Local locks are keyed by the database's identity, not the `SqlDatabase` object.** Schema version 2
(ADR-0211) records a random 48-bit `instance_id` in the namespace's `meta` table, drawn once with
`INSERT OR IGNORE`; a local-mode store reads it at open and takes its `NamedLocks` from a realm-wide
registry keyed by that identity and the table name. Every local-mode store of a realm over one database
therefore shares one set of locks, whichever connection, client or wrapper it was opened through:
several connections to one file, or to one shared-cache in-memory database (`file::memory:?cache=shared`,
which other connections in the process can open), exclude each other even under local locking. The
registry holds the locks through `WeakRef`s and sweeps dead entries as it grows, so it keeps nothing
alive that no store uses. This works on every engine, unlike keying by a canonical file path, which only
node:sqlite's `location()` reports reliably.

The in-process queue in front of lease-mode stores stays keyed by the `SqlDatabase` object: leases
alone must exclude stores that share no `SqlDatabase`, and the tests rely on that to stand two
`SqlDatabase`s over one database in for two processes.

**The busy timeout is set first.** `newSyncDatabase` used to read `PRAGMA synchronous`, which loads the
schema, before setting the busy timeout, so a second process opening a file while the first was writing
failed at once with `SQLITE_BUSY`. The new multi-process test found it; the busy timeout is now the
first setting read and written.

## Consequences

- Every store over a SQLite file, a libSQL file or an embedded replica now pays for leases unless its
  caller declares a single writer. Measured on node:sqlite 3.50.4 (Node 22.22, Linux, a file on local
  disk, `synchronous = FULL`), appending 20,000 entries of about 110 bytes through one appender,
  medians of five interleaved runs:

  | Batch size | Local | Lease | Lease / local |
  | --- | --- | --- | --- |
  | 256 (`withBatching(256, 10)`) | 22,278 entries/s | 15,345 entries/s | 0.69 |
  | 16 | 3,066 entries/s | 1,582 entries/s | 0.52 |
  | 256, in memory (for scale; defaults to local) | 48,282 entries/s | 42,341 entries/s | 0.88 |

  The cost is the lease's own commits: taking and releasing a lock is two more write transactions, each
  fsynced, per integration and per publication, plus one fence statement in every write. Larger batches
  amortise it. A caller that knows it has one writer gets the old speed back with `locking: "local"`.
- Lease mode keeps a renewal timer while a lock is held and can fail a write with `ErrLeaseLost` after
  a stall longer than `ttlMs`; both are now the default experience on files (ADR-0152).
- A custom `SqlDatabase` that does not set `defaultLocking` now gets leases. Its author can set
  `"local"` for a database that is private by construction.
- `SqlDatabase.defaultLocking` widens to `SqliteLocking | (() => Promise<SqliteLocking>)`, so code that
  read it as a string must call it when it is a function; the store's `locking` property reports the
  outcome.
- Two stores of one realm on two copies of one database file (the same `instance_id`) share local locks:
  over-exclusion, which costs time, never correctness.
- Lease locking does not make every engine safe: it rests on reads after taking a lease seeing every
  write made before it, which libSQL embedded replicas and read replicas do not give (ADR-0153's update).
- The README's SQLite table and its advice to "choose `locking: "lease"` explicitly" need rewording;
  `pnpm interop` now runs its file-backed SQLite backends with leases, and passes.

Tests: the driver conformance suite (with "never assigns an index twice when two drivers share a store")
over two node:sqlite connections to one file with default options; three child processes appending 100
entries each to one file with default options, then distinct indices, the checkpoint's size and `fsck`
(it fails with the default forced back to local, and found the busy-timeout bug); two witness servers
on two connections to one file racing from size 0, exactly one success and the stored size the winner's;
the default per adapter (in-memory, temporary and file connections, an adapter that does not say, a
libSQL in-memory client, file client, an embedded-replica stand-in and a remote client); local locks
shared across connections to one file and not across namespaces or databases.

## Alternatives considered

- **Keep `"local"` as the default and document it harder.** The review's finding: the failure is a
  forked log, and the situation (two processes on one file) is ordinary.
- **Refuse to open a file without an explicit `locking`, as ADR-0201 does for IndexedDB.** IndexedDB
  without Web Locks has no correct mechanism to fall back to; SQLite does, so defaulting to it keeps
  every existing call site working and correct, and only slower.
- **Key local locks by canonical file path.** Only node:sqlite reports one (`location()`); better-sqlite3
  and bun:sqlite report the name as passed, libSQL reports nothing, and a shared-cache in-memory database
  has no path at all. The identity recorded in the database works for all of them.
- **Key the lease queue by identity too.** It would serialise same-realm stores before they poll, but
  would also hide whether leases alone exclude separate processes, which the tests must be able to show.
- **Operating-system file locks.** Unreachable from library code without Node built-ins (AGENTS.md §7),
  and absent on D1, rqlite and the WebAssembly VFSes.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
