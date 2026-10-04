# ADR-0142: Share one in-process named-lock implementation across the storage backends

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** lead maintainer
- **Upstream reference:** `storage/posix/files.go` (`lockFile`), n/a otherwise

## Context

Every ObjectStore backend needs the in-process half of `ObjectStore.lock`: exclusive locks by name,
granted in arrival order, whose waiters can give up when their signal aborts without wedging the
lock. The memory backend (ADR-0103), the IndexedDB fallback locker (ADR-0112) and the Durable Object
backend (ADR-0121) were written in parallel and each grew its own. The IndexedDB and Durable Object
versions were line-for-line identical; the memory version queued abandoned waiters on a `Mutex` and
released them when their turn came. A store supplied by a user needs the same thing and is the
place where getting the abort semantics wrong is most likely.

## Decision

`src/storage/objectstore/namedlocks.ts` defines `NamedLocks`, the queue-based implementation, and
the three backends delegate to it. It is exported from `webtessera/storage/objectstore` so that a
custom `ObjectStore` can implement `lock` in one line, and the README points to it.

## Consequences

- One implementation to review and test (`namedlocks_test.ts`, plus the ObjectStore conformance
  suite through every backend). Abandoned waiters now leave the queue in the memory backend too,
  instead of being granted and immediately released.
- `NamedLocks` becomes public API. It only ever excludes callers sharing an instance, and its doc
  comment says so: backends reachable from several realms still need a cross-context lock on top.

## Alternatives considered

- **Keep three copies.** Rejected: identical code in three places drifts, and users writing a store
  would have written a fourth.
- **Keep it internal.** Rejected: implementing `lock` correctly is the hardest part of the contract
  for a custom store, and the helper costs nothing to expose.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - `NamedLocks` read against the ADR and against the ObjectStore contract's `lock` sentences: exclusive per name, FIFO,
    release hands the lock straight to the first waiter, an already-aborted signal rejects before queuing, a waiter that
    aborts leaves the queue and the lock is handed past it, and a name nobody holds keeps no map entry. `fn` is released
    in `finally`, including a synchronous throw. The four cases in `namedlocks_test.ts` pass, and a scratch mutation that
    leaks the map entry on release makes "keeps no state for names nobody holds" fail (a leaked entry is a stuck lock), so
    that case is not vacuous. It is exported from `webtessera/storage/objectstore` and the README points to it.
  - The three delegating backends: `MemoryObjectStore` and the IndexedDB fallback locker do use it; the Durable Object
    backend named in the ADR is gone, and the SQLite store's local mode uses it instead (ADR-0152). The conformance suites
    run it through every backend (memory, IndexedDB in Node and Chromium).
  - Challenge: both alternatives are reasoned. Not blocking: this ADR replaces ADR-0104's description of the memory store's
    per-name `Mutex` (and ADR-0103's Consequences) without saying so; a sentence here or Updates there would keep the
    three consistent. `NamedLocks` is now public API with a one-process scope, which its doc comment states.

## Update (2026-10-04)

Of the three lockers the Context names, the Durable Object backend's (ADR-0121) went with that backend (ADR-0150).
The SQLite backend's local locks are `NamedLocks`, from a realm-wide registry keyed by the database's identity
(ADR-0210). The memory store and the IndexedDB fallback delegate to `NamedLocks` as this ADR decided. ADR-0103 and
ADR-0104, which still described the memory store's per-name `Mutex`, now carry updates that point here.

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. `MemoryObjectStore` and the IndexedDB fallback
(`localLocker`, `src/storage/indexeddb/locks.ts`) both run `NamedLocks`; `src/storage/durableobject/` is gone, and ADR-0121 reads `superseded by
ADR-0152`. In `src/storage/sqlite/sqlite.ts`, a local-mode store takes `localLocksFor(`${databaseInstance}/${objects table}`)`: a realm-wide
`Map` of `WeakRef<NamedLocks>` keyed by the identity recorded in the database's meta table (`databaseInstance`, `schema.ts`) and the table name, swept as it
grows, which is what the Update and ADR-0210 describe. A lease-mode store's in-process queue is also a `NamedLocks`, but is keyed by the `SqlDatabase`
object (`queueFor`), deliberately, as the code comment says; the Update speaks only of the local locks, so it is not wrong. ADR-0103 and ADR-0104 now carry Updates
that point to ADR-0142, as the Update says. ADR-0210 was still `proposed` when I read it, so the registry's authority is the code, which I read.
