# ADR-0207: Reject values outside the uint64 domain at the exported uint64 entry points

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** hardening contributor
- **Upstream reference:** `merkle/compact/nodes.go`, `merkle/compact/range.go`, `merkle/proof/proof.go`, `merkle/proof/verify.go`, `formats/log/checkpoint.go`; extends ADR-0003 and ADR-0014

## Context

ADR-0003 maps Go's `uint64` to `bigint` and ADR-0014 writes out Go's wrapping arithmetic. Both assume the value
*is* a uint64. A `bigint` parameter also accepts negative numbers and numbers of 2^64 and above, which Go's type
system makes unrepresentable. The merkle fidelity audit (F1/F23) showed what such values do: `inclusion(0n,
2n**64n)` returns a proof with the wrong number of nodes, `decompose` returns masks wider than 64 bits,
`rangeNodes(0n, 2n**64n, [])` does not terminate, `new Checkpoint({ size: -1n }).marshal()` writes a negative
size, and `verifyInclusion` happily compares roots for an index of −1. None of it is reachable from correct
code, but these are exported functions of a library whose inputs often come from the network, and a guard that
cannot change any valid result is cheap.

## Decision

`src/internal/gostd/bits.ts` gains one guard:

```ts
export function assertUint64(value: bigint, name: string): void; // TypeError if not a bigint;
                                                                  // RangeError "<name> = <v> is outside the uint64 range [0, 2^64-1]"
```

It is called first, for every uint64 parameter, in: `rangeNodes`, `rangeSize`, the `NodeID` constructor (and
so `newNodeID`), `decompose`, `RangeFactory.newRange`, `RangeFactory.newEmptyRange`, `inclusion`, `consistency`,
`rootFromInclusionProof`, `verifyInclusion`, `verifyConsistency`, the `Checkpoint` constructor and
`Checkpoint.marshal` (whose `size` field is mutable). Each function's doc comment carries a port note.

Internal arithmetic is unchanged: it already wraps as Go's does (ADR-0014), and a value that passed the guard
cannot leave the domain except where Go's own arithmetic wraps.

## Consequences

- Every input Go could receive behaves exactly as before. The merkle differential harness against Go (bits,
  compact, range, proof, verify, testonly tree: ~190k cases, including `MaxUint64` boundaries) reports zero
  mismatches on every in-domain comparison after the change; the only remaining difference is
  `getMergePath`'s documented out-of-precondition case (ADR-0014), which no exported function reaches.
- Out-of-domain inputs now fail immediately with a `RangeError` that names the parameter, instead of
  producing nonsense or hanging.
- Constructing a `NodeID` costs one type check and two comparisons more. `TestGenRangeNodes`' 131k calls are not
  measurably slower.

## Alternatives considered

- **Leave it to the type system.** Rejected: TypeScript has no unsigned 64-bit type, and the values come from
  parsing as often as from code.
- **Truncate with `asUint64` instead of rejecting.** Rejected: silently wrapping a negative size into a huge
  one hides the caller's bug and is not what Go would have done with that caller's code (it would not compile).
- **Guard only the verifiers.** Rejected: the non-terminating case is in `rangeNodes`, and partial coverage is
  harder to reason about than "every exported uint64 parameter".

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - `assertUint64` (`gostd/bits.ts`) throws `TypeError` for a non-bigint and `RangeError` `<name> = <v> is outside the uint64 range [0, 2^64-1]`. It is called first in every function the ADR lists: `rangeNodes`, `rangeSize`, `NodeID` constructor, `decompose`, `RangeFactory.newRange`/`newEmptyRange`, `inclusion`, `consistency`, `rootFromInclusionProof`, `verifyInclusion`, `verifyConsistency`, `Checkpoint` constructor and `marshal` (also `tlog_proof.ts`, which belongs to ADR-0224). In-domain behaviour is unchanged: the merkle differential and fixture suites pass, and `verify_test.ts`, `proof_test.ts` and the compact tests cover the RangeError cases.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
