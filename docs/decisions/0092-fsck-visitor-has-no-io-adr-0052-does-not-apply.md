# ADR-0092: `fsckTree.visit` needs no synchronous-visitor-vs-async-I/O workaround — ADR-0052 does not apply here

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** fsck agent
- **Upstream reference:** `fsck/fsck.go` (`fsckTree.visit`), `storage/internal/integrate.go` (`tileWriteCache.Visitor`, for contrast)

## Context

The mission brief for this work package specifically calls out
`docs/decisions/0052-tilewritecache-visitor-is-synchronous.md` as required reading before
writing `fsckTree.visit`, because both files hand a `compact.VisitFn` — a synchronous
callback, `(id: NodeID, hash: Uint8Array) => void`, with no `Promise` return — to
`compact.Range.append`/`.appendRange`/`.getRootHash`. ADR-0052 documents a real tension in
`storage/internal`: `tileWriteCache.Visitor`'s callback sometimes needs to *read* a tile
that might not be in memory yet, which is genuinely I/O, and a synchronous callback cannot
`await` that read.

This ADR records, explicitly, why that specific tension **does not exist** for
`fsckTree.visit`, so a reviewer comparing the two files does not need to independently
re-derive the same conclusion, and so the omission of any prewarm/cache-only-fallback
machinery here is a documented decision rather than an oversight.

## Analysis

`tileWriteCache.Visitor`'s callback (`integrate.ts`'s `visitor()`), on a cache miss, calls
`this.getTile(tileID, this.treeSize)` — a **read** of a tile that may not yet be resident,
falling back to storage. That read is what ADR-0052 had to reason about (and ultimately
resolved by proving the read is always a cache hit in practice, given `newRange`'s
prewarm).

`fsckTree.visit` (`fsck.ts`) does no such thing. Walking its body:

1. Early-return if `id.level % TileHeight !== 0` — pure arithmetic, no I/O.
2. Look up (or create) an in-memory `pendingTileEntry` in `this.pendingTiles` — a plain
   `Map` read/write, never falls back to any external source. Unlike
   `tileWriteCache.Visitor`, there is no "this tile might already exist in storage, go
   fetch it" fallback at all: `visit` always starts a brand-new, empty `HashTile` for a key
   it has not seen before, because fsck is *rebuilding* the tree from scratch as it reads
   the log's entries — it never needs to *merge into* a partially-known tile, only
   *accumulate* the current in-progress one.
3. Push the newly-derived leaf hash onto that in-memory tile's `nodes` array.
4. If the tile just became full, `marshalText()` it (pure, synchronous, no I/O — see
   `api/state.ts`) and `push` it onto `expectedResources` (`ResourceQueue.push`, itself
   synchronous by construction — see `docs/decisions/0091-fsck-translation-choices.md`
   §1).

Every one of those four steps is synchronous, in-memory bookkeeping. `visit` never reads
anything from the `Fetcher` — reading and comparing the log's *actual* on-disk tile bytes
against what `visit` derived is `resourceCheckWorker`'s job, and that is already `async`,
running independently of `visit`, consuming `ResourceQueue.pull()` as fast as it can. The
architecture fsck uses is precisely "one synchronous producer feeding a queue, N
asynchronous consumers draining it" — no code path anywhere requires the *producer* itself
to await I/O mid-callback.

The mission brief's own hint anticipated this: "fsck may have simpler needs since it
processes bundles in a fixed known order" — the order is fixed because `Check`'s bundle
loop is strictly sequential (`for` over `client.EntryBundles`, one bundle appended at a
time, in log order), so `visit` only ever needs to know about hashes it has *already been
given directly as an argument*, never a hash it would have to go fetch.

## Decision

No prewarm, no cache-only `peek`-style fallback, and no restructuring of `visit` beyond a
straightforward line-for-line port is needed or added. `fsckTree.visit` is ported as an
ordinary synchronous method (rendered as an arrow-function class field for auto-binding —
see ADR-0091 §6's neighbouring discussion in `fsck.ts` itself), satisfying `compact.VisitFn`
exactly as landed and reviewed in Wave 1, with no changes to that shared interface.

## Consequences

- None beyond the documentation value: this ADR exists so that "why doesn't fsck need the
  ADR-0052 treatment" has a citable answer instead of requiring a fresh read of both files
  every time a reviewer asks the question.

## Alternatives considered

- **Apply the ADR-0052 pattern defensively anyway, on the theory that a future change to
  `visit` might introduce a read.** Rejected: speculative machinery for a need that does
  not exist today is exactly the kind of invented API `docs/REVIEW-PROTOCOL.md` and
  AGENTS.md caution against ("no invention"). If a future change to `fsck.go` upstream adds
  a read to `visit`, that change will need its own translation decision at that time, and
  this ADR will need revisiting — noted here explicitly rather than pre-empted.

## Review

- **Reviewer:** Fsck Reviewer
- **Verdict:** approved
- **Notes:** Verified against `fsck/fsck.go`'s `visit` (read in full) and, for contrast,
  `src/storage/internal/integrate.ts`'s `tileWriteCache` visitor. The ADR's central claim
  holds: `fsckTree.visit` does no I/O. Walking its body — level-parity early-return (pure
  arithmetic), a plain `Map` get-or-create on `pendingTiles` with *no* fallback to any
  `Fetcher`, an in-memory `nodes.push`, and on a full tile a synchronous `marshalText()` +
  `expectedResources.push` — confirms every step is in-memory bookkeeping. Crucially, unlike
  `integrate.ts`'s visitor (which on a cache miss calls `getTile`/`peek` on a read-through
  cache backed by `getTiles`, the exact read ADR-0052 had to reason about via prewarm),
  `visit` *never* merges into a pre-existing tile: it always starts a fresh empty `HashTile`
  for an unseen key, because fsck rebuilds the tree from scratch in strict log order (the
  `check()` bundle loop is sequential), so it only ever handles hashes handed to it directly
  as arguments. No read-through access is needed anywhere in `fsck`, so ADR-0052's
  synchronous-visitor-vs-async-I/O tension genuinely does not arise here. The
  `HashTile.marshalText`-never-throws premise is also correct (`api/state.ts` dropped the
  error return; its only Go source was `bytes.Buffer.Write`, which never fails).
