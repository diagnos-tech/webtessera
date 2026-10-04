# ADR-0103: Replace the POSIX driver's double locking with ObjectStore.lock alone

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go` (`Storage.mu`, `lockFile`, `sequenceBatch`, `initialise`,
  `publishCheckpoint`, `garbageCollect`, `MigrationStorage.buildTree`)

## Context

`files.go` takes two locks around every change to the tree:

```go
// Double locking:
// - The mutex `Lock()` ensures that multiple concurrent calls to this function within a task are serialised.
// - The POSIX `lockFile()` ensures that distinct tasks are serialised.
a.s.mu.Lock()
unlock, err := a.s.lockFile(ctx, treeStateLock)
if err != nil {
	panic(err)
}
```

Both are needed on POSIX because `fcntl` record locks belong to a *process*: a process never conflicts with its
own locks, so two goroutines of one process would both "hold" `treeState.lock`. The mutex closes that gap.
`lockFile` takes no part in cancellation (`F_SETLKW` blocks until granted, retrying on `EINTR`), and a failure
to lock is a `panic` in `sequenceBatch`, `initialise` and `buildTree`, and a wrapped `lockFile(%s): %v` error in
`publishCheckpoint` and `garbageCollect`.

Inside the critical section, `sequenceBatch` reads `.state/treeState` afresh for every batch. That is what makes
several processes sharing one log directory safe: each batch starts from whatever size the previous holder of
the lock left.

## Decision

- **One lock.** Every critical section is `ObjectStore.lock(name, fn, signal)`, which the contract requires to
  exclude *every* holder that can reach the same data, including other drivers in the same realm. That covers
  both halves of Go's double lock, so `Storage.mu` is dropped (Port note on `ObjectStoreDriver`).
- **Same names, same scopes.** The lock names are the paths POSIX flocks, `.state/treeState.lock`,
  `.state/publish.lock` and `.state/gcState.lock`, held around exactly the code that holds them in `files.go`.
  Lock order is unchanged: `initialise` publishes while holding the tree-state lock, and nothing takes the
  tree-state lock while holding the publish lock, so there is no cycle.
- **Tree state read under the lock.** As in `files.go`, `sequenceBatch` and `buildTree` read
  `.state/treeState` inside the critical section for every batch and never cache it across batches. Several
  drivers over one store (two tabs on one IndexedDB database, a Durable Object restarted while its previous
  instance is still draining) therefore never assign the same index twice.
- **Callback, not unlock function.** `lockFile(p, fn, signal)` runs `fn` under the lock instead of returning
  an unlock function, so a critical section cannot leak the lock on an early return or a throw.
- **Errors, not panics.** A failure to *acquire* a lock is wrapped once, inside `lockFile`, as
  `lockFile(<name>): <cause>` with the cause kept on the chain; errors thrown *inside* the critical section pass
  through unwrapped. Nothing panics: a failed batch fails its entries' futures, a failed publication is retried
  on the next tick.
- **Abortable waits.** The signal passed to `lock` lets a wait end when the appender's signal aborts. Go's
  `F_SETLKW` wait cannot be cancelled; this is a failure mode only the port has, and it is what lets a
  shut-down appender, or a Durable Object being evicted, stop without waiting for a lock.

## Consequences

- Backends must provide a lock that excludes holders in the same realm *and* in every other context that can
  reach the data. `MemoryObjectStore` uses a per-name `Mutex`; the IndexedDB backend uses Web Locks
  (ADR-0112); a Durable Object is single-threaded per instance but may need a lock across `await` points.
- Lock names are scoped to one store. A backend whose lock namespace is wider than the store (Web Locks are
  per origin) must qualify the names, or unrelated logs in the same origin serialise needlessly.
- The shared-store guarantee is tested end to end by `testing/driver_conformance.ts` ("never assigns an index
  twice when two drivers share a store"); with the tree-state lock removed, that case fails.

## Alternatives considered

- **Keep `Storage.mu` as well.** Harmless but redundant: the contract already excludes same-realm holders, so
  the mutex would only add a second lock and a second ordering rule to reason about.
- **Cache the tree size between batches,** as a single-writer driver could. Rejected: it is exactly the
  optimisation `files.go` declines, and it would break the shared-store case.
- **Ignore the signal while waiting for a lock,** as Go does. Rejected: in JavaScript nothing else can
  interrupt the wait, so an aborted appender could keep a Durable Object or a worker alive indefinitely.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Checked against `files.go`: `Storage.mu` and the "Double locking" comment are as quoted; the process-scoped fcntl
    explanation matches `lockFile`; Go panics on a lock failure in `sequenceBatch`, `initialise` (both `appender` and
    `MigrationStorage`) and `buildTree`, and wraps `lockFile(%s): %v` in `publishCheckpoint` and `garbageCollect`, as stated.
    `driver.ts` holds each lock around exactly the code Go holds it around, with the same names and
    `lockFile(<name>): <cause>` wrapping done once in `ObjectStoreDriver.lockFile` (errors thrown inside the critical
    section are passed through unwrapped; tested). Lock order checked: `initialise` publishes under the tree-state lock;
    nothing takes the tree-state lock under the publish lock.
  - The test claim, by mutation: with `lock` replaced by a no-op (a wrapper store), `describeDriverConformance`'s "never
    assigns an index twice when two drivers share a store" fails (`index 2 assigned twice`); with `lockFile` bypassing only
    `treeStateLock` in a scratch copy of `src/`, the same case, and only that one, fails. Tree state is read under the lock
    for every batch (`sequenceBatch`, `buildTree`) and never cached.
  - Not blocking: Consequences say `MemoryObjectStore` "uses a per-name `Mutex`" and that a Durable Object "may need a lock
    across `await` points". Memory now uses `NamedLocks` (ADR-0142) and the Durable Object backend is gone (ADR-0150,
    ADR-0152 local locking). A pointer to those in an Update would help.

## Update (2026-10-04)

Two things the Consequences describe have since changed:
- `MemoryObjectStore` no longer uses a per-name `Mutex`. It takes its locks from `NamedLocks` (ADR-0142), as the
  IndexedDB fallback locker does.
- The Durable Object backend was replaced by the SQLite backend, whose locks are `NamedLocks` or leases (ADR-0150,
  ADR-0152, ADR-0210).

The locking model this ADR decides is unchanged.
