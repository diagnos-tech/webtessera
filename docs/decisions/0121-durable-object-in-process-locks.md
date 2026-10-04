# ADR-0121: Implement ObjectStore.lock in memory for Durable Objects

- **Status:** superseded by ADR-0152
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go` (`lockFile`, and the `mu sync.Mutex` + `lockFile`
  "double locking" around integration)

## Context

The POSIX driver takes `flock`-based file locks (`lockFile`) on `treeState.lock`, `publish.lock` and
`gcState.lock`, so that *distinct tasks* sharing one log directory are serialized. The ObjectStore contract
carries that requirement over: *"The lock must exclude every holder that can reach the same underlying
data: other drivers in the same JavaScript realm and, where the backend is shared more widely, … those
other contexts too."* It also specifies that an abort while waiting rejects with the signal's reason and
never calls `fn`.

A Durable Object's storage can be reached only by code running inside that Durable Object. Cloudflare
runs at most one instance of a given Durable Object (one ID) at a time, worldwide. The storage enforces
this too: an instance that has lost its claim on the object, say during a network partition, cannot commit
writes. Its output gate breaks and the runtime resets it.

## Decision

`DurableObjectObjectStore.lock` is an in-memory, per-name lock:

- Waiters are queued in arrival order. Releasing hands the lock directly to the first waiter, so it is
  never observably free while someone waits.
- A signal that has already aborted rejects with its reason before queuing. A signal that aborts while
  waiting removes the waiter from the queue and rejects with the reason. `fn` never runs in either case,
  and the lock is handed past the abandoned waiter. Once `fn` is running, aborting has no effect on the
  lock: it is released when `fn` settles, whether it resolves or throws.
- The locks, and the write mutex of ADR-0120, live in a `WeakMap` keyed by the storage object. Every store
  built over the same `ctx.storage`, and so every driver, shares them. This is what the contract's "other
  drivers in the same realm" clause asks for: two appenders created in one object (by mistake, or one for
  migration and one for appending) still exclude each other. Several Durable Objects may share an isolate;
  each has its own storage object and so its own locks, and weak keys let the state go with the object.

## Consequences

**What is covered.** Everything that can reach a Durable Object's storage runs in its single live instance,
in one JavaScript realm, so an in-memory lock there excludes every possible holder. It does so without a
storage round trip, and no lock can be left held by a crashed holder: an instance that dies takes its locks
with it, and its successor starts with none.

**What is not covered:**

- **Two Durable Objects for one log.** Each Durable Object ID has its own storage, so two objects can never
  corrupt one another's log. A deployment that routes appends for one logical log to two objects (two
  names, two namespaces, or a `newUniqueId()` per request) creates two independent logs that fork from
  the first entry. This is a misconfiguration that no lock can detect. The example routes every request to
  `getByName("log")`.
- **Code outside the store.** The store assumes it owns the object's storage (ADR-0120). Writes made to the
  same `ctx.storage` behind its back are excluded neither by the locks nor by the write mutex.
- **Distinct wrappers.** Locks are shared by storage-object identity. Two stores given two different wrapper
  objects around the same `ctx.storage` do not exclude each other. The `storage` option's documentation says
  to pass `ctx.storage` itself, or one wrapper of it. The driver conformance suite's two-driver case caught
  this in our own test harness.

Input gates do not help here. They stop *new events* from being delivered while a storage operation is in
flight, but they do not serialize concurrent async work inside one event, such as the driver's
`Promise.all`, its background timers and the requests already being handled. The locks are still needed.

## Alternatives considered

- **Locks held in storage** (a lease record with an owner and an expiry). This is necessary only when
  several processes share the data. Here it would add a write and a read to every critical section and
  bring back the stale-lock recovery problem that `flock` solves, with no holder left to exclude.
- **Web Locks (`navigator.locks`).** Not available in Workers. Even if it were, its scope would be the
  isolate, which is wider than the Durable Object and not what the data's reach is.
- **One lock map per store instance.** Simpler, but two drivers over the same `ctx.storage` would not
  exclude each other, which violates the contract.
- **The gostd `Mutex` per name.** It cannot withdraw an abandoned waiter. The memory backend copes by
  letting the abandoned acquisition release immediately when its turn comes. A queue we control lets the
  waiter leave at once instead.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Reviewed only for the accuracy of the supersession note, as the ADR is superseded. The Status reads
    `superseded by ADR-0152`, in the template's form. ADR-0152's "Local" locking is the in-process, per-name, FIFO, abortable lock of this ADR, now `NamedLocks` (ADR-0142), shared per database object; the Durable Object adapter defaults to it (ADR-0150's table). Its lease mode is the cross-process case this ADR said was not needed for a Durable Object.
  - Confirmed in the tree: `src/storage/durableobject/` does not exist and `package.json` `exports` has no
    `./storage/durableobject` entry (only `./storage/sqlite`); `ADR-0150` to `ADR-0154` exist (`proposed`, reviewed
    separately); `ADR-0001`'s 2026-10-03 Update and its review say the same, and `docs/PORTING-MAP.md` agrees.
