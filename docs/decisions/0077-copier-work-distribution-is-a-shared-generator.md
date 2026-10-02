# ADR-0077: `Copier`'s work queue is a shared generator, not a buffered channel

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate agent
- **Upstream reference:** `migrate.go`'s `copier`, `newCopier`, `populateWork`, `worker`

## Context

Go's `copier` distributes work to its workers through a buffered channel, filled by a dedicated
producer goroutine:

```go
func newCopier(numWorkers uint, ...) *copier {
    return &copier{ ..., todo: make(chan bundle, numWorkers) }
}

func (c *copier) Copy(ctx context.Context, fromSize uint64, sourceSize uint64) error {
    go c.populateWork(fromSize, sourceSize)
    eg := errgroup.Group{}
    for range cap(c.todo) {
        eg.Go(func() error { return c.worker(ctx) })
    }
    ...
}

func (m *copier) populateWork(from, treeSize uint64) {
    defer close(m.todo)
    for ri := range layout.Range(from, treeSize-from, treeSize) {
        m.todo <- bundle{Index: ri.Index, Partial: ri.Partial}
    }
}

func (m *copier) worker(ctx context.Context) error {
    for b := range m.todo {
        ...
    }
    return nil
}
```

The channel's buffer size (`numWorkers`) bounds how far the producer goroutine can run ahead of the
slowest consumer — real backpressure, because `layout.Range` could in principle enumerate far more
bundle addresses than fit comfortably in memory for a very large log.

## Decision

`src/migrate.ts`'s `populateWork` is a plain synchronous generator (`function*`) yielding `Bundle`
values directly from `range(from, treeSize - from, treeSize)` — the same iterator
`api/layout/paths.ts`'s `range` already is. `Copier.copy` starts `numWorkers` async worker functions
that all call `.next()` on the **same** generator object:

```ts
const todo = populateWork(fromSize, sourceSize);
for (let i = 0; i < this.#numWorkers; i++) {
    eg.go(() => this.#worker(todo, signal));
}
```

This is safe without a lock: `Generator.next()` runs synchronously up to its next `yield`, and
JavaScript's single-threaded, run-to-completion execution model guarantees no two `.next()` calls
from different "concurrent" workers can ever interleave — the same ADR-0004 reasoning that drops a
Go mutex whenever the critical section it guards stays synchronous in the port. Each worker's loop
(`for (let next = todo.next(); !next.done; next = todo.next())`) claims exactly one item per
iteration before its own `await`, so no item is ever handed to two workers and no item is skipped.

There is no separate "producer" coroutine and no explicit backpressure mechanism: the generator is
pulled lazily, exactly once per item actually consumed, which is at least as memory-bounded as Go's
channel (nothing is ever materialized ahead of demand either way) without needing a bounded-buffer
abstraction to get there.

## Consequences

- `src/migrate.ts` has no direct counterpart to Go's `todo chan bundle` field, the `populateWork`
  goroutine, or `close(m.todo)` — a reviewer diffing the two files structurally will find
  `populateWork` present (same name, same job) but not backed by a channel. This ADR is that gap's
  explanation.
- `populateWork` is directly unit-testable as a plain generator (`[...populateWork(from, treeSize)]`)
  without needing to run `Copy` at all — `src/migrate_test.ts`'s `describe("populateWork", ...)` does
  exactly this, which is *more* directly testable than Go's version (which has no direct test, per
  ADR-0074, because a channel-draining producer goroutine is not something a unit test can observe in
  isolation the way a generator's yielded sequence can).
- If a future caller needs genuine backpressure (e.g. a browser tab importing a log so large that even
  lazily-generated `Bundle` addresses' in-flight HTTP requests need throttling beyond `numWorkers`),
  that throttling belongs in the worker loop itself (e.g. via `ErrGroup.setLimit`), not in
  `populateWork` — the generator was never the bottleneck Go's channel buffer was sized to protect.

## Alternatives considered

- **A hand-rolled bounded async queue** (push/shift with waiter promises, mirroring a Go channel more
  literally). Rejected: strictly more code and a new primitive to test, for a memory-bounding property
  the lazy generator already provides for free — see ADR-0072 for the same judgement applied to
  `WitnessGateway.witness`'s channel.
- **Materialize the full `Bundle[]` list upfront**, with workers claiming indices via a shared cursor.
  Considered and rejected in favour of the generator specifically because it avoids materializing a
  potentially very large array — closer to Go's streaming intent than a fully-buffered list would be,
  at no extra implementation cost over a generator.

## Review

- **Reviewer:** Witness/Migrate Reviewer (agent)
- **Verdict:** approved
- **Notes:** Checked against `migrate.go`'s `copier`/`Copy`/`populateWork`/`worker`. The shared
  generator is safe for the reason given: `todo.next()` runs synchronously to its `yield`, and JS
  run-to-completion means no two workers' `.next()` calls interleave, so each `Bundle` goes to
  exactly one worker with no lock — the same ADR-0004 reasoning that drops a synchronous mutex.
  `populateWork` yields `{index, partial}` straight from `range(from, treeSize-from, treeSize)`,
  identical to Go's `layout.Range(from, treeSize-from, treeSize)` loop, and `range` itself is the
  already-fixture-backed Wave-1 port (layout_range.json, 27 cases). Re-derived the boundary cases
  independently: from=0/size=257 → `[{0,full},{1,p=1}]`; resume from=256/size=257 → `[{1,p=1}]` (the
  already-copied full tile 0 is not re-emitted); mid-tile resume from=100/size=200 → `[{0,p=200}]`
  (whole bundle re-copied, correct since migration copies whole bundles); from==size → `[]`. No
  off-by-one, nothing skipped or duplicated. `migrate_test.ts`'s 4-worker "exactly once" case is
  the concrete proof the shared generator hands each item out once. Memory-bounding claim holds —
  lazy pull, nothing materialised ahead of demand.
