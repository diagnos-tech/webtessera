# ADR-0122: Rely on Durable Object output gates for durability, and on storage for restarts

- **Status:** superseded by ADR-0153
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/file_ops.go` (`overwrite`, `createEx`: fsync of file and
  directory); `storage/posix/files.go` (`newAppender`'s publication and GC goroutines);
  `append_lifecycle.go` (`AddFn`'s durability contract)

## Context

The POSIX driver makes every write durable before returning: `file_ops.go` writes a temporary file, fsyncs
it, links or renames it into place, and fsyncs the directory. Upstream's `AddFn` contract builds on that:
*"Implementations MUST NOT allow the future to resolve to an index value unless/until it has been durably
committed by the storage."* The ObjectStore contract asks the same of every backend: *"Methods resolve only
once the write is durable for the backend in question."*

Durable Object storage resolves a write once it is committed to the object's storage (its in-memory cache,
or its local SQLite database). The runtime confirms the write with the storage service asynchronously,
and it coalesces writes made without an intervening `await`. In exchange, the object's *output gate*
withholds everything it sends to the outside world (HTTP responses, `fetch` subrequests, RPC results) until
every earlier write is confirmed. If a write fails, the runtime discards those outputs and resets the
object. `storage.sync()` waits for confirmation explicitly. The `allowUnconfirmed` option opts a write out
of the gate.

The appender also runs background work on timers: the batching queue's flush timer, the checkpoint
publisher (at most every `checkpointInterval`), the garbage collector, and any `PublicationAwaiter` poll
loop. Upstream runs these as goroutines for the life of the process. A Durable Object instance's life is
decided by the runtime.

We verified the following in workerd (`src/storage/durableobject/driver_test.ts`):

- Timers keep running between requests while the instance stays in memory: a checkpoint is published,
  with no request in flight, for entries added by a request that has already returned.
- workerd will not gracefully evict an instance that has timers pending. `evictDurableObject` times out
  with "it still has active references" until the appender has been shut down and its signal aborted,
  and succeeds right after.
- A hard reset (`ctx.abort()`, standing in for a deploy, a crash or a relocation) discards the instance
  and its timers mid-flight. The next instance's appender resumes from the stored tree state. Every entry
  whose index was returned is present, new entries continue from the next index, and `fsck` verifies the
  whole log.
- Entries integrated but not yet published before a reset are published by the next instance within one
  checkpoint interval.

## Decision

- Store writes resolve when the storage transaction commits. They do not call `sync()`, and they do not
  use `allowUnconfirmed`. A write that has resolved can be lost only together with the object's reset,
  and the reset also discards every output that could have revealed it, including the response that
  would have returned the entry's index. No external observer can therefore see an index whose entry is
  later lost, which is what `AddFn`'s contract protects.
- `newDurableObjectDriver` adds no timers of its own and no alarm-based scheduling. The appender's
  background work is upstream's, bounded by `newAppender`'s signal as everywhere else in the port
  (ADR-0004). Its documentation tells callers to create one driver and one appender per instance, in the
  constructor under `ctx.blockConcurrencyWhile`, and to expect them to live and die with the instance.

## Consequences

- Throughput benefits from write coalescing: integration writes a bundle, several tiles and the tree state
  without waiting on the storage service between them, and confirmations overlap.
- Code inside the object can observe a write before it is confirmed. That is harmless here, because
  nothing the driver does with the knowledge leaves the object without passing the output gate. A
  personality that writes to a system *outside* the object's storage in a way that bypasses the gate
  (none exists in the Workers runtime today) would need `sync()`.
- An open log keeps its instance busy. Pending timers stop the instance from hibernating, and in workerd
  from being evicted gracefully, so an open log should be expected to stay in memory, and be billed for
  duration, until the runtime discards it or the application shuts the appender down. A personality that
  wants idle logs to leave memory must shut its appender down when idle and reopen it on demand. Whether
  production also evicts objects with pending timers after a period without requests is not something we
  could verify locally.
- Restarts are routine: every deploy resets every Durable Object. Correctness never depends on an instance
  living long, only on storage. Freshness of the *published* checkpoint does depend on an instance running:
  after a reset, publication resumes when the next request arrives and recreates the appender. A log that
  must publish without incoming traffic needs an alarm to wake it. The example sidesteps this by answering
  `POST /add` only once the entry is published.

## Alternatives considered

- **`sync()` after every write.** This is the literal reading of "durable before resolving". It would put a
  storage-service round trip behind every tile and bundle write and defeat coalescing, and it would buy
  nothing observable, since the output gate already prevents acting on an unconfirmed write.
- **Driving the appender's loops from Durable Object alarms instead of timers.** This would let an idle
  object hibernate and would survive resets, but it would mean replacing upstream's lifecycle code
  (`ticker`, the publisher loop, the queue's flush timer) with a backend-specific scheduler, which is a
  divergence from the port's structure for one backend. It remains an option for a personality, layered
  on top: an alarm that opens the log and lets it publish.
- **Idle shutdown inside the driver.** Tearing down the appender after a period without adds would break
  the appender's documented lifetime (`shutdown` then abort, both chosen by the caller), and would have to
  coordinate with in-flight futures. It belongs in a personality, if anywhere.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
