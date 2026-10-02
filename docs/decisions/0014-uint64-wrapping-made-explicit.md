# ADR-0014: uint64 wrapping and Go shift semantics are written out via `internal/gostd/bits`

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** merkle agent
- **Upstream reference:** `merkle/compact/range.go` (`getMergePath`, `Decompose`, `appendImpl`, `GetRootHash`), `merkle/compact/nodes.go` (`Coverage`, `RangeNodes`, `RangeSize`), `merkle/proof/proof.go`, `merkle/proof/verify.go`

## Context

ADR-0003 makes every Go `uint64` a `bigint`. That gets the precision right and the *arithmetic*
wrong in three specific ways, because a `bigint` is unbounded where a `uint64` is not:

| Go, on uint64 | TypeScript, on bigint |
| --- | --- |
| `x - 1` with `x == 0` → `MaxUint64` | `-1n` |
| `^x` (complement) → `MaxUint64 - x` | `~x` → a negative bigint |
| `x << n`, `n >= 64` → `0` | a value larger than 2^64 |
| `x << n`, `n` from a negative `int` → `0` (the `int` converts to a huge `uint`) | `RangeError: negative shift` |

Every one of these is reachable in this work package, and upstream's own tests reach three of them:

```go
// range.go getMergePath — TestGetMergePath's {0,0,0} case depends on mid-1 wrapping
if high2 := bits.Len64((mid - 1) ^ end); high2 < high { high = high2 }

// range.go Decompose — ^xbegin is a uint64 complement
d := bits.Len64(xbegin^end) - 1
mask := uint64(1)<<uint(d) - 1        // d can be -1; uint(-1) makes the shift yield 0
return ^xbegin & mask, end & mask

// nodes.go Coverage — (index+1) << level overflows at level 63
return id.Index << id.Level, (id.Index + 1) << id.Level
```

`compact_range.json` pins the last one directly: node `(63, 2^63-1)` has `coverageEnd: "0"`.

Go's `math/bits` intrinsics have no TypeScript equivalent either, and their zero-input conventions
are load-bearing: `TrailingZeros64(0) == 64` (not 0), `Len64(0) == 0`, and both feed shift counts.

## Decision

`src/internal/gostd/bits.ts` provides the intrinsics and the wrapping primitives, and **every place
the ported Go performs uint64 arithmetic that can leave the 64-bit range goes through them**:

```ts
export const MaxUint64 = 0xffffffffffffffffn;
export function asUint64(x: bigint): bigint;          // Go's uint64 truncation; also spells ^x as asUint64(~x)
export function trailingZeros64(x: bigint): number;   // 64 for x == 0
export function len64(x: bigint): number;             // 0 for x == 0
export function onesCount64(x: bigint): number;
export function shiftLeft64(x: bigint, n: number): bigint;   // 0 for n < 0 or n >= 64
export function shiftRight64(x: bigint, n: number): bigint;  // 0 for n < 0 or n >= 64
```

`shiftLeft64`/`shiftRight64` treat a negative `n` as zero-yielding because that is what Go does: the
shift count is `uint`, so a negative `int` converts to a value ≥ 2^63 and the shift saturates.

The port sites:

- `NodeID.coverage()` → `shiftLeft64(index, level)` and `shiftLeft64(asUint64(index + 1n), level)`.
- `getMergePath` → `len64(asUint64(mid - 1n) ^ end)`.
- `decompose` → `asUint64(shiftLeft64(1n, d) - 1n)` for the mask, `asUint64(~xbegin) & mask` for the
  left part.
- `Range.getRootHash`, `Range.#appendImpl`, `proof.nodes`, `verify.decompInclProof`,
  `verify.chainInner`/`chainInnerRight`, `verify.verifyConsistency` → `shiftRight64`/`shiftLeft64`
  wherever the shift count is computed rather than literal.

`bits_test.ts` covers 0, 1, `MaxUint64`, every power of two, every power of two minus one, both
32-bit halves independently, and cross-checks all three intrinsics against naive bit-by-bit
reference implementations over a dense range.

## Consequences

- `bits.ts` is 110 lines that a Go reader would not expect to see, and its correctness is a
  precondition for every hash the library produces. That is why it has its own exhaustive test file
  rather than being covered incidentally.
- `asUint64(...)` at the call sites is visual noise relative to the Go. It is deliberate noise: each
  one marks a place where Go's arithmetic silently wraps, and a reviewer can grep for them.
- **One degenerate case is not bit-faithful, and it is unreachable.** `getMergePath` ends with
  `return uint(low), uint(high - 1)`. When `high == 0` — which requires `mid < begin` or
  `end == mid - 1`, both outside the documented precondition `begin <= mid <= end` — Go's conversion
  yields `MaxUint64`, whereas the port returns `-1`. `appendImpl`'s subsequent
  `if high < low { high = low }` then produces an empty merge path here, where Go would produce a
  full-width mask. Upstream documents the function as "the output is not specified if
  `begin <= mid <= end` doesn't hold", and `Append`/`AppendRange` both establish that precondition
  before calling it, so no caller can observe the difference. It is recorded here rather than
  papered over: making it bit-faithful would mean carrying `low`/`high` as `bigint` shift counts
  throughout, which costs clarity everywhere to match behaviour in a state upstream declines to
  define.
- `Number` is still used for values Go types as `uint`/`int` (levels, offsets, proof lengths), per
  ADR-0003. Mixing those with `bigint` is a type error, which is the intended guard rail — every
  `BigInt(level)` in the port marks a deliberate widening.

## Alternatives considered

- **Rely on bigint's natural semantics and mask only where a test fails.** Rejected outright. The
  failure mode is a valid-looking proof for the wrong leaf; "no test caught it" is not evidence of
  correctness at the boundaries, and the boundary cases (`(63, 2^63-1)`, `Decompose(1, MaxUint64)`)
  are exactly what a transparency log has to get right.
- **Use `BigInt.asUintN(64, ...)` inline everywhere instead of named helpers.** Rejected: the
  intrinsics (`trailingZeros64`, `len64`, `onesCount64`) need a home anyway, and a named
  `asUint64` next to them reads as "this is Go's uint64", where a bare `BigInt.asUintN(64, x)` reads
  as an implementation detail.
- **A branded `Uint64` type that wraps on every operation.** Rejected for the reasons ADR-0003
  already gives: it turns every expression into a method call and destroys line-by-line
  correspondence.
- **Represent shift counts as `bigint` so `getMergePath` can be bit-faithful.** Rejected: it would
  make `low`, `high`, `inner`, `border`, `shift` and every proof length a `bigint` — Go types them
  `uint`/`int` — to match behaviour on inputs upstream explicitly leaves unspecified.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
