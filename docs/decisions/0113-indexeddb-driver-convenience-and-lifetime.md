# ADR-0113: `newIndexedDBDriver` returns the engine driver and ties the connection to a signal

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** `storage/posix/files.go` (`New`); `append_lifecycle.go` (`NewAppender`'s context)

## Context

Every upstream driver has a one-call constructor that a personality passes straight to `NewAppender`:

```go
driver, err := posix.New(ctx, posix.Config{Path: *storageDir})
appender, shutdown, reader, err := tessera.NewAppender(ctx, driver, opts)
```

The in-memory backend follows suit (`newMemoryDriver(cfg) → ObjectStoreDriver`). An IndexedDB log needs the same
one call, but with two differences: opening the database is asynchronous, and a database connection is a
resource. An open connection does not block other tabs (the store closes it on `versionchange`, ADR-0110), but
a test, or an application that tears a log down and deletes it, needs a way to close it, and a one-call
constructor hides the store that has the `close` method.

`NewAppender`'s context already defines a lifetime: the appender's background work (integration, checkpoint
publication, garbage collection) runs until the context is cancelled, and the documented way to stop cleanly is
to call `shutdown` and then cancel the context. The port maps that context to an `AbortSignal` (ADR-0004).

## Decision

`webtessera/storage/indexeddb` exports:

```ts
newIndexedDBDriver(cfg: IndexedDBDriverConfig, signal?: AbortSignal): Promise<ObjectStoreDriver>
```

`IndexedDBDriverConfig` is `IndexedDBObjectStoreOptions` plus the `fetch` option of `ObjectStoreDriverConfig`. It
opens the store with `openIndexedDBObjectStore(cfg, signal)` and returns `newObjectStoreDriver({ store, fetch })`,
the same type `newMemoryDriver` returns, so code that takes a driver does not care which backend it got.

`signal` bounds the connection the way `newAppender`'s signal bounds the appender: aborting it abandons opening
or, once the database is open, closes the connection. The intended usage passes one signal to both:

```ts
const ac = new AbortController();
const driver = await newIndexedDBDriver({ name: "my-log" }, ac.signal);
const { appender, shutdown } = await newAppender(driver, opts, ac.signal);
// ...
await shutdown();
ac.abort(); // stops background work and closes the database
```

Without a signal the connection lives as long as the realm, or until another context upgrades or deletes the
database. Callers that need the store itself (to close it independently, to serve the log's files from a service
worker, to inspect it) use the two-step form `openIndexedDBObjectStore` + `newObjectStoreDriver`, which the
function's documentation points to.

## Consequences

- One call, and one lifetime to manage, for the common case; the same shape as upstream's `posix.New(ctx, cfg)`
  followed by `NewAppender(ctx, ...)`.
- Aborting the signal before awaiting `shutdown` closes the database under the appender. The appender's
  remaining writes then fail with `ErrClosed` instead of completing, which is the same "entries may be lost"
  outcome upstream documents for cancelling the context without calling shutdown first.
- The signal has two roles: bounding the open and bounding the connection. They are the same role Go's context
  plays in a constructor that starts background work.

## Alternatives considered

- **Return `{ driver, store }`.** Explicit, but every caller destructures an object to get the thing the
  function is named after, and the result is no longer interchangeable with `newMemoryDriver`'s.
- **Attach `close()` and `store` to the returned driver** (by subclassing `ObjectStoreDriver` or assigning
  onto the instance). Rejected: it either couples this package to the engine's internal constructor or mutates
  an object another module created.
- **No convenience at all**: always `openIndexedDBObjectStore` then `newObjectStoreDriver`. Rejected: it makes
  the most common use of the package take two imports from two subpaths, unlike every other driver.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
