# ADR-0003: Represent Go `uint64` as `bigint`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** lead (human-directed)
- **Upstream reference:** `api/layout/paths.go`, `api/layout/tile.go`, `storage/internal/integrate.go`, `client/client.go`

## Context

Tessera counts everything in `uint64`: tree sizes, leaf indices, tile indices, node indices. A
JavaScript `number` is an IEEE-754 double and represents integers exactly only up to 2^53 - 1.

This is not a theoretical concern. `layout.ParseTileIndexPartial` contains an explicit overflow
guard that upstream tests exercise directly:

```go
if i > (math.MaxUint64-n)/1000 {
    return 0, 0, fmt.Errorf("failed to parse tile index")
}
```

`paths_test.go` feeds it inputs near `MaxUint64` and asserts the error. With `number` we cannot
express `MaxUint64`, cannot reproduce that boundary, and would have to delete or weaken the test —
which AGENTS.md §4 forbids and which would be exactly the kind of quiet infidelity a
transparency-dev reviewer would find first.

Beyond the tests: a transparency log's whole value proposition is that its arithmetic is exactly
right at the boundaries. Silently truncating an index is the worst class of bug this codebase can
have, because it produces a valid-looking proof for the wrong leaf.

## Decision

Every value that is `uint64` in the Go source is `bigint` in TypeScript. Literals are written with
the `n` suffix (`0n`, `256n`). Division uses `/` on bigints (already floor division for
non-negatives, matching Go's integer division), and `%` matches Go's `%` for non-negative operands.

Values that are `uint8`, `uint`, `int`, or `int64` in Go stay `number`:

- `uint8` is used for partial tile sizes (< 256) and is bounded by the tlog-tiles spec.
- `uint` is used for offsets *within* a bundle (< 256).
- `int` is used for slice lengths and loop counters.

Mixed arithmetic is a TypeScript type error, which is a feature: it forces every conversion to be
written out, and each one is a place where the Go source made a deliberate narrowing.

Where an upstream signature mixes them — e.g. `PartialTileSize(level, index, logSize uint64) uint8`
— the port mirrors it exactly: `partialTileSize(level: bigint, index: bigint, logSize: bigint):
number`.

## Consequences

- Ergonomics cost: callers must write `1n` not `1`, and cannot mix. Accepted.
- Performance: bigint arithmetic is slower than double arithmetic. It is not on any hot path that
  matters — the hot path is SHA-256, which is bytes, not counters. If profiling later proves
  otherwise, that is a new ADR with evidence attached, not a reflex.
- JSON: `bigint` does not survive `JSON.stringify`. Fixtures encode `uint64` as decimal **strings**
  (AGENTS.md §5), and any adapter that persists these values must do the same. IndexedDB stores
  `bigint` natively via structured clone; Firestore does not, so the Firestore adapter encodes as
  string.
- Donation: idiomatic modern TypeScript for 64-bit quantities. Not a barrier.

## Alternatives considered

- **`number` everywhere.** Simpler and faster, and no real log will reach 2^53 entries. Rejected:
  it forces deleting upstream boundary tests, and "no real log will reach it" is an assumption a
  transparency log should not be built on. Precision loss here is silent and produces wrong proofs.
- **A branded `Uint64` wrapper class.** Type-safe and could carry overflow checks. Rejected: it
  makes every expression a method call, which destroys the line-by-line correspondence with the Go
  source that is this port's main reviewability asset.
- **`number` for the common path with `bigint` only in the parser.** Rejected: two representations
  of the same quantity is how truncation bugs get in.

## Review

- **Reviewer:** Layout Reviewer (2026-08-19)
- **Verdict:** approved
- **Notes:** Verified the concrete case this ADR exists to protect. `ParseTileIndexPartial`'s
  guard `if i > (math.MaxUint64-n)/1000` (paths.go:205) ports to `if (i > (MaxUint64 - n) / 1000n)`
  (paths.ts:237) with `MaxUint64 = 0xffffffffffffffffn` (bits.ts:26). Both use floor division on the
  same constant, so the accept/reject boundary is bit-identical. The `layout_parse` fixture — emitted
  by Go — exercises it exactly at the edge: index `018446744073709551615` (= MaxUint64) is accepted,
  `018446744073709551616` (= MaxUint64+1) is rejected, and `paths_fixtures_test.ts`'s "rejects indices
  that would overflow uint64" case filters these out by value so the boundary cannot pass vacuously.
  Also confirmed the mixed-width mirroring the ADR promises: `partialTileSize(level, index, logSize:
  bigint): number` and `nodeCoordsToTileAddress(...): {tileLevel: bigint, tileIndex: bigint,
  nodeLevel: number, nodeIndex: bigint}` match Go's `(uint64,uint64,uint,uint64)` element-for-element,
  and the narrowing `Number(...)` casts land only on values bounded < 256 or < 8 by construction. No
  `Number(...)` truncation of a uint64 quantity found anywhere in scope.
