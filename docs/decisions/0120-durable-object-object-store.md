# ADR-0120: Keep a log in Durable Object storage, chunking objects larger than a storage value

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go`, `storage/posix/file_ops.go` (the model the ObjectStore
  driver is ported from); no upstream counterpart for Durable Objects

## Context

Tessera has no edge backend. The port runs the POSIX driver's logic on top of the `ObjectStore` contract
(`src/storage/objectstore/objectstore.ts`). A Cloudflare Durable Object needs an implementation of that
contract over its storage. Durable Object storage comes in two backends, and a class's backend is fixed
by the migration that creates it:

- **KV-backed** (`new_classes`): the key/value API only. Production limits: a key of at most 2 KiB, a
  value of at most 128 KiB *after structured-clone serialization*, and at most 128 keys per multi-key
  `get`, `put` or `delete`.
- **SQLite-backed** (`new_sqlite_classes`, the recommended default for new classes): the same key/value
  API plus SQL. The key/value API accepts about 2 MB for a key and its value together.

Both backends offer `transaction(closure)`, which commits every write made through its `txn` atomically.

The log's objects do not fit those limits. Tiles are at most 8 KiB, but an entry bundle holds up to 256
entries of up to 64 KiB each, so it can reach 16 MiB. The contract also requires that *"every method must
be atomic with respect to the key(s) it touches: a reader observes either the previous contents of a key
or the new ones, never a mix"*, that `create` be `O_CREAT|O_EXCL`, and that `deletePrefix` be
`os.RemoveAll`.

We probed local workerd (the runtime `wrangler dev` and `@cloudflare/vitest-pool-workers` use) for both
backends. Findings that shape the decision:

1. Local workerd enforces **none** of the production limits above, for either backend: it stored 2 MiB
   values in a KV-backed object and accepted 129-key multi-key calls. Its only limit is SQLite's, around
   2 MiB. A store that passes tests locally can therefore still fail in production.
2. Storing a `Uint8Array` view serializes its **whole underlying buffer**: a 10-byte `subarray` of a
   200 KiB array was stored, and read back, as a view over a 204800-byte buffer.
3. `put` snapshots its value synchronously, and every `get` returns a freshly deserialized copy.
4. Keys containing U+0000 round-trip on both backends, and `list({ prefix })` treats them like any other
   character.
5. In workerd, concurrent `transaction()` closures in one object run one after another, and a plain
   `get` waits for an in-flight transaction to commit. The Cloudflare documentation says that
   transactions are atomic. It does not say that they are isolated from one another.
6. `ctx.storage` is the same object for the instance's whole life, across requests.

## Decision

`DurableObjectObjectStore` (`src/storage/durableobject/durableobject.ts`) implements `ObjectStore` over
the key/value API alone, so one implementation serves both backends.

**Layout.** Every object is a *head* record stored under the object's own key, so the storage's key space
is the log's tlog-tiles path space:

- An object of at most `maxValueBytes` bytes is stored inline: `{ size, modTime, data }`.
- A larger one is split into `ceil(size / maxValueBytes)` chunks, each a `Uint8Array`, stored under
  `<key>\u0000<gen>.<i>`. Its head is `{ size, modTime, gen, chunks }`.

`gen` is 64 random bits, in hex, chosen for each write of a chunked object (and re-drawn in the
2⁻⁶⁴ case that it equals the generation it replaces). Chunks are never overwritten, only deleted, so a
chunk key names one immutable value for as long as it exists.

**Why NUL.** Keys and prefixes containing U+0000 are rejected, so a prefix selects an object's chunks if
and only if it selects the object. A prefix no longer than the key matches the chunk keys exactly when it
matches the key. A longer prefix would have to contain the NUL that follows the key. POSIX paths cannot
contain NUL either, so the constraint costs the driver nothing it had.

**`maxValueBytes`** defaults to `DefaultMaxValueBytes` = 127 KiB, which fits the KV backend's 128 KiB
with a 1 KiB margin for serialization framing and the head's fields (well under 200 bytes together).
A SQLite-backed object may raise it.

**Writes.** `put`, `create` and `deletePrefix` each run as one `transaction()`, however many keys they
touch, and split every multi-key call into runs of at most 128 keys:

- `put` reads the current head, writes the new chunks and head, and deletes the chunks of the version it
  replaces, so shrinking or replacing an object leaves nothing behind.
- `create` reads the head and writes only if there is none.
- `deletePrefix` lists the prefix in pages of 128 keys (heads and chunks alike, since chunk keys extend
  their object's key), deleting each page. It passes `noCache`, so the chunk values the listing must load
  do not displace the runtime's cache.

On top of the transaction, the three writes are serialized by a `Mutex` shared by every store over the
same storage object (ADR-0121 has the shared-state mechanism). The mutex is what makes `create`'s
check-then-write and `put`'s replacement of old chunks race-free. It does not depend on finding 5, which
is observed behaviour that the documentation does not promise.

**Reads.** `get` and `stat` take no lock. `stat` reads the head. `get` of an inline object is one read. For
a chunked object, `get` reads the head and then its chunks, in batches of at most 128 keys. Chunk keys are
generation-named and immutable, so if every chunk is present the result is exactly the version the head
describes. If a concurrent write replaced or deleted that version in between, some chunk is missing,
never different. The read is then retried once under the write mutex, where no writer can interfere.
Every read checks the reassembled length against the head and reports a mismatch, or a value the store did
not write, as corruption.

**Copies.** `put` and `create` copy their input into one tight buffer per stored value before their first
`await` (finding 2). The copy is also what lets callers reuse their array as soon as the call returns.
Reads return the storage's fresh copies (finding 3).

**Structural typing.** The store depends on `DurableObjectStorageLike` and `DurableObjectTransactionLike`,
interfaces naming only the methods it calls (`get`, `transaction`, and on the transaction `get`, `put`,
`delete`, `list`). The library therefore needs no `@cloudflare/workers-types`, and the real
`ctx.storage` of either backend satisfies them, which the workers-typed tests prove by assignment.

**Verification.** `pnpm test:workers` runs, in workerd, for a KV-backed and a SQLite-backed class:

- the shared ObjectStore and driver conformance suites, once over raw `ctx.storage` and once with
  `maxValueBytes` = 4 KiB through `StrictStorage`, a test double that rejects every call the production
  runtime would reject (value size, counting a view's whole buffer; key size; keys per call);
- chunking edge cases (threshold − 1, threshold, threshold + 1, more than 128 chunks, overwrites in every
  direction, `create` and `deletePrefix` on chunked objects, subarray inputs);
- a read racing an overwrite and a delete;
- concurrent writes over `LooseStorage`, a double whose transactions are atomic but not isolated, which
  fails without the write mutex;
- persistence across eviction.

## Consequences

- One code path for both backends, but a KV-backed object pays one extra read, and a transaction, for every
  object over 127 KiB. Such objects are full or large partial entry bundles; tiles and checkpoints are
  always a single read.
- The store owns the whole storage of its Durable Object. Any other state of the object must live
  elsewhere: `deletePrefix("")` would delete it, and `get` would report it as corrupt.
- Values are structured-clone records, not raw bytes, so the storage is not a byte-for-byte file tree as a
  POSIX log directory is. The bytes of every resource are still exactly what the POSIX driver would write.
- `deletePrefix` holds one transaction across all its pages. Garbage collection deletes at most 255 partial
  resources per prefix, so this stays small, but a caller deleting a huge prefix pays for it.
- The head's shape is the storage format. Changing it later requires recognizing both shapes, since a head
  carries no version field: an added field must default to today's meaning when absent.

## Alternatives considered

- **SQL, for SQLite-backed objects only.** A table of `(key, modTime, data)` rows with up to 2 MB per row
  would chunk less often, but excludes KV-backed objects and needs its own chunking above 2 MB anyway.
- **Chunks in a separate key namespace** (for example `\u0001<key>/<i>`), deleted by computing their keys
  from the heads under a prefix. That avoids loading chunk values when deleting, but `deletePrefix` no
  longer catches chunks by construction: a chunk orphaned by a bug would be invisible to it.
- **Chunk keys by index only (`<key>\u0000<i>`), overwritten in place.** Simpler, but then a lock-free
  reader can combine an old head with new chunks. Reads would need the write mutex, serializing every
  tile and bundle read behind every write.
- **A generation counter (`old.gen + 1`) instead of random bits.** Deterministic, but it restarts after
  `deletePrefix` removes the head. A reader holding a deleted version's head could then read a newer
  object's chunks under the same names.
- **A printable reserved separator such as `#`.** It would read better in the dashboard's data browser,
  but "keys may not contain `#`" is an arbitrary rule, while "keys may not contain NUL" is the one POSIX
  already imposes.
- **Relying on `transaction()` isolation instead of a mutex.** Simpler, and sufficient in today's workerd,
  but it rests on behaviour Cloudflare does not document. The mutex costs nothing measurable, because
  storage operations complete from the object's cache.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
