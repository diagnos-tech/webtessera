# ADR-0152: Lock SQLite stores in memory or with fenced leases in the database, per store

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
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

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
