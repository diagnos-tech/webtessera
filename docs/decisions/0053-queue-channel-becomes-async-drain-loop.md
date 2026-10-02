# ADR-0053: `Queue`'s buffered channel + goroutine becomes an async drain loop; its mutexes are dropped

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal contributor
- **Upstream reference:** `storage/internal/queue.go`

## Context

`Queue` hands flush batches from `Add`/`flush` to a background worker through a buffered channel:

```go
type Queue struct {
	...
	work chan []queueItem
	mu   sync.Mutex
	items []queueItem
}

func NewQueue(ctx context.Context, maxAge time.Duration, maxSize uint, f FlushFunc) *Queue {
	q := &Queue{ ..., work: make(chan []queueItem, 1), ... }
	go func(ctx context.Context) {
		for {
			select {
			case <-ctx.Done():
				return
			case entries := <-q.work:
				q.doFlush(ctx, f, entries)
			}
		}
	}(ctx)
	return q
}

func (q *Queue) Add(ctx context.Context, e *tessera.Entry) tessera.IndexFuture {
	qi := newEntry(e)
	q.mu.Lock()
	q.items = append(q.items, qi)
	if len(q.items) == 1 {
		q.timer = time.AfterFunc(q.maxAge, q.flush)
	}
	var itemsToFlush []queueItem
	if len(q.items) >= int(q.maxSize) {
		itemsToFlush = q.flushLocked()
	}
	q.mu.Unlock()
	if itemsToFlush != nil {
		q.work <- itemsToFlush   // blocks the caller if the buffer (size 1) is full
	}
	return qi.f
}
```

Two Go idioms here have no direct JavaScript equivalent:

1. **A goroutine that blocks on a channel receive**, waking up to call `doFlush` — the standard
   Go worker-loop shape.
2. **A blocking channel send** (`q.work <- itemsToFlush`) when the buffer is full — Go's scheduler
   parks the sending goroutine and resumes another one; this is how the channel applies
   back-pressure to a caller that produces flushes faster than they can be drained.

JavaScript has no goroutines to park, and `Add` must stay *synchronous* — its entire contract is
to return an `IndexFuture` immediately (`PORTING.md`'s type-mapping table: `Add` takes no `await`
anywhere in its body, and the queue tests submit e.g. 100 entries in a tight, non-`await`ed loop
expecting all of them to be accepted). Blocking `Add` on a full buffer, the way Go's channel send
does, is not an option without changing `Add` into an `async` function that personalities would
have to `await` — a real, observable change to the API's shape that upstream does not have.

## Decision

The channel and its worker goroutine become an unbounded in-memory array (`#pending`) drained by
a single, re-entrant-safe `async` loop (`#drain`), started lazily by whichever of `add()`/`flush()`
first produces a batch to flush:

```ts
#enqueueFlush(items: queueItem[]): void {
	this.#pending.push(items);
	void this.#drain();
}

async #drain(): Promise<void> {
	if (this.#draining) {
		return;   // another in-flight call is already draining #pending
	}
	this.#draining = true;
	try {
		while (this.#pending.length > 0) {
			if (this.signal?.aborted) return;
			const entries = this.#pending.shift();
			if (entries === undefined) break;
			await this.#doFlush(entries);
		}
	} finally {
		this.#draining = false;
	}
}
```

This preserves the properties that matter: batches are flushed **one at a time**, in the order
they were produced (a JavaScript array's `push`/`shift` is FIFO, same as Go's channel), and
`add()`/`flush()` never block. What it does *not* preserve is back-pressure: Go's size-1 buffer
means a *second* concurrently-ready flush blocks its producer until the first is drained; this
port's `#pending` grows without bound if flushes are produced faster than `doFlush` can process
them.

`Add`'s and `flush`'s critical sections (`q.mu.Lock()` … `q.mu.Unlock()`) contain only synchronous
work — appending to a slice, scheduling a timer, building a slice to flush. No `await` occurs
inside either. Per `docs/decisions/0004-errors-context-and-concurrency.md`, a Go critical section
that stays synchronous in the port needs no lock at all, because JavaScript's run-to-completion
semantics already guarantee no other call can interleave with it. Both `add()` and `#flush()`
carry a `// Port note:` at the point the lock is dropped, per
`docs/REVIEW-PROTOCOL.md`'s instruction to check each dropped mutex individually.

`time.AfterFunc(q.maxAge, q.flush)` becomes a plain `setTimeout(() => this.#flush(), maxAgeMs)` —
the direct mechanical equivalent of a fire-and-forget scheduled callback — rather than routing
through `gostd/sync.ts`'s `sleep`/`ticker`, which are `Promise`-based and built for a different
shape of problem (an `async` function awaiting a timeout inline, as in a `select` against
`ctx.Done()`), not a callback scheduled once and possibly cancelled (`clearTimeout`) before it
fires.

## Consequences

- **No back-pressure from a full queue.** In Go, a producer calling `Add` faster than `doFlush`
  can drain eventually blocks. In this port, `#pending` grows unbounded instead. In practice this
  matters only if `FlushFunc` is consistently slower than the rate at which `maxSize`/`maxAge`
  trigger new batches, which is an operational/tuning concern for whoever configures the queue,
  not something any test in this package (or upstream) exercises — `FlushFunc`'s own doc comment
  makes no promise about this either way.
- `#draining`'s guard means only one `#drain()` loop instance ever runs concurrently, matching
  Go's single worker goroutine reading from one channel — this is what keeps `doFlush` calls
  serialized and their notifications in the right order.
- `signal` is checked once per loop iteration in `#drain`, mirroring Go's `select` on `ctx.Done()`
  in the worker loop; unlike Go, an abort here does not empty `#pending` — items already queued
  when the signal fires are left unflushed and their futures never resolve, matching Go's
  behaviour where a cancelled worker goroutine also leaves any already-buffered channel item
  undelivered.

## Alternatives considered

- **Make `Add`/`add` `async`, `await`ing space in a bounded queue.** Rejected: changes `Add`'s
  signature from Go's synchronous-return contract, and every call site (including
  `queue_test.ts`'s ported `TestQueue`, which submits entries in a tight loop) would need
  restructuring. This is exactly the "personality has to change its calling code" cost `PORTING.md`
  §3.7's "everything that does not take a `context.Context` stays synchronous" principle is meant
  to avoid paying without a real upstream reason to.
- **A bounded queue that silently drops or errors past some capacity.** Rejected as invention: Go
  places no explicit cap here either (the channel buffer of 1 is an implementation detail of the
  hand-off, not a documented capacity limit — `FlushFunc`'s contract says nothing about it), so
  inventing one would be adding behaviour upstream does not have and does not ask for.
- **Route the timer through `gostd/sync.ts`'s `sleep`.** Rejected: `sleep` is designed to be
  `await`ed inline inside an `async` function; using it here would force `add()` to become `async`
  just to start a background timer, which is a worse fit than `setTimeout` for a fire-and-forget,
  cancellable-before-it-fires callback — exactly `time.AfterFunc`'s shape.

## Review

- **Reviewer:** Storage-Internal Reviewer
- **Verdict:** approved
- **Notes:** Diffed `queue.ts` against `queue.go` line by line. Verified the re-entrant
  drain loop cannot double-process or drop an item under concurrent `add()`s during an
  in-flight flush: the `#draining` boolean admits exactly one loop; a concurrent
  `#enqueueFlush` pushes to `#pending` then calls `#drain`, which returns early — the running
  loop picks up the new batch on its next `while` check; and crucially there is **no `await`
  between the loop's final `while (#pending.length > 0)` test and the `finally` that clears
  `#draining`, so no item can be stranded by being pushed after the loop sees empty but before
  the guard is released (that window is synchronous). FIFO is preserved (`push`/`shift`).
  Dropped mutexes in `add()`/`#flush()` are justified: both critical sections are wholly
  synchronous (ADR-0004). Confirmed `notify` builds `{ index, isDup: false }` matching Go's
  `tessera.Index{Index: idx}`, and the panic message text is byte-identical. Back-pressure
  loss and abort-leaves-`#pending` are honestly documented and match Go's cancelled-goroutine
  behaviour; neither affects tree correctness. I added a deterministic stress test
  (`queue_test.ts`, "processes every item exactly once when adds interleave with an in-flight
  flush") that holds the first flush open while 20 further adds enqueue behind it, asserting
  exactly-once, in-order delivery — it passes.
