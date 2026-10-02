# ADR-0030: Export the tlog-tiles constants as `number`, with module-local `bigint` companions

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** layout agent
- **Upstream reference:** `api/layout/tile.go`, `api/layout/paths.go`

## Context

`api/layout/tile.go` declares the three tlog-tiles spec constants in a single untyped block:

```go
const (
	TileHeight = 8
	TileWidth = 1 << TileHeight
	EntryBundleWidth = TileWidth
)
```

Go constants declared without a type are *untyped*, so each use site converts them to whatever type
the surrounding expression needs. Upstream relies on this in both directions within the same
package:

- `uint64` contexts — `logSize >> (level * TileHeight)`, `sizeAtLevel / TileWidth`,
  `seq / EntryBundleWidth`, and `w64 >= TileWidth` in `ParseTileIndexPartial`, where `w64` comes
  straight out of `strconv.ParseUint(..., 64)` and can be as large as `MaxUint64`.
- `uint`/`int` contexts — `RangeInfo{Index: idx, N: EntryBundleWidth}` and
  `ri.N = uint(EntryBundleWidth) - ri.First`, where `RangeInfo.N` is a `uint`.

TypeScript has no untyped numeric constant. A `const` is either `number` or `bigint`, and mixing the
two in one expression is a type error (deliberately so — ADR-0003). So one exported representation
has to be chosen, and the other use sites have to convert.

## Decision

The three constants are exported as **`number`**:

```ts
export const TileHeight = 8;
export const TileWidth = 1 << TileHeight;
export const EntryBundleWidth = TileWidth;
```

Each module that needs them in `uint64` arithmetic derives an unexported `bigint` companion once, at
module scope, named with a `64` suffix:

```ts
const tileHeight64 = BigInt(TileHeight);
const tileWidth64 = BigInt(TileWidth);
```

`tile.ts` and `paths.ts` each declare the companions they use. The companions are **not** exported
and are **not** re-exported by `api/layout/index.ts`: they are an artefact of the port, not part of
the API, and a second public spelling of the same constant is exactly how a `number`/`bigint`
mismatch gets into a caller.

## Consequences

- The public constants are `number`, which is what almost every caller wants: they are compared
  against array lengths (`bundle.entries.length === EntryBundleWidth`), used as loop bounds, and
  formatted into messages. A `bigint` there would force `Number(...)` at nearly every consumer.
- Two extra lines per module that does uint64 tile arithmetic. `BigInt()` is called once at module
  load, not per operation, so there is no per-call cost.
- A future porter adding uint64 arithmetic in a new module must remember to add the companion rather
  than reaching for `BigInt(TileWidth)` inline. The naming convention (`…64`) makes the existing ones
  easy to find and copy.
- These constants are fixed by the tlog-tiles spec at 8 and 256. They cannot grow to a value a
  `number` cannot hold, so nothing here can be lost to precision — unlike the log sizes and indices
  they are used *with*, which is what ADR-0003 is about.

## Alternatives considered

- **Export them as `bigint`.** Faithful to the dominant use inside `api/layout` itself. Rejected:
  it pushes `Number(...)` onto every consumer that compares them against a length or an offset, and
  those conversions are the ones most likely to be written carelessly, because they look trivial.
  It also makes `TileHeight` — a level count, never a `uint64` anywhere in upstream — a `bigint`
  for no reason.
- **Export both, e.g. `TileWidth` and `TileWidth64`.** Rejected: it invents public API upstream does
  not have, and it doubles the chance a caller picks the wrong one. The companions exist, but they
  stay private.
- **A branded constant type that coerces on use.** Rejected for the same reason ADR-0003 rejected a
  `Uint64` wrapper: it turns straight-line arithmetic into method calls and destroys the line-by-line
  correspondence with the Go source.

## Review

- **Reviewer:** Layout Reviewer (2026-08-19)
- **Verdict:** approved
- **Notes:** Diffed tile.go/tile.ts and paths.go/paths.ts. `TileHeight`/`TileWidth`/`EntryBundleWidth`
  are exported `number`; the `…64` bigint companions are module-local and not re-exported by
  `index.ts` (confirmed the barrel exports only the public surface). Checked each use site the ADR
  cites: `logSize >> (level * tileHeight64)`, `sizeAtLevel / tileWidth64`, `seq / entryBundleWidth64`,
  and `w64 >= tileWidth64` all use the bigint companion, while the `RangeInfo` construction and
  length/offset arithmetic use the `number` form — matching Go's untyped-constant behaviour in both
  directions. The constants are spec-fixed at 8/256 and cannot exceed `number` precision, so nothing
  is lost. Faithful.
