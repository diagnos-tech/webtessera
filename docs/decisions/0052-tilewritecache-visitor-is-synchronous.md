# ADR-0052: `tileWriteCache`'s `getTile` fallback is synchronous, backed by a cache-only `peek`

- **Status:** superseded by [ADR-0190](0190-integrate-visitor-tile-reads-are-replayed.md)
- **Date:** 2026-08-19
- **Author:** storage-internal agent
- **Upstream reference:** `storage/internal/integrate.go` (`tileWriteCache.Visitor`, `tileReadCache.Get`, `treeBuilder.integrate`, `treeBuilder.newRange`), `merkle/compact/range.go` (`VisitFn`)

## Context

This is the highest-risk decision in this work package, and it exists because of a real tension
between how Go and TypeScript can shape a callback.

`compact.VisitFn`, already landed and reviewed in Wave 1
(`src/vendor/merkle/compact/range.ts`), is synchronous:

```ts
export type VisitFn = (id: NodeID, hash: Uint8Array) => void;
```

Go's original is the same shape — `func(id NodeID, hash []byte)`, no error return — because Go's
goroutines can block on I/O *inside* a synchronous-looking callback; the runtime schedules another
goroutine while this one waits. `tileWriteCache.Visitor` exploits exactly that:

```go
func (tc *tileWriteCache) Visitor(ctx context.Context) compact.VisitFn {
	return func(id compact.NodeID, hash []byte) {
		tileLevel, tileIndex, nodeLevel, nodeIndex := layout.NodeCoordsToTileAddress(uint64(id.Level), uint64(id.Index))
		tileID := TileID{Level: tileLevel, Index: tileIndex}
		tile := tc.m[tileID]
		if tile == nil {
			var err error
			if iSize := minImpliedTreeSize(tileID); iSize <= tc.treeSize {
				tile, err = tc.getTile(ctx, tileID, tc.treeSize)   // <-- can genuinely fetch
				...
```

`tc.getTile` is `t.readCache.Get`, which does a real, possibly-network-bound fetch on a cache
miss:

```go
func (r *tileReadCache) Get(ctx context.Context, tileID TileID, treeSize uint64) (*populatedTile, error) {
	k := layout.TilePath(...)
	e, ok := r.entries[k]
	if !ok {
		t, err := r.getTiles(ctx, []TileID{tileID}, treeSize)   // <-- real I/O
		...
```

A JavaScript function with the type `(id: NodeID, hash: Uint8Array) => void` cannot `await`
anything — there is no way to suspend a synchronous callback and resume it later without changing
its signature to return a `Promise`, which `compact.Range.append`/`.appendRange` (Wave 1, already
reviewed, not owned by this work package) do not `await` when calling the visitor.

## The invariant that resolves it

`integrate()`'s call sequence is:

```go
baseRange, err := t.newRange(ctx, fromSize)      // (1) fully warms t.readCache for fromSize
...
tc := newTileWriteCache(fromSize, t.readCache.Get)  // (2) reuses the SAME warm cache
visitor := tc.Visitor(ctx)
for _, e := range leafHashes {
	newRange.Append(e, visitor)                  // (3) synchronous, may call tc.getTile
}
...
baseRange.AppendRange(newRange, visitor)          // (4) same visitor, same constraint
```

Step (1), `newRange(fromSize)`, calls `t.readCache.Prewarm` with the tiles implied by
`compact.RangeNodes(0, fromSize, nil)` — the minimal set of perfect-subtree root nodes covering
`[0, fromSize)`. This is not incidental; it is the *entire reason* a compact range is enough to
resume integration without re-hashing from scratch. Steps (3) and (4)'s `tc.getTile` fallback
only fires when `minImpliedTreeSize(tileID) <= tc.treeSize` — i.e. `tc.treeSize == fromSize`,
the *same* size `newRange` just prewarmed for.

A tile groups every Merkle node at its levels and index range into one unit, addressed by
`layout.TilePath(level, index, layout.PartialTileSize(level, index, treeSize))` — a key that
depends only on `(level, index, treeSize)`, not on *which* node within the tile triggered the
fetch. So: any tile the Visitor's fallback could need at `treeSize = fromSize` shares its cache
key with a tile that `newRange(fromSize)`'s `Prewarm` already fetched, because both derive the
same key from the same `(level, index, treeSize)`. By the time the Visitor runs, `t.readCache`'s
`entries` map already contains every entry `tc.getTile` could possibly be asked for — the "fetch"
at Visitor time is *always* a cache hit in Go's own real (non-test) call path.

(`TestTileVisit` in `integrate_test.go` constructs a `tileWriteCache` directly, without going
through `newRange`'s prewarm, and asserts that a genuine cache miss falls back to `nil, nil` →
"treat as brand new tile" rather than erroring. That confirms the *contract* `getTile` must
satisfy — "not found" is a valid, non-error outcome — which this port's redesign preserves.)

## Decision

`getPopulatedTileFunc` becomes a plain synchronous function with no error channel:

```ts
type getPopulatedTileFunc = (tileID: TileID, treeSize: bigint) => populatedTile | undefined;
```

`tileReadCache` gains a new method, `peek`, with no Go counterpart, that reads only from the
already-populated `entries` cache and never fetches:

```ts
peek(tileID: TileID, treeSize: bigint): populatedTile | undefined {
	const k = tilePath(tileID.level, tileID.index, partialTileSize(tileID.level, tileID.index, treeSize));
	return this.entries.get(k);
}
```

`integrate()` wires `tc.getTile` to `(tileID, treeSize) => this.readCache.peek(tileID, treeSize)`
instead of `readCache.get` (which stays async, and is still used by `newRange` itself, where an
`await` is available). `tileWriteCache.visitor()` stays synchronous end to end, satisfying
`compact.VisitFn`'s existing, Wave-1-owned signature without any change to that file.

The `tc.err`/`errors.Join` plumbing (`joinErrors`, see ADR-0057) is kept even though, given the
invariant above, `getTile` can no longer fail with a real I/O error in this port's own call path:
`tileWriteCache` is a general-purpose class parameterised by a caller-supplied `getTile`, exactly
as in Go, and a future caller's `getTile` implementation could still throw. The Visitor wraps the
call in try/catch and pushes any thrown value onto `tc.errs`, mirroring Go's
`if err != nil { tc.err = append(tc.err, err); return }` exactly — this path is defensive, not
dead code by construction, even though this work package's only caller (`integrate()`) never
triggers it.

## Consequences

- `getPopulatedTileFunc`'s signature diverges from Go's (`func(ctx, TileID, uint64) (*populatedTile, error)`
  vs. `(tileID: TileID, treeSize: bigint) => populatedTile | undefined`): no `ctx`, no thrown
  error from the "not found" case (there never was one — `nil, nil` was already Go's not-found
  contract), and no `async`. A reviewer diffing signatures will see this and needs this ADR.
- The invariant this relies on is a property of *this file's own* call graph
  (`integrate()` → `newRange(fromSize)` → prewarm → `tileWriteCache` reusing the same
  `tileReadCache` at the same `fromSize`), not a property `getPopulatedTileFunc`'s type enforces.
  A future change to `integrate()` that constructs a `tileWriteCache` with a `treeSize` different
  from what was prewarmed, or that reuses a `treeBuilder` across calls with a stale cache, would
  silently start returning `undefined` from `peek` for tiles that genuinely exist elsewhere,
  which `tileWriteCache.visitor()` would then treat as "brand new tile" — silently discarding
  real data instead of extending it. This is exactly the failure mode `AGENTS.md`'s "a bug here
  corrupts every log built on top of it silently" warning describes, which is why this ADR spells
  the invariant out in full rather than asserting it in one line, and why the verification below
  specifically targets it.
- No change to `src/vendor/merkle/compact/range.ts` (Wave 1, already reviewed) was needed or
  made. This was a hard constraint, not a preference: `VisitFn`'s signature is shared with the
  `client` and `fsck` work packages (both list `compact` as a dependency in
  the original work plan), so changing it here would be exactly the kind of
  cross-work-package interface break `docs/REVIEW-PROTOCOL.md` §3 says to escalate rather than do
  unilaterally.

## Verification

This is asserted, not just argued: `src/storage/internal/integrate_fixtures_test.ts` runs
`integrate()` starting from `fromSize > 0` in three ways, all against real Tessera-built fixtures
(`log_255.json` → `log_256.json` → `log_257.json`, the exact boundary the mission brief calls out
as "the interesting one"):

1. Pairwise: `integrate(255, [entry 255])` reproduces `log_256.json`'s tiles/root exactly, and
   `integrate(256, [entry 256])` reproduces `log_257.json`'s. Both cross a tile boundary where a
   pre-existing partial tile must be extended — precisely the path `getTile`'s fallback covers.
2. One entry at a time from `fromSize = 0` through both boundaries (257 sequential `integrate()`
   calls, each seeded only with the tiles the *previous* call actually returned) — the way a real
   storage driver calls this API — still reproduces `log_257.json` exactly.

If the synchronous-peek redesign were unsound — if `peek` ever needed data `newRange`'s prewarm
hadn't fetched — either test would silently fall back to "brand new tile" for what should have
been an extension of existing data, and the resulting tile bytes (and root hash) would not match
Go's. They match, byte for byte.

## Alternatives considered

- **Change `compact.VisitFn` to return `Promise<void>`, and make `Range.append`/`.appendRange`
  `await` it.** Rejected: this is a real, cross-cutting interface change to an already-reviewed
  Wave 1 file, needed by `client` and `fsck` too. Per `docs/REVIEW-PROTOCOL.md` §3, a defect (or
  design need) whose fix changes an interface other work packages depend on gets reported and
  sequenced, not changed unilaterally underneath them — and here it is not even a defect, since
  the synchronous contract is correct for every *other* caller of `VisitFn` in this codebase.
- **Do a comprehensive async pre-pass that fetches every tile the Visitor could possibly touch,
  simulating the merge twice.** Rejected: substantially more code, and it would have to
  re-implement (or import) enough of `compact.Range`'s internal merge-path logic to know in
  advance which nodes get visited — which the existing `newRange(fromSize)` prewarm already does
  correctly as a side effect of its own, simpler job. Reusing it is not just simpler, it is the
  thing that makes the invariant provable at all.
- **Keep `getTile` async and give `tileWriteCache.visitor()` a wrapper that does a blocking
  `Atomics.wait`-style spin.** Rejected outright: no such primitive exists on the main thread in a
  browser or in workerd, and even where it exists (Node with a worker thread) it would be a
  synchronous-looking function that is secretly extremely slow and fragile — worse than either
  alternative above.
- **Throw instead of returning `undefined` for "not found".** Rejected: `TestTileVisit` (ported
  verbatim in `integrate_test.ts`) exercises exactly this path with an empty backing store and
  asserts it succeeds by creating a fresh tile — "not found" is Go's documented, valid outcome for
  `getTile`, not an error condition to invent stricter handling for.

## Review

- **Reviewer:** Storage-Internal Reviewer (claude-opus-4-8)
- **Verdict:** approved — the decision is sound; one imprecision in the stated invariant, corrected below.
- **Notes:** I traced the full call graph against `storage/internal/integrate.go`,
  `merkle/compact/{range,nodes}.go`, and `api/layout/tile.go`, including a boundary-crossing
  case (fromSize=255 → 256), because this is the package's highest-risk decision.

  **The stated invariant is slightly too strong.** The ADR says any tile the Visitor's
  fallback "can need (`minImpliedTreeSize(tileID) <= fromSize`)" shares a cache key with a
  prewarmed tile. That is not literally true. Counterexample I verified by hand: at
  fromSize=255, `newRange(255)` prewarms only tile `{0,0}` (all 8 frontier nodes of
  `RangeNodes(0,255)` map to it). Adding leaf 255 makes the merge visit node `(8,0)`, which
  `nodeCoordsToTileAddress` maps to tile `{1,0}` with node `(0,0)`.
  `minImpliedTreeSize({1,0}) = 0 <= 255`, so the fallback **does** fire for a tile that was
  **not** prewarmed. So the fallback can be invoked for non-prewarmed tiles.

  **But the decision is nonetheless correct**, for a reason the ADR states informally but
  should state precisely: the fallback only needs to *preserve existing data* for tiles that
  genuinely exist in storage at fromSize, and every such tile is prewarmed. I proved this:
  the only tiles the Visitor extends-with-preservation are the rightmost (partial) tile at
  each tile-level L, and the rightmost tile at level L is partial **iff** the base-256 digit
  L of fromSize is nonzero **iff** a frontier node exists at some tree level in [8L, 8L+8)
  **iff** `RangeNodes(0,fromSize)` yields a node whose `tileIndex` is exactly
  `floor(fromSize / 2^(8(L+1)))` — the rightmost tile's index. Hence every partial border
  tile is prewarmed. Tiles the fallback fires for that were *not* prewarmed (like `{1,0}`@255)
  are always empty in storage, so Go's real `getTiles` returns nil → `newPopulatedTile(nil)` →
  fresh tile, which is byte-identical to this port's `peek` → `undefined` → fresh tile.
  There is therefore no code path where `peek` returns `undefined` for a tile Go would have
  fetched with real data. The synchronous peek is sound.

  This is not just argued: `integrate_test.ts`'s `TestIntegrate` resumes integration across
  **200,000 entries** (1000 chunks of 200), round-tripping tiles through a store between
  chunks and comparing every root against an independently-built `compact.Range`. That
  crosses level-0, level-1 **and** level-2 partial-tile extensions (200000 > 65536, so
  tile `{2,0}` is extended across chunks) — exactly the preservation path — and matches. The
  255→256→257 fixtures corroborate at the boundary the brief calls out. Recommend the author
  tighten the "The invariant that resolves it" paragraph to say "every tile with preservable
  data is prewarmed," rather than "every tile the fallback can need," but this is a
  documentation-precision fix, not a code change — the code and the decision are correct.

## Update (2026-10-02): superseded by ADR-0190

The invariant this ADR rests on is false, beyond the review's precision note above. The visitor's
`readCache.Get` also fetches tiles that hold no node of the pre-integration compact range but whose
`minImpliedTreeSize` is within the tree: Go's `getTiles` log for 0 → 255 → 256 → 257 has a second
call per step (`{0 0}@0`, `{1 0}@255`, `{0 1}@256`) that `peek` never made. Such a read usually finds
nothing, which is why the golden fixtures agreed; but a tile left behind by a crashed integration —
the case upstream's comment on that branch names — was started afresh by the port where Go loads and
extends it, and storage saw a different `getTiles` sequence. `peek` is removed; ADR-0190 describes the
replacement, which makes Go's reads in Go's order. The status line above is left for the lead to
update to "superseded by ADR-0190".

*Review of this update: pending.*
