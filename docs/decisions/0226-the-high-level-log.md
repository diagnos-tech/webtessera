# ADR-0226: Give each environment one log factory with safe defaults: `openServerLog` and `openBrowserLog`

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** DX guardrails agent
- **Upstream reference:** tessera `append_lifecycle.go` (`NewAppender`, `AppendOptions`), `await.go`
  (`PublicationAwaiter`), `client/client.go` (`ProofBuilder`, `FetchLeafHashes`); webtessera's own
  `src/http/log_handler.ts`, `src/storage/sqlite/`, `src/storage/indexeddb/`

## Context

Running a log with the ported API takes a driver, a signer, `newAppendOptions` with the right options,
`newAppender`, a `PublicationAwaiter`, a proof builder and, on a server, an HTTP handler, wired in the right order
with the right lifetimes. Each step has a mistake waiting in it (ADR-0220). Two are subtle enough to record:

- `PublicationAwaiter.await(future, ctx)` stores a cancelled caller's context error in the awaiter's shared
  `err`, so every other waiter fails with it until the next poll. That is Go's behaviour (`await.go`:
  `if err := ctx.Err(); err != nil { a.err = err }`), ported faithfully.
- A new log publishes its size-0 checkpoint while opening (`storage/posix/files.go`, `initialise`), so with
  witnesses configured, opening fails while they are unreachable.

## Decision

`src/safe/log.ts` holds what both environments share; `src/server/log.ts` and `src/browser/log.ts` choose
storage and add what is specific to each.

**`TransparencyLog`**: `origin`, `vkey`, `verifier`, the ported `reader` and `appender` (the way down), and:

- `append(data, { signal?, timeoutMs? }) → Receipt`: refuses non-`Uint8Array` data and entries over 65535 bytes
  with a message that says what to do (encode text; log a digest of large data), adds the entry, waits on the
  log's one `PublicationAwaiter` for a checkpoint that commits to it, builds the inclusion proof with the ported
  `ProofBuilder` against that checkpoint, and **verifies the receipt** (ADR-0225) against the entry before
  returning it. The caller's signal and the timeout (default 30 s) are raced outside the awaiter, never passed to
  it, so one caller's cancellation cannot fail another's append. A timeout says whether the entry was already
  sequenced, at which index, that `prove(index)` can fetch its receipt later, and to check the witnesses.
  Pushback is reported as an overload to retry.
- `latestCheckpoint()`: the published checkpoint, parsed and verified with the log's key (and witnesses).
- `prove(index)`: a receipt relative to the latest checkpoint, verified against the leaf hash in the log's own
  tiles (`fetchLeafHashes`); an index the checkpoint does not cover is refused with the covered range.
- `verify(receipt, data)`: `verifyReceipt` with the log's key and witness policy.
- `close()`: the ported `shutdown` (every appended entry integrated and published), then the background work is
  stopped and the storage released. Idempotent; methods called after it refuse.

**Defaults and checks, in the order `openLog` applies them:**

1. **The key must be a `LogKey`** (ADR-0222).
2. **A log keeps its key.** If the storage already holds a published checkpoint, it must verify with the key and
   origin; otherwise opening is refused, because every client would reject the log's next checkpoint. This
   catches a regenerated key and two logs sharing storage, from public data alone.
3. **Options.** `checkpointIntervalMs` defaults to 1 s (Tessera's 10 s default is for logs whose clients poll;
   here `append` waits for the checkpoint, so the interval is its latency), and must be at least the driver's
   100 ms minimum; batching is 256 entries or 100 ms. An optional `appendOptions(opts)` hook tunes the ported
   `AppendOptions` (antispam, pushback, garbage collection); the log's key and witnesses are installed after it,
   so they always win.
4. **Witnesses fail closed** (`WitnessOptions.failOpen: false`); `witnessTimeoutMs` bounds each attempt. An open
   that fails because a new log's first checkpoint cannot be witnessed says so.

**Server (`openServerLog`)**: refuses to run in a browser (ADR-0221). `storage` is required, and is one of
`{ sqlite: SqlDatabase, namespace?, locking?, lease? }`, `{ objectStore }` or `{ memory: true }`; a
`MemoryObjectStore` passed as `objectStore` is refused with a pointer to `{ memory: true }`. **SQLite locking
defaults to `"lease"`**, which is correct however many processes reach the database; `"local"` must be chosen to
save the lease's writes, and only where the process is certainly the only writer (a Durable Object). `log.handler`
is `newLogHandler` over the log's reader, configured by `http` (prefix, CORS, caching); `fetch` reaches witnesses.

**Browser (`openBrowserLog`)**: refuses a key string, naming `openDeviceKey`. `storage` defaults to the
IndexedDB database `webtessera-log:<origin>` (Web Locks, failing closed without them unless
`singleWriter: true`, ADR-0201), or is `{ memory: true }`. **A log kept in IndexedDB requires a key that persists
with it**: one from `openDeviceKey`/`loadDeviceKey`/`saveDeviceKey`, or a CryptoKey the application manages
(`fromCryptoKey`); a key from `generateLogKey` would be gone after a reload, leaving a log nothing can sign.

## Consequences

- The common case is one call per environment, and every factory error names the fix.
- Latency of `append` is roughly the checkpoint interval (about 1.1 s measured on node:sqlite with lease
  locking); applications that batch many appends await them concurrently, and each shares one checkpoint.
- Lease locking costs a few writes per integration on single-process SQLite deployments that could have used
  local locks; the trade buys immunity from the one misconfiguration that forks a log.
- Single-key logs only; rotation, CT logs, migration and custom layouts use the ported API.
- `append` resolves only once the entry is published; personalities that want the index sooner use
  `log.appender` directly.

## Alternatives considered

- **Options for every ported knob.** Rejected: the hook passes the ported `AppendOptions` through, so nothing is
  lost, and the factory's own options stay few.
- **Pass the caller's signal to the awaiter.** Rejected: see Context; the race gives the caller the same control
  without the shared-error effect.
- **Default to local locking, as the adapters do.** Rejected: the failure it allows is silent and irreversible.
- **Default server storage to memory.** Rejected: the restart that loses the tree is the failure mode to prevent;
  storage is a decision the developer makes once.
- **Return receipts unverified.** Rejected: verification is a few hashes and one signature check, and it catches
  damaged storage before a client does.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
