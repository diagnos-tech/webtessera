# ADR-0201: Refuse to open an IndexedDB log without Web Locks unless the caller declares a single writer

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** hardening agent
- **Upstream reference:** `storage/posix/files.go` (`lockFile`); amends ADR-0112 and ADR-0113

## Context

ADR-0112 takes IndexedDB locks through the Web Locks API and, when `navigator.locks` is missing (a page served
over plain HTTP, an older browser, Node) or `locks: null` is passed, silently falls back to locks that exclude
holders in the current realm only. The store reports this as `lockScope: "realm"`, and the documentation asks
the application to check it.

Nothing forces the check, and the one-call constructor `newIndexedDBDriver` did not expose the scope at all.
The failure mode of the fallback is not degraded performance but a corrupt log: two tabs of the same origin
appending to the same database each believe they hold the tree-state lock, both integrate at the same index,
and the log key signs checkpoints for two diverging trees. A log that has signed inconsistent checkpoints has
broken the property that defines it, and the damage cannot be undone by fixing the deployment afterwards.
The situation that triggers it — the same page opened in two tabs on an HTTP origin — is ordinary.

The `ObjectStore` contract (`objectstore.ts`) requires a lock that "excludes every holder that can reach the
same underlying data". A realm-scoped lock on a database shared by the whole origin does not meet it.

## Decision

`openIndexedDBObjectStore` and `newIndexedDBDriver` **reject**, before opening the database, when no
`LockManager` is available (the `locks` option is `null`, or it is omitted and `globalThis.navigator.locks` is
missing), unless the caller passes the new option **`singleWriter: true`**:

```ts
readonly singleWriter?: boolean; // IndexedDBObjectStoreOptions, and so IndexedDBDriverConfig
```

`singleWriter: true` is the caller's statement that this tab or worker is the only context that will write the
log while the store is open. With it, the store opens with the realm-scoped fallback of ADR-0112. It has no
effect when a `LockManager` is available: Web Locks are then always used. The error says what is missing and
names the three ways out (serve from a secure context, inject a `LockManager` through `locks`, or declare
`singleWriter: true`).

`newIndexedDBDriver` now returns `IndexedDBDriver`, an `ObjectStoreDriver` with one extra read-only property,
`lockScope: LockScope`, the effective scope of the store it runs on. It is implemented as a subclass of
`ObjectStoreDriver` built from the engine driver's configuration, so every engine method is inherited unchanged
and the returned value is still accepted wherever an `ObjectStoreDriver` is.

Node test suites, which have no Web Locks, either pass `singleWriter: true` (each test is the only writer of
its fresh fake-indexeddb factory) or inject a `LockManager`. `src/storage/indexeddb/testing/locks.ts` provides
`newInProcessLockManager()`, a test-only `LockManager` with Web Locks' exclusive-mode semantics within one
process, for code that should run unchanged against `navigator.locks` (the README's IndexedDB example).

## Consequences

- An application on an origin without Web Locks no longer runs a multi-tab writer silently; it fails at open
  with an actionable message. Applications that genuinely have one writer opt in with one option.
- This is a breaking change for callers that relied on the silent fallback (`locks: null` alone now throws).
  The package has not been released, so no published API changes.
- `IndexedDBDriver` is added API with no upstream counterpart (as the whole package is). It is a subtype of
  `ObjectStoreDriver`, so ADR-0113's goal — the result is interchangeable with `newMemoryDriver`'s — holds.
- ADR-0113 rejected subclassing `ObjectStoreDriver` to attach the store's `close`, as coupling this package to
  the engine's internal constructor. The coupling is accepted here for one read-only, safety-relevant value
  that callers of the one-call constructor otherwise cannot reach; both modules live in this repository's
  storage layer and are maintained together.

## Alternatives considered

- **Keep the silent fallback and document it harder.** Rejected: a corruption hazard whose only guard is a
  property the caller has to remember to read is not a guard.
- **Refuse to open without Web Locks, with no escape hatch.** Rejected (as ADR-0112 already argued): it would
  make the store unusable in Node tests and in single-context applications that need no cross-context
  exclusion.
- **A `lockScope: "realm"` option instead of `singleWriter`.** Equivalent in effect. Rejected because it names
  the mechanism rather than the guarantee the caller is making, and invites passing it "to make the error go
  away".
- **Return `{ driver, lockScope }` from `newIndexedDBDriver`.** Rejected for the reason ADR-0113 gives: the
  result would stop being interchangeable with the other backends' drivers.
- **Fall back to a lease record in IndexedDB.** Rejected for the reasons ADR-0112 gives.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - No Go original (amends ADR-0112/0113; ObjectStore contract in `objectstore.ts`). Checked `indexeddb.ts`: `openIndexedDBObjectStore` rejects before touching the database when `locks` is null or `navigator.locks` is missing unless `singleWriter: true`, with a message naming the three ways out; `singleWriter` has no effect when a LockManager exists; `newIndexedDBDriver` returns an `IndexedDBDriver` that subclasses `ObjectStoreDriver` (`super(base.cfg)`) and adds `lockScope`. `testing/locks.ts` provides `newInProcessLockManager()` (exclusive only, arrival order, abort reason). ADR-0112 and ADR-0113 carry the notes the ADR promises.
  - Node tests (`indexeddb_test.ts`) cover refusal, `singleWriter`, scope reporting and the in-process manager; they pass. Not verified: the real-Chromium behaviour (`indexeddb_browser_test.ts`, cross-tab Web Locks) because no Playwright browser is installed in this environment.
  - The wording describes the misconfiguration hazard, with no construction of one.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
