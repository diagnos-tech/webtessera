# ADR-0111: Commit every IndexedDB write with strict durability, with no opt-out

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/file_ops.go` (`createTemp`, `syncDir`, `createEx`, `overwrite`)

## Context

The POSIX driver does not consider a write done until it is on disk. `createTemp` opens files with `O_SYNC`,
and every create or overwrite runs inside `syncDir`, which `fsync`s the containing directory after the link or
rename:

```go
// syncDir opens the specified directory and calls op before syncing and closing the handle on the directory.
//
// This dance ensures that the inode of the specified directory cannot be evicted from the kernel inode cache while
// the operation is underway, and so any error which occurs while updating metadata about a file operation which happens
// _within_ that directory is detected.
```

There is no configuration that turns this off. The `ObjectStore` contract carries the same requirement:
*"Methods resolve only once the write is durable for the backend in question."*

For IndexedDB, "the transaction completed" does not by itself mean "on disk". `IDBTransactionOptions.durability`
lets a page ask for `"strict"` (the browser flushes to persistent storage before firing `complete`) or `"relaxed"`
(it may fire `complete` once the data is in the operating system's buffers). `"default"` is whatever the browser
chooses, which differs between browsers and has changed over time.

The difference matters for a transparency log. A relaxed commit survives a tab or browser crash but not an
operating system crash or power loss, and what is lost is a suffix of recent commits. If that suffix includes
indices the appender has already returned to callers, or a checkpoint that has already been served, the log
restarts at a smaller size and assigns those indices to different entries: a fork, signed by the log's own key.

## Decision

Every readwrite transaction the store opens passes `{ durability: "strict" }`. Read-only transactions pass no
options, since durability does not apply to them. There is no option to choose a weaker setting.

Browsers that do not implement the hint ignore the unknown dictionary member and use their default commit
behaviour, which the store cannot strengthen; the hint is still sent so that those browsers pick it up when
they implement it.

Both test suites assert that every write transaction requests strict durability, and the Chromium suite asserts
that Chromium reports `durability === "strict"` on those transactions.

## Consequences

- Each write costs a flush. The driver writes per integrated batch, not per entry, so the cost scales with
  batches; it is the same trade the POSIX driver makes.
- An application that wants a throwaway log (a demo, a cache) still pays for durability. Such an application can
  wrap or implement its own `ObjectStore`; the contract is public.

## Alternatives considered

- **A `durability` option defaulting to `"strict"`.** Rejected: any other value breaks the `ObjectStore`
  contract in a way that only shows up after a power cut, as a fork. Upstream offers no equivalent switch, and
  an option whose only use is to unsafely trade integrity for speed is a trap for exactly the users who do not
  know why it is there.
- **Leaving durability to the browser default.** Rejected: the default is relaxed in some browsers, so the
  guarantee would depend on where the page happens to run.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Checked the quoted `syncDir` comment against `file_ops.go` (verbatim), and that `createTemp` opens with `O_SYNC` and
    `overwrite`/`createEx` run inside `syncDir`, with no switch to turn it off. In `indexeddb.ts` every `readwrite`
    transaction is opened with `{ durability: "strict" }` and read-only ones with no options.
  - The test claims hold. `indexeddb_test.ts` "commits every write with strict durability" spies on `IDBDatabase.transaction`
    and asserts modes `readwrite` x5, `readonly` x2 and durability `strict` x5, `default` x2; `indexeddb_browser_test.ts`
    asserts the same in real Chromium, which reports `strict` on the write transactions (both ran and passed).
  - The unknown-dictionary-member claim for browsers without the hint is standard WebIDL behaviour. The reasoning
    (a relaxed commit can lose acknowledged indices and fork the log) is sound, and rejecting an option is the right
    call given upstream offers no such switch.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
