# ADR-0191: `tileWriteCache.tiles()` rejects a tile with an unset leaf, where Go writes it short

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity agent
- **Upstream reference:** `storage/internal/integrate.go` (`tileWriteCache.Tiles`, `populatedTile.Set`), `api/state.go` (`HashTile.MarshalText`)

## Context

`populatedTile.Set` grows `leaves` with `nil` entries up to the index it sets, and `Tiles()` copies
`leaves` into `api.HashTile{Nodes: t.leaves}` as is. A `nil` leaf then marshals to zero bytes
(`bytes.Buffer.Write(nil)`), so a tile with a gap is written shorter than its node count and every
hash after the gap lands at the wrong offset.

`HashTile.nodes` is `Uint8Array[]` in this port; it has no "nil element" to carry a gap.

## Decision

`tiles()` throws `populatedTile has an unset leaf at index <i> in tile <key>` for a tile whose
`leaves` has a gap, instead of producing a short tile. No well-formed integration reaches it:
`compact.Range` visits a tile's leaf indices in order from its first unset slot, and a tile read
from storage is rebuilt contiguously by `newPopulatedTile`.

## Consequences

- A storage bug that produced a gap fails loudly in `integrate` rather than writing a corrupt
  tile. Go writes the short tile, and its storage driver's later checks (or a reader) find it.
- The divergence is unobservable for every input upstream's code paths can produce.

## Alternatives considered

- **Type `HashTile.nodes` as `(Uint8Array | undefined)[]`** to carry the gap and let
  `marshalText` skip it as Go does. Rejected: it widens a public type for every caller to
  reproduce a corruption.
- **Fill the gap with an empty array.** Rejected: that is Go's short tile with extra steps.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `populatedTile.Set` pads `leaves` with nil up to the index, `Tiles()` copies them into `HashTile{Nodes: t.leaves}`, and `HashTile.MarshalText` does `Buffer.Write(n)` per node, so a nil leaf writes nothing. `compact.Range.AppendRange` visits only nodes of level 1 and above (`appendImpl` reports `NodeID(h+1, ...)`); level-0 visits come only from `Append`, in index order, so no well-formed integration leaves a gap, as the ADR says.
  - TS: `tileWriteCache.tiles()` throws `populatedTile has an unset leaf at index <i> in tile <key>`. Probe: visiting leaf 5 of an empty tile then calling `tiles()` throws `... index 0 in tile 0/0`; three contiguous leaves are fine.
  - Non-blocking: no test in the repository pins this throw (grep for 'unset leaf' finds only `integrate.ts`). A three-line test using the exported `newTileWriteCache` would do.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
