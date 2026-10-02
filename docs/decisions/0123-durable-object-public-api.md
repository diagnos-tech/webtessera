# ADR-0123: `webtessera/storage/durableobject` exports `newDurableObjectDriver` and the store

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** `storage/posix/files.go` (`New`, `Config`); no upstream counterpart for Durable
  Objects

## Context

Every upstream driver has a one-call constructor whose result a personality hands to `NewAppender`
(`posix.New(ctx, posix.Config{Path: ...})`). The port's other backends follow suit: `newMemoryDriver(cfg)`
and `newIndexedDBDriver(cfg, signal)` both return the engine's `ObjectStoreDriver`, and the stores they
wrap are exported for callers that need them (ADR-0104, ADR-0113). A Durable Object personality needs the
same, with the object's storage as the one required input.

## Decision

`src/storage/durableobject/index.ts`, published as `webtessera/storage/durableobject`, exports:

- `newDurableObjectDriver(cfg: DurableObjectDriverConfig): ObjectStoreDriver`. `DurableObjectDriverConfig`
  is `DurableObjectObjectStoreOptions` plus the engine's optional `fetch` (used for witness requests). It is
  exactly `newObjectStoreDriver({ store: new DurableObjectObjectStore(cfg), fetch })`, so the result is
  interchangeable with the other backends' drivers. It is synchronous: unlike IndexedDB there is nothing
  to open, so it takes no signal, and the appender's signal bounds all background work.
- `DurableObjectObjectStore`, with a public constructor taking `DurableObjectObjectStoreOptions`
  (`{ storage, maxValueBytes? }`), for callers that need the store itself: to wrap it, to read the log's
  resources without an appender, or to build a migration target.
- `DefaultMaxValueBytes`, the default for `maxValueBytes`, so callers who tune it can derive their value.
- The structural types `DurableObjectStorageLike`, `DurableObjectTransactionLike` and
  `DurableObjectListOptionsLike` (ADR-0120), so callers can type wrappers and test doubles.

The intended use, as in `examples/cloudflare-durable-object`:

```ts
this.#log = ctx.blockConcurrencyWhile(async () => {
  const driver = newDurableObjectDriver({ storage: ctx.storage });
  return newAppender(driver, newAppendOptions().withCheckpointSigner(signer));
});
```

## Consequences

- The package depends only on the engine and the gostd shims. It imports nothing from
  `@cloudflare/workers-types` or `cloudflare:*`, so it type-checks and bundles anywhere, and a Worker
  needs no `nodejs_compat` flag to use it. The example's `wrangler deploy --dry-run` bundle imports only
  `cloudflare:workers`, and only from the example's own code.
- The store class is part of the API, so its constructor's options object is too. New options must be
  optional.

## Alternatives considered

- **Taking `ctx` (the `DurableObjectState`) instead of `ctx.storage`.** It would allow `blockConcurrencyWhile`
  to be called on the caller's behalf, but it couples the store to more of the runtime than it uses, and
  hides a concurrency decision the object's author should make visibly in their constructor.
- **A `keyPrefix` option, to share an object's storage with other state.** That is the obvious next request,
  but a Durable Object is the unit of state isolation, so other state belongs in another object.
  Supporting it would add a mapping step to every key, and a second way to get `deletePrefix` wrong.
- **Exporting a factory (`newDurableObjectObjectStore`) and an interface instead of the class**, as IndexedDB
  does. IndexedDB hides its class because the only valid way to get one is to open a database. Here the
  constructor is the whole story, and hiding it would only add a name.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
