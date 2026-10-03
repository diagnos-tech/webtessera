# ADR-0112: Take IndexedDB locks through the Web Locks API, falling back to in-process locks

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** `storage/posix/files.go` (`lockFile`, `treeStateLock`, `publishLock`, `gcStateLock`)

## Context

The POSIX driver serialises integration, checkpoint publication and garbage collection with `fcntl` locks on
files under `.state/`:

```go
// lockFile creates/opens a lock file at the specified path, and flocks it.
// Once locked, the caller perform whatever operations are necessary, before
// calling the returned function to unlock it.
```

Those locks exclude every process that opens the same directory. The `ObjectStore` contract asks the same of a
shared backend: *"The lock must exclude every holder that can reach the same underlying data: other drivers in
the same JavaScript realm and, where the backend is shared more widely (an IndexedDB database open in several
tabs, say), those other contexts too."* Without that, two tabs integrating at once would both read tree size
*N*, both write different entries at index *N*, and leave a corrupt log.

IndexedDB itself has no lock that can be held across the asynchronous steps of an integration: a transaction
commits as soon as it has no pending requests, so it cannot be kept open while the driver hashes tiles. The Web
Locks API (`navigator.locks`) is the browser's cross-context mutex. It is scoped to the same storage partition
as IndexedDB (so exactly the contexts that can open the database contend), grants locks in request order,
releases a lock when its holder's promise settles or its context goes away, and accepts an `AbortSignal` for
abandoning a wait. It is available in every current browser engine, but only in secure contexts, and Node 22
does not have it.

## Decision

`IndexedDBObjectStore.lock(name, fn, signal)` calls `navigator.locks.request(lockName, { signal }, fn)` in
exclusive mode, where `lockName` is `webtessera/indexeddb/<encodeURIComponent(database)>/<name>`. Qualifying the
name by database keeps two logs on one origin from contending; percent-encoding the database name keeps distinct
(database, lock) pairs distinct; the fixed prefix keeps names clear of the `-` prefix that Web Locks reserves.

If the signal is already aborted, `lock` rejects with its reason without requesting the lock. If the wait is
abandoned, `lock` rejects with the signal's reason even when the browser rejects with a generic `AbortError`, as
browsers that predate the spec's switch to abort reasons do; an error thrown by `fn` itself is always reported
as is.

A `LockManager` can be injected through the `locks` option (for runtimes that provide one elsewhere, and for
tests). When `locks` is `null`, or no `navigator.locks` exists, the store falls back to an in-process lock with
the same semantics: FIFO, abortable while waiting, handed directly to the next waiter on release. The fallback
is shared by every store opened through the same `IDBFactory` in the realm, so two drivers in one tab still
exclude each other, while separate factories (one fake-indexeddb instance per test) never contend.

The fallback does **not** exclude other tabs or workers. The store reports which case applies as
`lockScope: "origin" | "realm"`, documented on `IndexedDBObjectStore` and `IndexedDBObjectStoreOptions.locks`, so
that an application served over plain HTTP (no secure context, so no Web Locks) can detect it and refuse to run
a writer in more than one context.

> **Update (2026-10-02):** the silent fallback is gone. When no `LockManager` is available, opening the store
> now fails unless the caller passes `singleWriter: true`, declaring that it is the only context writing the
> log; only then does the store use the realm-scoped fallback described above. "Refuse to open without Web
> Locks" — rejected below because it would leave no way to run in Node or in a single-context application — is
> therefore adopted with exactly that escape hatch. See ADR-0201.

## Consequences

- Two tabs, or a tab and a worker, can run appenders on the same log and the log stays consistent. The Chromium
  suite proves exclusion in both directions between the page and a dedicated module worker running this code.
- A tab that is closed, crashes or navigates while holding a lock releases it; there is no stale lock file to
  clean up, unlike a lock file abandoned on disk.
- Locks are advisory, as `fcntl` locks are: code that writes the database without going through the driver is
  not excluded.
- With a `"realm"` scope, safety across contexts is the application's responsibility. Silent fallback trades
  safety for availability; `lockScope` makes the trade observable rather than hidden.

## Alternatives considered

- **Refuse to open without Web Locks.** Rejected: it would make the store unusable on Node (tests,
  fake-indexeddb) and in a single-context application that does not need cross-context exclusion.
- **A lock record in IndexedDB with a lease.** Rejected: a lease cannot be renewed from inside a long
  asynchronous integration without the same auto-commit problem, an expired lease lets two writers in, and a
  crashed holder blocks everyone until it expires.
- **`BroadcastChannel` leader election.** Rejected: it reinvents Web Locks, with failure detection by timeout.
- **Taking an in-process lock as well as the Web Lock.** Rejected: Web Locks already exclude holders in the
  same realm.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
