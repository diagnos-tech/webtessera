# ADR-0063: `LogStateTracker`'s `sync.RWMutex` becomes a `Mutex` for `update`, and no lock at all for `latest`

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** client agent
- **Upstream reference:** `client/client.go` (`LogStateTracker`, `Update`, `Latest`)

## Context

Go's `LogStateTracker` guards its mutable state with a `sync.RWMutex`:

```go
type LogStateTracker struct {
	...
	mu sync.RWMutex
	latestConsistent    log.Checkpoint
	latestConsistentRaw []byte
	proofBuilder        *ProofBuilder
}

func (lst *LogStateTracker) Update(ctx context.Context) ([]byte, [][]byte, []byte, error) {
	...
	lst.mu.Lock()
	defer lst.mu.Unlock()
	...
	p, err = builder.ConsistencyProof(ctx, lst.latestConsistent.Size, c.Size)  // <-- I/O, while holding the lock
	...
}

func (lst *LogStateTracker) Latest() log.Checkpoint {
	lst.mu.RLock()
	defer lst.mu.RUnlock()
	return lst.latestConsistent
}
```

`src/internal/gostd/sync.ts` provides `Mutex` (exclusive) but no `RWMutex` (shared-read).
`docs/decisions/0004-errors-context-and-concurrency.md` already establishes the general
rule this ADR applies: a Go critical section that stays synchronous in TypeScript needs no
lock at all (JavaScript's run-to-completion semantics already provide it for free), while
one that spans an `await` genuinely does, because `await` is an interleaving point.

`Update`'s critical section is **not** purely synchronous: `builder.ConsistencyProof(ctx,
...)` fetches Merkle tiles over the network (or from disk), which is `await` in the port.
`Latest`, on the other hand, has no `ctx` parameter at all in Go and its body is a single
field read — the entire reason it uses `RLock` rather than `Lock` is a Go-specific
optimisation (let concurrent *readers* proceed without blocking each other across OS
threads), not a correctness requirement, and it has no counterpart need in a
single-threaded runtime.

## Decision

- `update` (Go's `Update`) uses `Mutex.do(...)` from `src/internal/gostd/sync.ts`,
  wrapping exactly the same span Go's `lst.mu.Lock(); defer lst.mu.Unlock()` covers:
  from the "is this checkpoint newer?" check through the final field assignments,
  including the `await`ed `consistencyProof` call and the thrown `ErrInconsistency` path.
  `Mutex.do`'s `try/finally` matches Go's `defer Unlock()` exactly, including on the
  early-return ("not newer") and thrown-error paths.
- `latest` (Go's `Latest`) takes **no lock at all** and is a **synchronous** method
  (`latest(): Checkpoint`, not `Promise<Checkpoint>`), per AGENTS.md §3.7's mandatory rule
  that a Go function without a `ctx` parameter stays synchronous. This is not merely
  permitted by that rule, it is *forced* by it: `Latest()` has no `ctx`, so it cannot
  become `async` without inventing an API upstream does not have.
- Correctness of the lock-free read: `update`'s three field mutations
  (`_latestConsistentRaw`, `_latestConsistent`, `_proofBuilder`) happen in one
  uninterrupted synchronous run — no `await` sits between them — so a `latest()` call
  interleaved via microtask scheduling can only observe the state strictly before or
  strictly after all three assignments, never a torn mix of old and new. `Mutex` would add
  nothing here but the possibility of `latest()` blocking behind an in-flight `update()`,
  which upstream's `RLock` specifically avoids too (it lets readers past a writer's lock
  only when there is no writer — but *never* serialises a reader behind another reader,
  and this port has the same property for free by construction).

## Consequences

- `gostd/sync.ts` gains no new primitive. Adding an `RWMutex` purely to shadow this one
  call site would provide zero additional safety in a single-threaded runtime over what a
  plain `Mutex` (or, for `latest`, no lock) already gives, so it is not built.
- `latest()`'s synchronous signature is the first place in this port where a
  Mutex-guarded-in-Go accessor becomes lock-free-in-TypeScript rather than
  `Mutex`-guarded; a reviewer comparing `RWMutex` sites to `Mutex` sites elsewhere in the
  port should expect this asymmetry specifically where the accessor has no `ctx`.
- If a future change ever makes `update`'s field mutations span an `await` (e.g. a
  persistence step added between them), `latest()`'s no-lock argument would need
  re-examining before that could safely land — noted here so it is not silently invalidated.

## Alternatives considered

- **Add `RWMutex` to `gostd/sync.ts` and use it here to mirror Go exactly.** Rejected:
  AGENTS.md §3.5.1 says to add a missing gostd primitive "if one of them is missing
  something you need" — but a plain `Mutex` already fully covers `update`'s needs, and
  `latest` needs no lock at all, so nothing is actually missing. Building `RWMutex` here
  would be machinery in search of a justification, which ADR-0004's "check whether it can
  stay simpler first" explicitly warns against.
- **Keep `latest` async, wrapped in `Mutex.do`, purely to mirror `RLock`/`RUnlock`
  textually.** Rejected: it contradicts AGENTS.md §3.7's explicit, mandatory
  ctx-determines-sync-or-async rule, turns a same-tick field read into a microtask-deferred
  one for every caller, and buys no additional safety per the reasoning above.
- **Drop the lock from `update` too, reasoning that "JavaScript is single-threaded"
  covers everything.** Rejected: `update`'s critical section spans a real `await`
  (`consistencyProof`'s tile fetches), which is exactly the interleaving point
  ADR-0004 says still needs a lock — two concurrent `update()` calls could otherwise both
  read the same stale `_latestConsistent` before either has written its result.

## Review

- **Reviewer:** Client Reviewer (Opus 4.8)
- **Verdict:** approved
- **Notes:** Verified against `client/client.go`. `update` wraps the exact span Go's
  `mu.Lock()`/`defer Unlock()` covers — from the size check through the field assignments,
  including the awaited `consistencyProof` and the thrown `ErrInconsistency` path — via
  `Mutex.do`'s try/finally, so the lock is released on the early-return, success, and throw paths
  alike, matching `defer`. Confirmed the three field mutations (`_latestConsistentRaw`,
  `_latestConsistent`, `_proofBuilder`) run with no `await` between them, so a synchronous
  `latest()` can never observe a torn state; dropping the lock on `latest` is therefore safe and is
  forced by AGENTS.md §3.7 (no `ctx` in Go's `Latest`). The retained `Mutex` on `update` is
  genuinely needed — its critical section spans the tile-fetching `await`, the real interleaving
  point two concurrent updates could race on. Reasoning is correct; no RWMutex needed.

## Update (2026-10-02): what `latest()` observes, and value semantics

The Decision overstates the equivalence with `RLock`. Go's `Latest()` takes `RLock`, which waits for
an `Update` holding the write lock — including across its consistency-proof fetch — so a caller of
`Latest()` during an update sees the state *after* that update. The port's `latest()` takes no lock
and returns at once, so during an in-flight `update()` it sees the state *before* it. Both are
untorn snapshots; they are not the same snapshot. The port's choice still follows from §3.7 (no
`ctx`, so synchronous), and no caller in Tessera depends on the difference, but it is a semantic
difference, not merely an optimisation dropped.

Separately, Go's tracker holds a `log.Checkpoint` value: `lst.latestConsistent = *c` copies the
consensus function's checkpoint in, and `Latest()` returns a copy out. The port held and returned
the same object, so a caller mutating either one changed the tracker's state. Both directions now
copy (`copyCheckpoint`; the `hash` bytes stay shared, as Go's slice header copy shares them).

*Review of this update: pending.*
