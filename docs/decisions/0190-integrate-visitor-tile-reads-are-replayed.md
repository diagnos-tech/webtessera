# ADR-0190: `integrate`'s visitor reads tiles exactly as Go's does, by replaying reads made up front

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity agent
- **Upstream reference:** `storage/internal/integrate.go` (`treeBuilder.integrate`, `tileReadCache.Get`/`Prewarm`, `tileWriteCache.Visitor`, `populatedTile.Set`), `merkle/compact/range.go` (`VisitFn`, `Append`, `AppendRange`)

## Context

`tileWriteCache.Visitor` calls `getTile` — `t.readCache.Get` — the first time it touches a tile
that may already exist:

```go
if iSize := minImpliedTreeSize(tileID); iSize <= tc.treeSize {
	tile, err = tc.getTile(ctx, tileID, tc.treeSize)
	if err != nil {
		tc.err = append(tc.err, err)
		return
	}
}
```

On a cache miss `Get` calls `getTiles([]TileID{tileID}, treeSize)`, blocking the goroutine inside
compact.Range's synchronous callback. Upstream's comment on that branch names the case it exists
for: a tile that exists "due to an earlier crash during integration". `compact.VisitFn` is
synchronous in this port (as in Go), and a JavaScript callback cannot block on I/O.

ADR-0052 resolved this with a cache-only `peek`, on the stated invariant that every tile the
visitor can need was already fetched by `newRange`'s `Prewarm`. The invariant is false. Go's
`getTiles` call log for 0 → 255 → 256 → 257 → 557 is

```
0 -> 255      getTiles([]) ; getTiles([{0 0}] @0)
255 -> 256    getTiles([{0 0}] @255) ; getTiles([{1 0}] @255)
256 -> 257    getTiles([{1 0}] @256) ; getTiles([{0 1}] @256)
257 -> 557    getTiles([{1 0} {0 1}] @257)
```

and the port made only the first call of each pair. The second calls are the visitor's: tiles
whose `minImpliedTreeSize` is within the tree but which hold no node of the pre-integration
compact range (an empty-at-that-level tile, keyed as "full" because `PartialTileSize` returns 0 for
both). Usually such a read finds nothing, which is why the golden fixtures agreed; but a tile left
by a crashed integration was silently started afresh by the port, where Go loads it and overlays
the new nodes on it, and a storage `getTiles` saw a different call sequence.

## Decision

`integrate` performs, before each synchronous pass, every `tileReadCache.get` call Go's visitor
would make during that pass, and the visitor's `getTile` replays their outcomes in order.

- `replayedTileReads` records the nodes a pass will visit by running the same compact-range
  operation on a structural copy: a `RangeFactory` whose hash returns a placeholder, a
  `newEmptyRange(fromSize)` receiving one placeholder per leaf (for the `Append` loop), and a
  `newRange(0, fromSize, placeholders)` receiving that copy (for `AppendRange`). Which nodes
  `compact.Range` visits depends only on the ranges' bounds, never on hash values, so the
  recorded sequence is the real one.
- It then replays the recorded visits through a scratch `tileWriteCache` (the real class, so the
  `tc.m` and `minImpliedTreeSize` logic is not duplicated). When a visit asks for a read not yet
  made, the scratch `getTile` records the request and throws, which the visitor treats as a failed
  read; the read is then made with `readCache.get` and the same visit replayed with its outcome.
  So reads happen in the order, with the arguments and the caching Go's do, and a failed read is
  retried on each later visit to the same tile, as in Go (whose visitor leaves `tc.m` unset after
  an error), each failure joining `tc.err`.
- The two passes are prefetched separately, before the `Append` loop and before `AppendRange`, so
  that an error after the first pass stops integration before the second pass's reads, as Go does.
- The real visitor's `getTile` hands back each outcome in turn (the cached `populatedTile` itself,
  shared and mutated as Go shares it) or rethrows its error. If the real pass ever asks for a
  read that was not planned it throws `panicError`, which can only mean the two passes disagree.
- `panicError` marks the places Go panics — `populatedTile.Set` on a 257th leaf, `t[0]` of an
  empty `getTiles` result in `Get`, `tileIDs[i]` past the end in `Prewarm` — and every
  error-wrapping site in the file rethrows it unchanged, as a Go panic unwinds past them.
  `Prewarm` still tolerates `getTiles` returning fewer tiles than asked for, as Go does.

Verified against Go at the pinned commit: the call log above, a 341-integration sequence
crossing the level-2 boundary (691 lines, byte-identical after sorting each `Prewarm` call's IDs,
which Go draws from a map), a run where every read of one tile fails (511 calls and 510 joined
errors in both), and the crash-recovery case (same calls, root and 256-node tile).

## Consequences

- Each integration runs the compact-range appends twice: once structurally, once for real. The
  structural pass does no hashing; `TestIntegrate` and the fixture suites run in the same time as
  before.
- A failing tile read now costs one replay of the visits recorded so far per failure; failures
  are the rare path, and their count is Go's.
- `getPopulatedTileFunc` stays synchronous and throws instead of returning an error; `peek` is
  gone. ADR-0052's Decision no longer describes the code.
- Error text from a panic site is Go's panic message, not wrapped (`Weird node ID: {0 256}`,
  `runtime error: index out of range [0] with length 0`).

## Alternatives considered

- **Keep ADR-0052's `peek`.** Rejected: its invariant is false, and the cases where it differs
  are the crash-recovery case upstream's comment calls out and the `getTiles` call sequence.
- **Make `VisitFn` asynchronous.** Rejected for the reasons ADR-0052 gives: `compact.Range` is
  shared with `client` and `fsck`, and an awaited visitor changes every caller.
- **Compute the visited nodes arithmetically** (the nodes whose right edge falls in
  `(fromSize, newSize]`) instead of replaying `compact.Range`. Rejected: it reimplements the merge
  order, and the order of first touches decides the order of reads.
- **Simulate the visitor's `tc.m` logic in a separate loop.** Rejected in favour of replaying
  through a scratch `tileWriteCache`: one copy of the logic, so the plan cannot drift from what
  the real visitor does.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
