# ADR-0050: `TileID`/`compact.NodeID`-keyed maps become string-keyed maps; anonymous Go func types get names

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** storage-internal contributor
- **Upstream reference:** `storage/internal/integrate.go`, `storage/internal/tileid.go`

## Context

Go structs with comparable fields are valid map keys, and `storage/internal/integrate.go`
leans on this throughout:

```go
toFetch := make(map[TileID]struct{})
type tileWriteCache struct {
	m map[TileID]*populatedTile
	...
}
type populatedTile struct {
	inner map[compact.NodeID][]byte
	...
}
func Integrate(...) (newSize uint64, rootHash []byte, tiles map[TileID]*api.HashTile, err error)
```

`TileID{Level: 0, Index: 0}` and a second, distinct `TileID{Level: 0, Index: 0}` value compare
equal as map keys, because Go compares structs field-by-field. A JavaScript `Map` compares object
keys by reference (`SameValueZero`), so `new TileID(0n, 0n)` and a second `new TileID(0n, 0n)`
are distinct keys even though they carry the same (level, index) — the exact case this port hits
constantly, since a fresh `TileID` is constructed at every node visited.

Separately, four call sites in this file share one anonymous func type:

```go
func Integrate(ctx context.Context, getTiles func(ctx context.Context, tileIDs []TileID, treeSize uint64) ([]*api.HashTile, error), fromSize uint64, leafHashes [][]byte) (...)
func newTreeBuilder(getTiles func(ctx context.Context, tileIDs []TileID, treeSize uint64) ([]*api.HashTile, error)) *treeBuilder
type tileReadCache struct {
	getTiles func(ctx context.Context, tileIDs []TileID, treeSize uint64) ([]*api.HashTile, error)
}
func newTileReadCache(getTiles func(ctx context.Context, tileIDs []TileID, treeSize uint64) ([]*api.HashTile, error)) tileReadCache
```

Go tolerates repeating a structural type four times because structural types compose for free.
TypeScript does too, but repeating a five-parameter arrow type four times invites the signatures
to drift out of sync as the file is edited.

## Decision

**`tileIDKey(id: TileID): string`** (`src/storage/internal/tileid.ts`) renders `TileID` as
`` `${level}/${index}` ``. Every place Go uses `TileID` as a map key, this port uses a
`Map<string, …>` keyed by `tileIDKey`. Digits cannot contain `/`, so distinct (level, index)
pairs never collide (pinned directly in `tileid_test.ts`).

Where the *value* needs to recover the `TileID` it was stored under (`tiles()`'s return value,
consumed by future storage drivers that need both the address and the bytes to compute a storage
path), the map's value carries both: `Map<string, { id: TileID; tile: HashTile }>`, rather than
asking every caller to parse `tileIDKey`'s string back apart.

The same problem recurs one level down: `populatedTile.inner` is `map[compact.NodeID][]byte`.
`compact.NodeID` (`src/vendor/merkle/compact/nodes.ts`, Wave 1, already landed) has no exported
key-rendering helper, and adding one to that already-reviewed file is out of scope for this work
package. `nodeIDKey(id: NodeID): string` is therefore a small, module-private function local to
`integrate.ts` — `populatedTile.inner` is itself private, so nothing outside this file needs it.

**`GetTilesFunc`** (`src/storage/internal/integrate.ts`) names the four-times-repeated anonymous
Go func type. It is exported for readability at the boundary future storage drivers implement
against, not because Go names it — Go's version is genuinely anonymous. `getPopulatedTileFunc`
keeps its Go name (already a named, if unexported, type in Go) and is addressed separately in
ADR-0052, which also changes its signature.

## Consequences

- `Map<string, T>` instead of a hypothetical `Map<TileID, T>` is one extra function call
  (`tileIDKey(id)`) at every lookup site. Accepted: the alternative — interning `TileID` instances
  so equal (level, index) pairs share one object, making reference equality coincide with value
  equality — trades an explicit, auditable string key for a hidden, unbounded, module-global
  cache, which is worse for a donated library.
- `GetTilesFunc` and `tileIDKey`/`nodeIDKey` are additive surface with no Go counterpart. Only
  `GetTilesFunc` is exported package-wide; `tileIDKey` is exported from `tileid.ts` (needed by
  `integrate_test.ts` and `integrate_fixtures_test.ts`) but not re-exported from any package
  barrel, so neither reaches the published API surface described in `package.json`'s `exports` map.
- A future storage driver (Wave 4) that wants to reproduce Go's literal `map[TileID]*api.HashTile`
  shape can still do so trivially from `IntegrateResult.tiles`'s `{id, tile}` pairs; nothing here
  forecloses that.

## Alternatives considered

- **Interned/flyweight `TileID`, `Map<TileID, T>` directly.** Rejected in Consequences above.
- **Plain object (`Record<string, T>`) instead of `Map`.** Rejected: `Map` preserves insertion
  order predictably across engines and has an unambiguous `.size`/`.delete`, both of which
  `tiles()`'s test assertions rely on; a plain object risks prototype-pollution-shaped footguns
  for keys an adversarial tile index could produce (unlikely here, but `Map` costs nothing extra).
- **Leave the anonymous func types anonymous, repeated four times.** Rejected: the four
  repetitions already drifted once during development (a missed `signal?` parameter on one of the
  four), which is exactly the failure mode a shared name prevents.

## Review

- **Reviewer:** Storage-Internal Reviewer
- **Verdict:** approved
- **Notes:** Diffed against `storage/internal/integrate.go` and `tileid.go` line by line.
  Confirmed every Go `map[TileID]…` / `map[compact.NodeID][]byte` use site is now a
  string-keyed `Map` (`toFetch`, `tileWriteCache.m`/`ids`, `populatedTile.inner`, and
  `IntegrateResult.tiles`). Verified `tileIDKey` and the file-local `nodeIDKey` are
  injective: both fields render as decimal digits (bigint has no exponential form; NodeID's
  `level` is a small `number`), joined by `/`, which cannot appear in a decimal string — so
  the `"1/23"` vs `"12/3"` class of collision is impossible. `tileid_test.ts` pins the
  boundary case and MaxUint64 directly. `GetTilesFunc` faithfully names the func type Go
  repeats anonymously at four sites; the added `signal?` trailing param matches ADR-0004.
  Only `GetTilesFunc`/`tileIDKey` are exported (test reachability), neither via a barrel.
