# ADR-0152: Lock SQLite stores in memory or with fenced leases in the database, per store

- **Status:** accepted; its default locking and its keying of local locks are superseded by ADR-0210
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go` (`lockFile`, `treeStateLock`, `publishLock`, `gcStateLock`,
  and the `mu sync.Mutex` + `lockFile` "double locking" around integration)

## Context

The POSIX driver serialises integration, publication and garbage collection with `flock`s that exclude every
process opening the log directory. The contract carries this over: *"The lock must exclude every holder that
can reach the same underlying data"*, and an aborted wait rejects with the signal's reason without calling `fn`.

Who can reach a SQLite database varies by engine. A Durable Object's database is reached only by its single
live instance; a `:memory:` database or one in a private WebAssembly VFS only by its connection; a SQLite file
by every process that opens it; D1, rqlite and a remote libSQL server by every Worker isolate, process or
machine that connects. An in-process lock is right for the first group and silently wrong for the others.

A lock that spans processes is a lease: a holder can stall (a paused process, a partitioned network) and must
not keep the log locked forever, so its claim expires. The classic hazard is a holder that stalls past expiry,
is replaced, and then resumes and writes, overwriting the new holder's tree state: duplicate indices or a
forked tree. The security review requires that the fencing condition be part of every write made while leases
are held, not just checked at acquisition; that the database's clock be preferred for expiry where the engine
evaluates it deterministically; and that a WebAssembly database shared across tabs fail closed rather than
silently use per-tab locks.

## Decision

Each store has `locking: "local" | "lease"`, defaulting to its database's `defaultLocking` (ADR-0150's table),
else `"local"`.

**Local.** `NamedLocks` (ADR-0142), shared by every store opened over the same `SqlDatabase` object and
namespace in the realm. The adapters whose default is local memoize their `SqlDatabase` per engine handle, so
two stores over one connection always share their locks.

**Lease.** `lease.ts`, behind the same in-process queue (so at most one caller per lock and realm polls):

- `locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL)`. Each acquisition draws a
  random 128-bit `holder` token. Taking a lock is one batch: delete the row if expired, `INSERT OR IGNORE` ours,
  read the row back; we hold it if it names our token. Two contenders can never both win.
- While `fn` runs, the lease is renewed every `renewIntervalMs` (default `ttlMs / 3`, `ttlMs` default 30 s) by a
  batch that updates `expires` where the row is still ours and reads it back; finding another token marks the
  lease lost. Afterwards the row is deleted where still ours. A holder that dies leaves it to expire.
- Waiting polls with full-jitter exponential backoff from 5 ms up to `maxPollIntervalMs` (default 250 ms), each
  poll an acquisition attempt, and stops at once, leaving no row and no timer, when the signal aborts. An
  attempt that wins while the signal aborts releases what it won.
- **Fencing.** Every write batch the store sends while it holds any lease begins with
  `INSERT INTO fence (lost) SELECT 1 WHERE (SELECT count(*) FROM locks WHERE holder IN (<tokens>)) < <n>`, and
  `fence` has `CONSTRAINT webtessera_lease_lost CHECK (lost IS NULL)`. If any lease the store holds is no longer
  its own, the insert violates the constraint and the engine rolls the whole batch back; inside the batch's
  transaction no contender can take a lease over, so the check holds for every statement after it. The store
  reports the failure as an error caused by `ErrLeaseLost`, and fails fast without a round trip once a renewal
  has found a lease lost. Every write is fenced on every lease the store holds, because JavaScript cannot tell
  which lock an asynchronous caller runs under; a lost lease means the store stalled, and refusing all of its
  writes is the conservative answer.
- A lease is not released while a batch fenced on it is still in flight: otherwise a write by one critical
  section could fail spuriously because another section released its own lock first. This race exists only on
  asynchronous engines; the live rqlite suite found it, and `lease_test.ts` now pins it deterministically.

**Clocks.** Fencing compares tokens, never times, so mutual exclusion of writes does not depend on any clock;
expiry only decides when a contender may take a lock over. A clock that is wrong therefore costs liveness at
worst: a contender running ahead of the holder by more than `ttlMs - renewIntervalMs` takes over a live lease,
and the holder's writes fail with `ErrLeaseLost` rather than corrupt the log.

- Where the adapter vouches for it (`leaseClock: "database"`), expiries are computed and compared inside the
  statements with `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`, so every contender measures on
  one clock: D1 (statements run on its single primary), libSQL (the server executes writes on its primary and
  replicates pages, not statements), Durable Objects, and the in-process engines (the machine's clock is the
  one every process sharing the file reads).
- rqlite uses the store's clock, bound as a parameter. rqlite replicates statements, not their effects, and
  makes a time function deterministic only by rewriting it into a constant at whichever node received the
  request, and only for statements its own SQL parser understands. A parameter depends on neither.
- A `clock` option on the store overrides both, for tests.

**WebAssembly fails closed.** `fromSqliteWasm` defaults to local locking only for a database it can show is
private to the context: in memory or a temporary file (`dbFilename() === ""`), or in the `memdb` or
`opfs-sahpool` VFS (the SAH pool holds its files exclusively). Any other VFS (`opfs`, `kvvfs`), or a DB that
cannot say, defaults to lease locking, which every tab and worker of the origin observes through the database
itself. Choosing `locking: "local"` explicitly remains possible and is the caller's assertion.

## Consequences

- A holder that dies keeps the others waiting up to `ttlMs`; a restarted process waits out its own previous
  lease. Lower `ttlMs` trades that wait against how long a holder may stall before its writes start failing.
- Every write of a lease-mode store carries one extra statement, which reads a table of a few rows.
- An `ErrLeaseLost` failure surfaces where the driver's write failed (an integration, a publication); the
  appender reports it like any storage error, and nothing the stalled holder wrote after losing its lease has
  reached the database.
- Lease polling writes to the database while waiting, at most every `maxPollIntervalMs` per waiting realm;
  on rqlite each poll is a Raft write, on D1 a write query that counts toward the invocation's query limit.
- The renewal timer runs only while a lock is held, so a shut-down appender leaves no timer behind, which the
  driver conformance suite checks.

## Alternatives considered

- **Leases checked only at acquisition.** The hazard above; rejected by the security review and by the tests.
- **Fencing each statement with `WHERE EXISTS (lease)` instead of a failing first statement.** A lost lease
  then turns writes into silent no-ops and needs a separate check to report it; one failing statement rolls the
  batch back on every engine and names the cause.
- **Fencing on expiry (`expires > now`) rather than tokens.** Makes correctness depend on clocks; tokens make it
  depend only on the database's own serialisation.
- **The database's clock everywhere.** Unsafe on rqlite for the reasons above, and on any statement-replicated
  engine without rewriting.
- **Web Locks for WebAssembly databases.** Excludes tabs, and releases with a closed tab, but is a third
  locking mode for one engine, unavailable outside secure contexts, and does not reach a database shared with a
  service worker of another origin partition. Leases work wherever the VFS's own transactions do.
- **A lock per store instance (tokens per store, not per acquisition).** A stale critical section of the same
  store could then pass the fence after the store re-acquired the lock; per-acquisition tokens rule that out.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `lease.ts`, `sqlite.ts` and the adapters bullet by bullet. Taking a lock is one batch (delete if expired, `INSERT OR IGNORE`, read back); renewal is one batch that updates where the token is ours and reads it back; release deletes where still ours; every write batch begins with the fence statement and a held lease is not released while a batch fenced on it is in flight; an attempt that wins while the signal aborts releases what it won; clocks are as the ADR describes (`databaseNow` for adapters that set `leaseClock: "database"`, the store clock for rqlite, a `clock` option overriding both).
  - Mutation checks in a scratch copy of `src/`: disabling the fence makes 7 tests fail (4 in `lease_test.ts`, the CHECK-ignoring test, and the fenced-write case of `describeSqliteBehaviour` on two suites); disabling the in-flight deferral makes exactly `defers releasing a lease until the writes fenced on it have settled` fail. So the ADR's statement that the fencing and in-flight tests were checked to fail without the mechanism is true. The rqlite history behind the in-flight race I could not reproduce, but `lease_test.ts` pins it deterministically.
  - Ran, not taken from the author: `vitest` over `src/storage/sqlite src/http src/witness src/mirror` (22 files, 989 tests pass), `src/storage/objectstore src/storage/indexeddb src/storage/memory` (9 files, 286 pass), the workerd config (8 files, 300 pass) and the Chromium config (8 files, 265 pass). Live rqlite 9.4.5 suite: 79 tests pass (`RQLITE_URL=http://127.0.0.1:4001`; the S3 services file fails by design without S3 variables).
  - Nit, no action required: the ADR (and the comment in `lease.ts`) call the polling backoff "full jitter"; the code sleeps `backoff * (0.5 + random / 2)`, which is half-to-full jitter. No behavioural consequence.
  - Limitation to carry in the record: lease acquisition and renewal do not retry `SQLITE_BUSY` (a failed acquisition batch throws out of `lock`). On engines whose adapter sets a busy timeout that is invisible; on libSQL `file:` clients, whose busy timeout is 0 (ADR-0153), contending processes fail instead of waiting. I reproduced it (see my change request on ADR-0210); it does not change my verdict on this ADR, whose decision (leases, fenced by tokens) is sound.
  - Alternatives are real and their rejections hold (leases checked only at acquisition, expiry-based fencing, database clock everywhere, Web Locks for wasm, per-store tokens). Status: proposed becomes accepted; the superseded note for default locking and local-lock keying (ADR-0210) stays.

## Update (2026-10-03)

- **Defaults** ([ADR-0210](0210-sqlite-locking-fails-closed.md)). "Defaulting to its database's
  `defaultLocking`, else `"local"`" becomes "else `"lease"`", and the in-process adapters no longer default
  to local for files: a store defaults to lease unless its adapter shows the database is private (in
  memory, temporary, a Durable Object's, a private WebAssembly VFS). An explicit `locking: "local"` is the
  caller's declaration that this realm is the only writer. The "WebAssembly fails closed" paragraph above
  now describes every adapter.
- **Local** locks are keyed by the database's identity, a random `instance_id` the tables record, instead
  of the `SqlDatabase` object, so every local-mode store of a realm over one database shares them, whatever
  connection it uses. The in-process queue in front of leases stays keyed by the `SqlDatabase` object.
- **Fencing** inserts a NULL into a NOT NULL column instead of violating a CHECK constraint, which
  `PRAGMA ignore_check_constraints` turns off ([ADR-0211](0211-sqlite-fence-on-a-not-null-column.md)); the
  constraint's name is the column's, so recognition is unchanged.
- **Timings** are whole milliseconds, validated as positive safe integers;
  `renewIntervalMs` defaults to `floor(ttlMs / 3)` ([ADR-0212](0212-http-request-targets-limits-and-error-bodies.md)).
- Lease mode's correctness also rests on reads made after a lease is taken seeing every write made before
  it, which some engines do not give; see ADR-0153's update.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. Verified: the default is lease unless the adapter shows privacy; local locks are keyed by `instance_id` (mutating `openSqliteObjectStore` to key them by `SqlDatabase` again fails `shares local locks between the stores of a realm over one database, and only those`); fencing inserts NULL into a NOT NULL column and recognises the failure by the column's name; timings are positive safe integers with `renewIntervalMs` defaulting to `floor(ttlMs / 3)` (and must be below `ttlMs`, which the update does not say); the read-after-lease assumption is stated in ADR-0153's update.*

## Update (2026-10-04)

The polling backoff is half-to-full jitter, not full jitter. Each wait is `backoff * (0.5 + random / 2)`. The comment
in `lease.ts` now says so. Since ADR-0210's 2026-10-04 update, the same backoff also covers an acquisition attempt
or a renewal that finds the database busy (`SQLITE_BUSY`/`SQLITE_LOCKED`).

**Review of this update:** ADR review agent (independent), 2026-10-04. Verdict: approved. `lease.ts` `#acquire` sleeps
`backoff * (0.5 + Math.random() / 2)` after a failed attempt, with the comment "Half-to-full jitter keeps contenders that collided from retrying in
lockstep" (no "full jitter" is left in `src/`; the ADR's Decision text, "full-jitter exponential backoff", is what this Update corrects), and doubles the
backoff from `minPollIntervalMs` (5 ms) up to `maxPollIntervalMs`. An acquisition batch that throws is swallowed when `isBusy(err)`
(`busy.ts`: SQLITE_BUSY or SQLITE_LOCKED by `code`, `errcode`, `rawCode`, `resultCode` or message, along the cause chain) and counts as finding the lock held, so it
is retried after the same backoff. `#renewWhileHeld` retries a busy renewal after `min(renewIntervalMs, backoff * (0.5 + random / 2))` with its own backoff
sequence from the same 5 ms start, capped by `maxPollIntervalMs`, which is the same schedule but not the same counter; any other failure waits for the next interval, as before.
I ran `lease_test.ts` and `busy_test.ts`: 21 passed.
