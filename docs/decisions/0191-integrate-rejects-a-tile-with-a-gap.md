# ADR-0191: `tileWriteCache.tiles()` rejects a tile with an unset leaf, where Go writes it short

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity contributor
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

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
