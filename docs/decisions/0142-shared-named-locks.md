# ADR-0142: Share one in-process named-lock implementation across the storage backends

- **Status:** proposed
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

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
