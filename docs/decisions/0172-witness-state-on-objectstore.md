# ADR-0172: Keep witness state as one object per log on the ObjectStore contract

- **Status:** proposed
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

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
