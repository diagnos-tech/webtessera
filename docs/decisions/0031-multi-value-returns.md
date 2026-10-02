# ADR-0031: Go multi-value returns become named readonly result objects

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** layout agent
- **Upstream reference:** `api/layout/tile.go`, `api/layout/paths.go`, `internal/parse/parse.go`

## Context

Go returns several values positionally, and Tessera uses that freely. Three of the functions in this
work package do, and two of them mix integer widths in a way that makes the positions load-bearing:

```go
func NodeCoordsToTileAddress(treeLevel, treeIndex uint64) (uint64, uint64, uint, uint64)
func ParseTileLevelIndexPartial(level, index string) (uint64, uint64, uint8, error)
func ParseTileIndexPartial(index string) (uint64, uint8, error)
func CheckpointUnsafe(rawCp []byte) (string, uint64, []byte, error)
```

`NodeCoordsToTileAddress` is the sharpest case: four values, three of them integers, in the order
(tile level, tile index, node level, node index). Two adjacent `uint64`s in the middle mean that
transposing the second and fourth is a silent, type-clean bug that produces a valid-looking address
for the wrong node. Upstream's doc comment carries the meaning, and the callers name the values at
the call site:

```go
tileLevel, tileIndex, nodeLevel, nodeIndex := layout.NodeCoordsToTileAddress(treeLevel, treeIndex)
```

TypeScript has no positional multi-return and no `:=` naming at the call site. It has tuples, which
are positional and unnamed at the type level, and objects, which are named.

## Decision

Every Go function in this work package that returns more than one non-error value returns a **named
`readonly` object**, declared as an exported interface immediately above the function, with a
doc-comment on each field:

| Go | TypeScript | Fields |
| --- | --- | --- |
| `NodeCoordsToTileAddress` | `nodeCoordsToTileAddress(): TileAddress` | `tileLevel: bigint`, `tileIndex: bigint`, `nodeLevel: number`, `nodeIndex: bigint` |
| `ParseTileLevelIndexPartial` | `parseTileLevelIndexPartial(): TileLevelIndexPartial` | `level: bigint`, `index: bigint`, `width: number` |
| `ParseTileIndexPartial` | `parseTileIndexPartial(): TileIndexPartial` | `index: bigint`, `width: number` |
| `CheckpointUnsafe` | `checkpointUnsafe(): ParsedCheckpoint` | `origin: string`, `size: bigint`, `hash: Uint8Array` |

Field names are taken from the Go source itself wherever it names the values — `NodeCoordsToTileAddress`
uses exactly the local variable names from its body, and the parse functions use the nouns from their
doc comments ("returns the level, index and width"). The trailing `error` return is dropped, because
errors are thrown (ADR-0004).

The interface names are new: Go's return types are anonymous, so there is nothing upstream to mirror.
They are descriptive of the content (`TileAddress`) rather than of the mechanism (`…Result`), except
where the content has no better name.

`RangeInfo` is untouched — upstream already declares it as a struct, so it ports as an interface
under the ADR-0002 field mapping.

## Consequences

- Destructuring at the call site reads almost exactly like the Go:
  `const { tileLevel, tileIndex, nodeLevel, nodeIndex } = nodeCoordsToTileAddress(l, i);` — same
  names, same order, but now the compiler checks the names instead of the positions.
- Four interface names exist in the public API that have no upstream counterpart. A transparency-dev
  reviewer diffing exported symbols will see them and must be told why; that is what this ADR is for.
  They are additive: no upstream symbol is renamed or removed.
- Callers cannot ignore a value by position (Go's `_`). They simply do not destructure it, which is
  quieter and safer.
- The objects are `readonly`, so a caller cannot mutate a returned address and pass it on. Go returns
  copies of scalars and gets this for free.

## Alternatives considered

- **`readonly [bigint, bigint, number, bigint]` tuples.** Closest to Go's shape, and destructuring
  looks identical. Rejected: the type itself carries no names, so hovering a call site tells you
  nothing, and — the deciding point — swapping two same-typed elements type-checks. That is precisely
  the bug class this port must not make easy, and `NodeCoordsToTileAddress` has two `uint64`s in
  positions 2 and 4.
- **Out-parameters (a mutable object passed in).** Rejected: not idiomatic in either language, and it
  makes the function's effect invisible at the call site.
- **Splitting into several single-value functions.** Rejected as invention: it changes the API
  upstream specifies, and it would recompute shared intermediates.
- **A `Result`-style wrapper carrying the error too.** Rejected by ADR-0004, which settled that errors
  are thrown.

## Review

- **Reviewer:** Layout Reviewer (2026-08-19)
- **Verdict:** approved
- **Notes:** Confirmed all four functions against their Go signatures: `nodeCoordsToTileAddress →
  TileAddress`, `parseTileLevelIndexPartial → TileLevelIndexPartial`, `parseTileIndexPartial →
  TileIndexPartial`, `checkpointUnsafe → ParsedCheckpoint`. Field names, order and widths match the
  table exactly, the interfaces are `readonly`, and the trailing Go `error` return is dropped in
  favour of a throw (ADR-0004). The four interface names are genuinely additive — no upstream symbol
  renamed or removed — and the fixtures/tests destructure them by name (`const {tileLevel, tileIndex,
  nodeLevel, nodeIndex} = …`), which is the transposition-safety the ADR argues for. `RangeInfo` is
  left as a struct-mirroring interface, correctly. Agreed with rejecting tuples: `NodeCoordsToTile­
  Address`'s two adjacent uint64 returns are exactly where a positional swap would type-check silently.
