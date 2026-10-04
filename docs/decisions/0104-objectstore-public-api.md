# ADR-0104: Name the ObjectStore and memory drivers' public API for a flat TypeScript namespace

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go` (`Storage`, `Config`, `New`, `NewTreeFunc`,
  `MigrationStorage`)

## Context

The POSIX driver's public surface is:

```go
type Storage struct { mu sync.Mutex; cfg Config }
type NewTreeFunc func(size uint64, root []byte) error
type Config struct {
	// HTTPClient will be used for outgoing HTTP requests. If unset, Tessera will use the net/http DefaultClient.
	HTTPClient *http.Client
	// Path is the path to a directory in which the log should be stored.
	Path string
}
func New(ctx context.Context, cfg Config) (tessera.Driver, error)
type MigrationStorage struct { ... }
```

Go callers always write these package-qualified (`posix.New`, `posix.Config`), and get a `tessera.Driver`,
which is `any`. A TypeScript consumer imports names into one flat scope, where `Storage` is already the Web
Storage API's global interface in every browser and `Config` names nothing in particular; and an `unknown`
return gives no completion at all. Nothing upstream corresponds to the in-memory backend.

## Decision

`src/storage/objectstore/index.ts` exports:

| Go (`posix`) | TypeScript (`objectstore`) |
| --- | --- |
| `Storage` | `class ObjectStoreDriver` |
| `Config{HTTPClient, Path}` | `interface ObjectStoreDriverConfig { fetch?: FetchFn; store: ObjectStore }` |
| `New(ctx, cfg) (tessera.Driver, error)` | `newObjectStoreDriver(cfg): ObjectStoreDriver` |
| `NewTreeFunc` | `type NewTreeFunc` (unused here, as upstream) |
| `MigrationStorage` | `class MigrationStorage` |
| — | `type ObjectStore`, `type ObjectInfo` (the backend contract) |

- `newObjectStoreDriver` is synchronous and cannot fail: `posix.New` ignores its context and always returns a
  nil error, so both are dropped, as `newHTTPFetcher` drops its never-returned error. It returns the concrete
  class so callers see `appender()` and `migrationWriter()`; the value still satisfies `newAppender`'s and
  `newMigrationTarget`'s `Driver` parameter.
- `fetch` stands in for `HTTPClient` (as `FetchFn` does throughout the port) and is used only for witnesses.
  When unset, the global `fetch` is looked up at call time. Either way the driver calls it through a wrapper
  that passes no receiver, because browsers and workerd reject the global `fetch` called as a method of
  another object ("Illegal invocation"), and the witness code calls it as one.
- Go-unexported members of `ObjectStoreDriver` and `MigrationStorage` that other classes in the module or the
  ported tests use are public with `@internal` (ADR-0010). `appender`, `logResourceStorage`, the state codec
  and `isLastLeafInParent` are exported from their modules only, not from the barrel.

`src/storage/memory/index.ts` exports:

- `class MemoryObjectStore implements ObjectStore`: a `Map` of copies, `modTime` from `Date.now()`, and one
  `Mutex` per lock name, created on first use and forgotten when nobody holds or waits for it. A waiter whose
  signal aborts stays queued on the `Mutex` and releases it as soon as its turn comes, so an abort never
  wedges the lock. It adds one method outside the contract, `keys(prefix?)`, a sorted listing, so that a log
  held in memory can be enumerated (exported as static files, inspected in tests).
- `newMemoryDriver(cfg?: MemoryDriverConfig): ObjectStoreDriver`, with
  `MemoryDriverConfig { store?: MemoryObjectStore; fetch?: FetchFn }`. Without a store it creates one; passing
  the same store to several drivers is how one realm restarts a log or runs several appenders on it.

Requested `package.json` entry points (not edited here): `"./storage/objectstore":
"./dist/storage/objectstore/index.js"` and `"./storage/memory": "./dist/storage/memory/index.js"`.

## Consequences

- Names in the TypeScript API do not match Go's one for one. A reviewer needs the table above, which the
  port notes on each declaration repeat.
- A synchronous factory makes `const driver = newMemoryDriver()` a one-liner and cannot hide an
  initialisation failure: everything that can fail (version checks, reading the tree state) happens in
  `appender()` or `migrationWriter()`, as in `files.go`.
- `keys()` is API upstream does not have. It is not part of the `ObjectStore` contract, so no other backend
  has to provide it.

## Alternatives considered

- **Keep Go's names** (`Storage`, `Config`, a `new_`-style factory). Rejected: `Storage` shadows a DOM global
  in every browser build, and unqualified `Config` is ambiguous as soon as two drivers are imported.
- **Return `Driver` (`unknown`)** as `posix.New` returns `tessera.Driver`. Rejected: Go's `any` there costs
  nothing because Go callers never call driver methods directly; in TypeScript it only removes type
  information callers can use.
- **Make the memory store a private detail of `newMemoryDriver`.** Rejected: tests, restarts and
  multi-appender setups all need to hand the same store to several drivers.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Checked the table against `files.go` (`Storage`, `Config`, `New`, `NewTreeFunc`, `MigrationStorage`) and
    `src/storage/objectstore/index.ts`: `posix.New` returns `&Storage{cfg}, nil` and uses neither context nor error;
    `NewTreeFunc` is declared and used nowhere else upstream, as stated; `HTTPClient` feeds only `CheckpointPublisher`
    (witnesses), as `fetch` does here, and the driver calls it through a receiver-less wrapper
    (`fetcher_test.ts`/`driver_test.ts` cover the defaulting). The unexported members that other modules use are public
    with `@internal`; `appender`, `logResourceStorage`, `json.ts` and `isLastLeafInParent` are not exported from the barrel.
    `src/storage/memory/index.ts` exports exactly `MemoryObjectStore`, `newMemoryDriver`, `MemoryDriverConfig`; the
    `package.json` `exports` entries the ADR asked for now exist. Alternatives (keep Go's names, return `Driver`, hide the
    memory store) are fair. `memory_test.ts` (conformance, `keys()`, view copying, abandoned waiters) passes.
  - Not blocking: the barrel also exports `NamedLocks` (ADR-0142), which this table does not list, and the description of
    the memory store's lock ("one `Mutex` per lock name ... a waiter whose signal aborts stays queued") was replaced by
    ADR-0142's `NamedLocks`. An Update line pointing at ADR-0142 would keep this ADR accurate.
