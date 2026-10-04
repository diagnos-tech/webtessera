# ADR-0110: Keep a log in IndexedDB as one record per ObjectStore key

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go`, `storage/posix/file_ops.go` (the model the ObjectStore
  driver is ported from); no upstream counterpart for IndexedDB itself

## Context

Tessera has no browser backend. The port runs the POSIX driver's logic on top of the `ObjectStore` contract
(`src/storage/objectstore/objectstore.ts`), and a browser needs an implementation of that contract that
survives a reload and is shared by every tab and worker of an origin. IndexedDB is the only browser storage
that is transactional, asynchronous, available in windows and in dedicated, shared and service workers, and
able to hold multi-megabyte binary values: entry bundles reach 256 entries of up to 64 KiB each.

The contract's requirements map onto IndexedDB as follows:

- *"Every method must be atomic with respect to the key(s) it touches"*: one IndexedDB transaction per method.
- *"Methods resolve only once the write is durable"*: resolve on the transaction's `complete` event, never on
  the request's `success` event, and request strict durability (ADR-0111).
- `create` is POSIX `O_CREAT|O_EXCL` (`createEx` in `file_ops.go`).
- `deletePrefix` is `os.RemoveAll` on a directory.
- `lock` is the `flock`-based `lockFile`, which must exclude other tabs (ADR-0112).

IndexedDB also has failure modes a file system does not: another tab can upgrade or delete the database, the
browser can close a connection (the user clears site data), and a transaction commits by itself as soon as it
has no pending requests at the end of a task.

## Decision

**Layout.** A database named by the caller, at schema version 1, holding one object store, `objects`, with
out-of-line string keys. Each ObjectStore key is one record, `{ data: Uint8Array, modTime: number }`, stored
under that key. There is no size field: IndexedDB cannot read part of a record, so `stat` loads the record
anyway and `data.length` is authoritative. Upgrades go through `upgradeSchema(db, oldVersion)`, a chain of
`if (oldVersion < n)` steps, so that a future layout change is one new step and one bump of `schemaVersion`.
Opening a database written by a newer schema fails with a message naming the cause (IndexedDB's
`VersionError`), and opening an existing database that has no `objects` store fails rather than writing into
someone else's data.

**Transactions.** Every method runs exactly one transaction and issues all of its requests synchronously when
the transaction is created, so no `await` ever falls inside a transaction and auto-commit cannot split an
operation. Promises settle on `complete` (or on `abort`, with the transaction's error), reads included, so all
methods report errors the same way.

- `put` is `IDBObjectStore.put`.
- `create` is `IDBObjectStore.add`. A `ConstraintError` means the key exists; the error event is cancelled
  (`preventDefault`) so the transaction completes and `create` resolves to `false` after commit. IndexedDB
  serialises overlapping readwrite transactions, so exactly one of several concurrent creates wins, across
  tabs as well as within one.
- `deletePrefix` deletes the key range `[prefix, successor(prefix))` in one request, where the successor is
  the prefix truncated after its last code unit below U+FFFF, with that unit incremented. IndexedDB orders
  strings by UTF-16 code unit, so this range is exactly the keys that start with the prefix; the common
  `prefix + "￿"` upper bound would miss keys continuing with U+FFFF. An empty prefix clears the store.

**Copies.** `put` and `create` store `data.slice()`. IndexedDB clones what it stores, but the structured clone
of a typed array serialises the whole buffer behind it, so a small view into a large buffer would otherwise
persist all of it; the copy also makes a view of a `SharedArrayBuffer` storable. Reads need no copy because
each one deserialises a fresh array.

**Connection lifecycle.** The store closes its connection on `versionchange`, so that another tab upgrading or
deleting the database is never blocked by it, and records why. `close()` and the browser closing the connection
(`close` event) are recorded the same way. From then on every method rejects with an error whose message says
what happened (`database "x" was closed so that another tab or worker could upgrade it to schema version 2`)
and whose `cause` is the exported sentinel `ErrClosed`, checked with `errorIs`. In-flight transactions finish
normally: IndexedDB's `close()` waits for them.

**Public API** (`webtessera/storage/indexeddb`, new; upstream has no counterpart):

- `openIndexedDBObjectStore(opts, signal?) → Promise<IndexedDBObjectStore>`. `opts` is
  `{ name, indexedDB?, IDBKeyRange?, locks? }`. `indexedDB` and `IDBKeyRange` default to the globals, and exist
  to inject another implementation (fake-indexeddb on Node); the pair mirrors Dexie's options of the same names,
  because a key range must come from the same implementation as the factory. `locks` is ADR-0112. `signal`
  abandons a wait for the database to open (another context mid-upgrade); the connection the open request
  eventually delivers is then closed, so it cannot block later upgrades.
- `IndexedDBObjectStore`, an interface extending `ObjectStore` with `name`, `lockScope` and `close()`. The
  implementing class is not exported: there is no valid way to construct one other than opening a database, and
  an interface keeps that internal constructor out of the API.
- `ErrClosed`, `LockScope`.

The engine driver convenience built on this store is ADR-0113.

## Consequences

- The database holds a byte-for-byte copy of a static tlog-tiles log under the C2SP paths, like the POSIX
  driver's directory. Serving it from a service worker is a key lookup per request path.
- Browsers may evict IndexedDB data under storage pressure unless the origin has persistent storage. Evicting a
  log whose checkpoints have left the device would let it fork. The library does not call
  `navigator.storage.persist()` itself (in some browsers it prompts the user, which is the application's call),
  but the `IndexedDBObjectStore` documentation and the browser example tell applications to request it.
- A connection closed by `versionchange` is not reopened automatically. Reopening silently could run old code
  against a newer schema; failing loudly with `ErrClosed` lets the application reload instead.
- `stat` on a large object reads all of it. The driver only `stat`s the checkpoint, which is small.

## Alternatives considered

- **Separate object stores for data and metadata**, so that `stat` reads only metadata. Rejected: it doubles
  the requests in every write to optimise a call the driver makes only on a small object.
- **Storing values as `Blob`s.** Rejected: reading a Blob back is a second asynchronous step outside the
  transaction, and Chromium already moves large values out of line on its own.
- **`count` (or `get`) then `add` in `create`.** Equally atomic inside one transaction, but two requests instead
  of one; cancelling `add`'s `ConstraintError` is the direct analogue of `O_EXCL`.
- **Exporting the class with a public constructor that takes an `IDBDatabase`.** Rejected: it would let callers
  hand in a connection without the `versionchange` handling and schema checks above.
- **Rejecting as soon as the open request reports `blocked`.** Rejected: `blocked` also fires transiently while
  another connection finishes its last transaction after agreeing to close, which is what every other instance
  of this store does. Waiting, with an optional `signal`, is IndexedDB's own behaviour.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - No Go original; reviewed under REVIEW-PROTOCOL 2.6 against the contract in `objectstore.ts`. Read
    `src/storage/indexeddb/indexeddb.ts` and `locks.ts` in full. One transaction per method, all requests issued
    synchronously, promises settle on `complete`/`abort`; `put` is `put`, `create` is `add` with the `ConstraintError`
    cancelled (`preventDefault`) so the transaction completes and resolves `false`; `deletePrefix` deletes
    `[prefix, successor)` where the successor increments the last code unit below U+FFFF, `clear()` for the empty prefix,
    `lowerBound` for an all-U+FFFF prefix; `put`/`create` store `data.slice()`; the connection closes on `versionchange`
    and `close` with `ErrClosed` as the cause of every later rejection; newer-schema (`VersionError`) and "no `objects`
    store" opens are refused; `signal` abandons an open and the late connection is closed. Layout and `upgradeSchema`
    as described.
  - Run in both runtimes. Node with fake-indexeddb: `src/storage/indexeddb` unit suites passed (part of the 312-test
    run over objectstore, memory, `storage_test.ts` and indexeddb). Real Chromium (`bun run test:browser` config,
    chromium-1194, `src/storage/indexeddb`): 2 files, 72 tests passed, which includes `describeObjectStoreConformance`,
    `describeDriverConformance` and `describeGoldenCompatibility` unmodified, the `deletePrefix` boundary table
    (`testing/prefix_cases.ts`: U+FFFF, surrogate halves, the empty prefix) shared by both runtimes, and the two-realm
    (page and module worker) cases. The view-copy, close-on-`versionchange`, in-flight-write and malformed-record cases exist
    and pass.
  - Consequences checked: the driver `stat`s only `.state/version` and the checkpoint (small); the persistence advice is
    in the `IndexedDBObjectStore` doc comment and in `examples/client-only` (`navigator.storage.persist()`). Alternatives
    (separate metadata store, Blobs, `count` then `add`, public constructor, rejecting on `blocked`) are reasoned.
  - Not blocking: the `opts` list omits `singleWriter` (ADR-0201, a later ADR), and `lockScope` was added by ADR-0112's
    Update.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
