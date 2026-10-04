# ADR-0153: State what "durable" means on each SQLite engine, and make the in-process engines durable by default

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Each row of the durability table checked. Sync engines: `newSyncDatabase` sets `busy_timeout` to 5000 only if it is 0 and raises `synchronous` to FULL only if below it, and leaves the journal mode alone (`sync_test.ts`). With real better-sqlite3: a reopened WAL database starts at `synchronous = 1` (NORMAL), the adapter raises it to 2 and `journal_mode` stays `wal`; better-sqlite3's own `docs/compilation.md` lists `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so the ADR's claim about its build defaults is right. libSQL 0.18.0 `file:`: `synchronous` 2, `journal_mode` delete, `busy_timeout` 0, as stated. D1: Cloudflare's read-replication page confirms that queries without the Sessions API all go to the primary. rqlite caveat reproduced on a live 9.4.5 node: in a `transaction` request a statement that fails to compile (`no such table`) comes back as an error result and the statements around it are committed (rows 1 and 3 present), while a statement that fails while executing (NOT NULL) rolls the transaction back; the adapter throws on any error result.
  - One wording fix worth making if the ADR is ever touched, not blocking: the rqlite row says the adapter sets "nothing; reads are linearizable by default". rqlite's own default level is `weak` (rqlite docs); the adapter is what sends `level=linearizable` on every request. The update's table states it correctly ("the only levels `fromRqlite` accepts").
  - Not verified: the Durable Object output-gate guarantee (taken from ADR-0122 and Cloudflare's documentation), libSQL remote and Turso durability, sqlite-wasm on OPFS.
  - Alternatives hold (leave settings to the caller, WAL, `EXTRA`, `storage.sync()`). Status: proposed becomes accepted.

## Update (2026-10-03): the read-after-lease assumption, and the busy timeout

**Lease locking assumes that every read a store makes after taking a lease sees every write committed
before it took it.** Fencing (ADR-0152) makes a write fail if its lease is gone, but it says nothing about
the reads the write was computed from. The driver reads the tree state under the tree-state lock and
integrates on top of it; if that read returns a state older than the lock's previous holder left, the
driver assigns indices that are already taken, and the fence lets the write through because the lease is
genuinely its own. The assumption holds where every read goes to the one copy writes commit to:

| Engine | Reads after a lease see earlier writes? |
| --- | --- |
| node:sqlite, bun:sqlite, better-sqlite3, sqlite-wasm, libSQL `file:` | yes: one database file, under SQLite's own locking |
| Durable Object | yes: one instance, one database |
| D1 through the binding (`env.DB`) | yes: queries without the Sessions API go to the primary |
| rqlite | yes, at `linearizable` or `strong`, the only levels `fromRqlite` accepts (ADR-0213) |
| libSQL remote (sqld, Turso) | yes for a server with no read replicas; not established for one that serves reads from replicas |
| libSQL embedded replica (`file:` with `syncUrl`) | **no**: reads are served from the local copy, which lags writes made through other clients until it syncs |
| D1 through a Sessions API session (`env.DB.withSession()`) | not established: a session is sequentially consistent with its own writes, which may suffice since taking a lease is a write, but this has not been verified |
| any engine behind a read replica or a cache of query results | **no** |

So an embedded replica, or any setup that answers reads from a replica, is not a safe home for a log that
more than one client writes, under either locking mode; `fromLibsql`'s documentation says so. A single
client writing through an embedded replica is unaffected, since its own writes are visible to its reads.

**Busy timeout.** The adapter for in-process engines now sets the busy timeout before reading
`PRAGMA synchronous` (and `PRAGMA database_list`, ADR-0210), because those load the schema and, without a
timeout, fail at once with `SQLITE_BUSY` while another process writes the file. The new test that runs
several processes against one file found this.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. The read-after-lease table is candid about what is not established (remote libSQL with read replicas, D1 Sessions, replicas and caches) and matches `fromLibsql`'s and `fromRqlite`'s documentation; the busy-timeout reordering is in `syncengine.ts`, and `sqlite_test.ts`'s three-process test exercises it (it passes with the default; a scratch equivalent of `testing/append_process.ts` with `locking: "local"` forced gave 200 distinct indices out of 300). The same table's libSQL `file:` row (`busy_timeout` 0) is the root of the change request I make on ADR-0210.*

## Update (2026-10-04)

The rqlite row of the durability table says the adapter sets "nothing; reads are linearizable by default". rqlite's
own default read level is `weak`. `fromRqlite` is what sends `level=linearizable` (or `strong`, the only other level
it accepts) on every request, as this ADR's update table and ADR-0213 state.

**Review of this update:** ADR review agent (independent), 2026-10-04. Verdict: approved. The durability table's rqlite row (line 30) does say "nothing;
reads are linearizable by default and cannot be weakened", which is what the Update corrects. rqlite's documentation (the read-consistency page, fetched
today) says "Weak (the default)": weak is used "if you don't specify any level, or if an unrecognized level is specified". In
`src/storage/sqlite/adapters/rqlite.ts` every statement goes through one `send`, to `/db/request?level=<level>`, with `level` defaulting to
`"linearizable"` and the set of accepted levels being exactly `linearizable` and `strong` (anything else throws a `RangeError` saying a weaker level "can read stale tree state and assign an index
twice"), so the adapter sends the level on every request, as the Update says, and the update table's rqlite row (line 89) agrees. ADR-0213 is the
reference for that table, as cited. The sentence in the Decision's table is left as written, which is how an Update works; the Update
is the correction.
