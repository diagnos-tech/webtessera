# ADR-0153: State what "durable" means on each SQLite engine, and make the in-process engines durable by default

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** `storage/posix/file_ops.go` (`overwrite`, `createEx`: fsync of the file and its
  directory); `append_lifecycle.go` (`AddFn`: *"Implementations MUST NOT allow the future to resolve to an index
  value unless/until it has been durably committed by the storage"*)

## Context

The contract says every method *"resolves only once durable for the backend in question"*. What a resolved
commit guarantees differs by engine, and in-process SQLite's guarantee depends on connection settings: with
`PRAGMA synchronous = NORMAL` in WAL mode, a commit can be lost on power failure until the next checkpoint,
and better-sqlite3 builds SQLite with WAL commits at NORMAL by default. A busy timeout of 0, SQLite's default,
makes a write from a second process fail at once with `SQLITE_BUSY` instead of waiting.

## Decision

Every write is one batch that resolves only when the engine reports the transaction committed. Per engine:

| Engine | A resolved write has… | What the adapter sets |
| --- | --- | --- |
| node:sqlite, bun:sqlite, better-sqlite3 | been fsynced to the journal or WAL (`synchronous = FULL`) | raises `synchronous` to FULL if lower; sets `busy_timeout` to 5 s if 0; leaves the journal mode alone |
| sqlite-wasm | reached the VFS: nothing for memory, the origin's storage for OPFS | the same pragmas |
| libSQL file | been fsynced: @libsql/client 0.18 opens files with `synchronous = FULL` and a rollback journal (verified) | nothing: the client pools connections, so a per-connection pragma would not reach them all; its busy timeout is 0, so processes contending for one file get `SQLITE_BUSY` rather than waiting |
| libSQL remote (sqld, Turso) | been committed by the server's primary | nothing (no pragmas over the wire) |
| D1 | been committed by D1, which persists before answering | nothing |
| Durable Object | been committed to the object's database; the output gate withholds every response, fetch and RPC result until it is durable, and resets the object if it fails | nothing |
| rqlite | been committed to the Raft log by a quorum and applied | nothing; reads are linearizable by default and cannot be weakened |

The pragmas are per connection and not persisted; changing the journal mode would affect every other user of
the file (and WAL does not work on network filesystems), so it is left to the caller.

On Durable Objects the decision of ADR-0122 stands: writes do not call `sync()` and do not opt out of the output
gate, and the appender's background work runs on timers bounded by `newAppender`'s signal.

**rqlite caveat.** rqlite 9.4.5, inside a `transaction` request, records a statement that fails to *compile*
(for example "no such table") as an error result and carries on with the next statement, committing the rest;
only statements that fail while executing roll the transaction back (verified against a live node). Every
statement the store sends compiles against the tables `openSqliteObjectStore` has just ensured, so this cannot
happen unless the namespace's tables are dropped or altered underneath a running store, which is unsupported;
the adapter still throws on any error result. This is worth reporting upstream to rqlite.

## Consequences

- `fromSqliteSync` changes two settings of a connection the caller owns. They are documented; a caller who
  deliberately accepts losing the latest commits on power failure can set `synchronous` back after creating
  the adapter.
- `synchronous = FULL` costs an fsync per commit; the driver batches entries, so commits are per batch, not per
  entry.
- An in-memory database (any engine) is not durable at all, by its nature; it is for tests and ephemeral logs.

## Alternatives considered

- **Leave every setting to the caller.** Correct only for callers who know better-sqlite3's build defaults;
  the contract's durability promise should hold by default.
- **Set `journal_mode = WAL`.** Faster with concurrent readers, but persistent, file-wide and unsupported on
  network filesystems; not ours to change.
- **`synchronous = EXTRA`.** Also fsyncs the directory after deleting a rollback journal; FULL is SQLite's own
  durable default for both modes, and EXTRA is kept if the caller set it.
- **Call `storage.sync()` after Durable Object writes.** ADR-0122 already rejected it: the output gate gives the
  same external guarantee without a round trip per write.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
