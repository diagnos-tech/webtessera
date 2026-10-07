# ADR-0210: Default SQLite stores to lease locking unless the database is provably private

- **Status:** accepted
- **Date:** 2026-10-03
- **Author:** Gustavo Simões (security-review fixes)
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - What I verified holds. The default is lease unless the adapter shows privacy: `fromSqliteSync` asks `PRAGMA database_list` for `main`'s file name (empty means in-memory or temporary); I checked it against node:sqlite's `location()` (five kinds of database, in `sync_test.ts`), real better-sqlite3 (`memory`), and bun:sqlite on Bun 1.3.14 (`:memory:` and `""` give local, a path gives lease, as the ADR says); `fromLibsql` asks for `file:` clients (an in-memory client gives local, a file client lease, and `createClient({url: ":memory:", syncUrl})` is refused as the ADR says, so an embedded replica is always a file); D1, rqlite, wasm and Durable Object rows are unchanged; an adapter without `defaultLocking` gets leases; a function-valued default is called once at open; an explicit `locking` wins. Local locks are keyed by `instance_id` (mutating that back to the `SqlDatabase` object fails the shared-lock test). Reproduced the problem the ADR fixes: three processes appending 100 entries each to one node:sqlite file give 300 distinct indices under the default and 200 distinct (duplicates) with `locking: "local"` forced. The benchmark table reproduces on this machine (file, batch 256: 21,009 local vs 15,819 lease entries/s, ratio 0.75 against the ADR's 0.69; batch 16: ratio 0.52 against 0.52).
  - Change requested: the ADR's claim that the default "keeps every existing call site working and correct, and only slower" (Alternatives) and its silence in Consequences are wrong for libSQL `file:` clients used by more than one process. The client's connection has `busy_timeout = 0` (ADR-0153 says so; I confirmed it on @libsql/client 0.18.0), and lease acquisition does not retry `SQLITE_BUSY`, so with the new default contending processes fail instead of waiting. Reproduced: a scratch copy of `testing/append_process.ts` using `fromLibsql(createClient({url: "file:..."}))` with default options, three processes appending 100 entries each to one file, failed in 3 of 3 runs with `SQLITE_BUSY: database is locked` (for example `failed to init appender lifecycle: lockFile(treeState.lock): SQLITE_BUSY: database is locked`). It fails closed (no fork), so the integrity goal of the ADR is met, but it is not "only slower", and no test covers it: the three-process test in `sqlite_test.ts` is node:sqlite only. What must change, either of: (a) the ADR records, in its Decision table and Consequences, that for libSQL `file:` the lease default makes multi-process use fail with `SQLITE_BUSY` (and say what a user must do: another engine, a single process, or `locking: "local"` as a single-writer declaration), and the wrong sentence in Alternatives is corrected (`README.md` and `docs/guides/choosing-storage.md` need the same sentence); or (b) the code makes lease acquisition and renewal wait on `SQLITE_BUSY` (retry with the existing backoff) and a multi-process libSQL test is added, after which the ADR says so. Either way the multi-process claim in the Tests paragraph should name the engines it covers.
  - Minor, no change required: the PoC figures (160 of 400 duplicated) are the author's; my three-process reproduction is the same effect. Alternatives (keep local and document, refuse to open without a choice, key by canonical path, key the lease queue by identity, OS file locks) hold. Status stays proposed until the change above is made.

## Update (2026-10-04): libSQL `file:` clients shared by several processes

This answers the Review above. The decision stands.

- **The failure, reproduced.** Three processes appended 100 entries each to one libSQL file through
  `fromLibsql(createClient({ url: "file:…" }))` with default options. It failed in 3 of 3 runs with
  `SQLITE_BUSY: database is locked`, and no index was assigned twice. Two things cause it. libSQL's connections have
  `busy_timeout = 0`, so a write that meets another connection's lock fails at once. And lease acquisition treated
  that error as fatal.
- **The adapter cannot give libSQL's connections a busy timeout.** The Review asked for one, "if the client
  allows `PRAGMA busy_timeout`". It does not, in a way that reaches every connection. `@libsql/client` 0.18.0
  keeps a pool of connections, and a pragma reaches only the connection that runs it. In a probe, a busy timeout
  set through `execute` was 4321 on that connection and 0 on the three that concurrent calls opened. Only the
  client's own `timeout` option, given to `createClient`, reaches every connection (2500 on all four). Two
  stand-ins were tried and rejected, because each was worse than failing at once:
  - A pragma at the head of every write batch. It runs after `BEGIN IMMEDIATE`, so a connection that has not yet
    run one still takes the lock with no timeout. The mix of waiting and non-waiting connections stalled three
    processes for more than 100 s.
  - Re-running, in the adapter, a statement or batch that fails with `SQLITE_BUSY`. A connection with no busy
    timeout gives up its pending lock on every attempt, so in rollback-journal mode readers kept writers from
    committing. One run took 42 s and still failed.
- **What changed.**
  - `LeaseLocks` (`src/storage/sqlite/lease.ts`) treats a busy database like a held lock. An acquisition attempt
    that fails with `SQLITE_BUSY` or `SQLITE_LOCKED` is retried after the existing jittered backoff, and an aborted
    signal still stops it. A renewal that fails that way is retried after the same backoff, not a full interval
    later. Any other error is handled as before. This covers every engine, including a custom `SqlDatabase` with no
    busy timeout.
  - `isBusy` (`src/storage/sqlite/busy.ts`) recognises the two codes in each engine's form: libSQL, better-sqlite3
    and bun:sqlite's `code`; node:sqlite's `errcode`; libSQL's `rawCode`; sqlite-wasm's `resultCode`; and SQLite's
    message.
  - When a local libSQL client with no busy timeout reports `SQLITE_BUSY`, `fromLibsql` now names the fix in the
    error: `… (this libSQL client has no busy timeout, … create it with one, as createClient({ url, timeout: 5000 }))`.
    The original error is its cause. `fromLibsql`'s documentation says the same.
- **Measured.** Three processes, 100 entries each, ran with clients created with `timeout: 5000`. They passed 3 of
  3 runs, with 300 distinct indices, in 1.0–1.2 s; the node:sqlite test takes 1.1 s. With the timeout but without
  the lease change they also passed. Without the timeout, they fail closed with the error above.
- **Corrections.**
  - In Alternatives, "keeps every existing call site working and correct, and only slower" holds for node:sqlite,
    bun:sqlite and better-sqlite3, whose adapter sets a busy timeout. It also holds for the networked engines,
    which arbitrate writes themselves. On libSQL, a `file:` database that several processes or clients open
    also needs a client created with a busy timeout. Without one, contending writers fail with `SQLITE_BUSY`, and
    the log is not forked.
  - The Decision table's `fromLibsql` row and Consequences carry that condition from here on. The behaviour is
    engine-specific, so `docs/guides/choosing-storage.md` now says so, and `README.md` needs the same sentence.
- **Tests, with their engines.** The three-process append test is now shared (`testing/processes.ts`, with
  `append_process.ts` taking an engine argument). It covers node:sqlite (`sqlite_test.ts`) and libSQL with a busy
  timeout (`libsql_test.ts`). The two-witness race and the two-connection driver conformance run on node:sqlite.
  libSQL's conformance runs a second store on a second client in one process. D1, rqlite, Durable Objects and
  sqlite-wasm have no multi-process test. Their lease tests stand two `SqlDatabase`s over one database in for two
  processes. New tests:
  - `lease_test.ts`: busy acquisition retried, abort while busy, a non-busy error still fatal, busy renewal
    retried early.
  - `busy_test.ts`: real node:sqlite and libSQL busy errors, the other engines' forms, and look-alikes it must
    reject.
  - `libsql_test.ts`: the actionable error.
- `pnpm interop` in Consequences is `bun run interop` since ADR-0240.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. See the Re-review below.*

## Re-review (2026-10-04)

- **Re-review:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - The earlier Review asked for either (a) a record that libSQL `file:` clients shared by processes now fail with `SQLITE_BUSY`, or (b) a code fix that makes lease acquisition and renewal wait, plus a multi-process libSQL test, with the engines named. The Update does (b) as far as the engine allows and records the rest.
  - Reproduced with a scratch append process (3 processes, 100 entries each, one libSQL file, default options). Without a client `timeout`, it fails closed: `SQLITE_BUSY` carrying the new hint ("this libSQL client has no busy timeout ... create it with one, as createClient({ url, timeout: 5000 })") with the original error as `cause`, and no index is ever assigned twice. One run took 61 s before it ended with two failed processes (presumably a lease whose holder had failed, which has to expire; integrity was not affected, and the ADR does not mention the stall). With `createClient({ url, timeout: 5000 })`: 3 of 3 runs, 300 distinct indices, 1.0 to 1.1 s, as the Update says (1.0 to 1.2 s).
  - Why the adapter cannot set the timeout: I reproduced the pool probe on `@libsql/client` 0.18.0. After `PRAGMA busy_timeout = 4321` through `execute`, four concurrent `PRAGMA busy_timeout` calls read `[4321, 0, 0, 0]`; with `createClient({ timeout: 2500 })` all four read 2500. The two rejected stand-ins (a pragma at the head of each write batch; retrying a failed statement in the adapter) rest on timings I did not reproduce (a stall over 100 s; 42 s and then failure). The reasoning behind each is sound (the pragma runs after `BEGIN IMMEDIATE`; a connection with no timeout gives up its pending lock on every attempt), and the decision does not depend on the numbers.
  - Code: `LeaseLocks.#acquire` treats a busy batch as a held lock (jittered backoff, abort honoured through `throwIfAborted` and `sleep(..., signal)`); `#renewWhileHeld` retries a busy renewal after the same backoff, not a full interval later; other errors are handled as before; `isBusy` reads `code`, `errcode`, `rawCode`, `resultCode` and the message, and follows the cause chain. `fromLibsql` wraps a busy error from a `file:` client whose `PRAGMA busy_timeout` is 0 (read once; remote clients and clients with a timeout pass errors through). Tests: `lease_test.ts` (busy acquisition retried, abort while busy, non-busy error fatal, busy renewal retried early), `busy_test.ts`, `libsql_test.ts` (three-process append with a busy timeout; the actionable error); `busy_test`, `lease_test` and `libsql_test` run 188 tests, and the node:sqlite three-process test in `sqlite_test.ts` passes.
  - The corrections hold. The Alternatives sentence is restated with its scope: node:sqlite, bun:sqlite and better-sqlite3 get a busy timeout from the adapter (`DefaultBusyTimeoutMs = 5000`, `syncengine.ts`), the networked engines arbitrate writes themselves, and a libSQL `file:` database shared by processes needs a client with a timeout. The multi-process claim names its engines (node:sqlite; libSQL with a timeout; D1, rqlite, Durable Objects and sqlite-wasm have none). `README.md` and `docs/guides/choosing-storage.md` both carry the libSQL sentence; the Update's "README.md needs the same sentence" is stale wording, since the README already has it.
  - Non-blocking: the Decision table's `fromLibsql` row is not edited (history), so a reader needs the Update to learn the condition.

## Update (2026-10-07): a tripwire for a wrong single-writer declaration, and the name `"single-writer"`

A fresh-eyes audit of the 0.1.0 tarball ran two Node processes appending 40 entries each to one SQLite file,
both opened with `locking: "local"`. The log forked in 3 of 4 runs; in one, the winner had handed out 40 valid
receipts before the other overwrote storage, two different size-40 trees signed by one key. That is the documented
consequence of a wrong declaration, but it is reached by one word, and nothing noticed until a reader did.

- **The tripwire** (`src/storage/sqlite/claim.ts`). A store whose *caller* chose local locking keeps a claim on
  its database, in the namespace's `meta` table (a named integer, which the frozen definition of that table
  allows; no schema change, no log byte):
  - the claim is this realm's token, 48 random bits drawn once per realm, written with `INSERT OR REPLACE` the
    first time the store takes a lock, which only a writer does (a store that only reads never claims); every
    store of a realm claims with the same token, so they never trip over each other, as they share its local
    locks;
  - every critical section then starts by reading the token back, and every write batch is fenced on it in the
    same transaction, with the NOT NULL fence of lease mode (ADR-0211) and `WHERE NOT EXISTS (… value = token)`;
  - once the token is another realm's, the store refuses every lock and write, for good, with an error caused by
    the new sentinel `ErrWriterConflict` (exported from `webtessera/storage/sqlite`), whose text leads the message
    so that it survives the driver's `%v`-style flattening. `openServerLog` turns it into a `WebtesseraError` with
    the code `WRITER_CONFLICT` naming the method that met it (ADR-0226's update).
  The latest realm to start writing wins and every earlier one stops at its next lock or write, so their writes
  never interleave and the log they leave is the one the latest writer continues, as if the earlier had crashed
  there, which the driver already survives (it reads the tree state afresh under every lock). A restarted process
  takes over from its dead predecessor with no operator, which a "first claim wins" rule could not allow, since a
  dead holder's token cannot be told from a live one's. The check at the start of a critical section stops a stale
  writer before it reads the tree state and signs a checkpoint over it, except when the other realm claims during
  that critical section; the fence stops its writes even then. A witness may still have cosigned a checkpoint the
  stale writer signed in that window and could not publish, as with a lapsed lease.
- **Cost.** Lease mode: none (no claim, no statement). A database the adapter showed to be private (in memory, a
  Durable Object): none, because its local locking is the adapter's choice, not a declaration, and the tripwire
  could never fire. An explicit single-writer store: one indexed `SELECT` per critical section and one extra
  statement in each write batch, inside SQLite.
- **The name.** `locking: "single-writer"` is accepted by `openSqliteObjectStore` and `openServerLog`, and is what
  the documentation and errors now use; `"local"` stays as its alias, with the same tripwire. The store's
  `locking` property still reports `"local"`: it describes the locks' scope, and existing callers compare it.
  `SqliteLockingOption` (`SqliteLocking | "single-writer"`) is the options' type; `SqliteLocking` is unchanged.

Tests: `sqlite_test.ts` ("the single-writer tripwire": the alias; one claim at the first lock and fences after it;
a takeover fails a write already under way in its own transaction, then every lock and write for good, while a new
store takes over; a stale writer's critical section never runs; stores of one realm never conflict; no claim
statement under lease locking or the adapter's local locking) and a conformance variant ("node:sqlite file,
single-writer locking, second store on a second connection", the object-store and driver suites);
`server_test.ts` ("keeps two processes that both declare themselves the only writer from forking the log": two
child processes, `"single-writer"` and `"local"`, 30 entries each at the same instant; the first claimant is
stopped with `WRITER_CONFLICT`, and every receipt the other handed out verifies, matches the entry the file holds
at its index, and the file passes `log.fsck()`). The audit's `writer.ts`, re-run on the packed tarball with
`locking: "local"`, no longer forks (see the report of 2026-10-07).

*Review of this update: pending.*
