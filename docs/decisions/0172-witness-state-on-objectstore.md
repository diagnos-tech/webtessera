# ADR-0172: Keep witness state as one object per log on the ObjectStore contract

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** http/witness/mirror contributor
- **Upstream reference:** n/a (cf. `transparency-dev/witness`'s `LogStatePersistence.Update`)

## Context

tlog-witness: "The witness MUST persist the new checkpoint before responding", and "checking the old
size against the latest checkpoint and persisting the new checkpoint must be performed atomically",
or two racing requests can roll a log back. The witness must run on every backend webtessera has
(memory, IndexedDB, SQLite, Durable Objects) without a backend of its own.

## Decision

- The witness needs `Pick<ObjectStore, "get" | "put" | "lock">` (`WitnessStore`). Per log it stores
  exactly one object, the latest cosigned checkpoint (checkpoint text, verified log signatures, the
  witness's signatures), under `<keyPrefix><sha256(origin) hex>/checkpoint`: the monitoring endpoint's
  path, so a store published as static files serves the monitoring API as it is. `keyPrefix` defaults
  to "".
- Size and root are re-derived from that object with `checkpointUnsafe` (the store is inside the
  witness's TCB; not re-verifying also survives log key rotation).
- Each add-checkpoint runs read → check → sign → `put` inside `store.lock("witness:<key>")`. Locks are
  per log, so logs proceed in parallel. With the contract's guarantees (atomic, durable `put`; `lock`
  excluding every holder that can reach the data), this is compare-and-swap: no request can act on a
  stale read. A test with a store that yields between every operation shows two racing requests from
  size 0 end with exactly one success, and that removing the lock makes both succeed (a rollback).

## Consequences

- No new ObjectStore operation; any conforming backend works, including user-supplied ones.
- One object per log scales to the open-ended populations `lookupLog` allows.
- Rejected requests are not stored (the spec's optional misbehaviour log is delegated to
  `onInconsistency`).

## Alternatives considered

- **A JSON state object beside the checkpoint.** Rejected: two keys cannot be updated atomically under
  the contract, and everything needed is in the checkpoint.
- **`create` as an optimistic CAS without a lock.** Rejected: the contract has no conditional
  replace, only create-if-absent, which covers the first checkpoint but not later ones.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Checked `state.ts` and `server.ts`: the witness needs `Pick<ObjectStore, "get" | "put" | "lock">`; one object per log at `<keyPrefix><sha256(origin) hex>/checkpoint`, which is the monitoring endpoint's path; size and root come from `checkpointUnsafe` of the stored object; each request reads, checks, signs and puts inside `store.lock("witness:<key>")`. Against tlog-witness: "persist the new checkpoint before responding" and the atomicity requirement with its six-step rollback race are both what the lock and the durable `put` provide.
  - Verified the race claim by running it. A scratch script builds the `server_test.ts` race (a store whose `get` and `put` yield to the event loop; two requests from old size 0, for sizes 15 and 5): with the real `lock`, one request succeeds and one is rejected, stored size 15; with `lock` replaced by `(n, fn) => fn()`, both succeed and the stored size is 5, a rollback. So the test in `server_test.ts` guards what the ADR says.
  - Consequences and alternatives hold: no new ObjectStore operation; a JSON state object beside the checkpoint cannot be updated atomically with it under the contract; `create` alone is not a compare-and-swap for later checkpoints. The soundness of this design depends on `lock` excluding every writer, which is exactly what the update below is about.
  - Status: proposed becomes accepted.

## Update (2026-10-03)

The rollback guarantee rests on `lock` excluding every writer of the store. On a SQLite file it did not by
default: stores defaulted to local locking, and the review's two witness servers on two connections to one
file both cosigned from old size 0 and left the log rolled back to the smaller size. SQLite stores now
default to lease locking for every database that is not provably private
([ADR-0210](0210-sqlite-locking-fails-closed.md)), and `sqlite_test.ts` races two witnesses on two
connections to one file: exactly one succeeds, and the stored size is the winner's.

*Review of this update: approved, ADR reviewer (independent), 2026-10-04. `sqlite_test.ts` `lets exactly one of two witnesses on separate connections to one file cosign from a size` runs four origins with two witness servers on two connections to one file under default options, asserts exactly one success and that the stored size is the winner's; it passes. Under the lease default the two connections have different `SqlDatabase` objects, so only the lease in the database excludes them, which is the point. Applies to libSQL files only to the extent of the SQLITE_BUSY limitation in my review of ADR-0210.*
