# ADR-0014: uint64 wrapping and Go shift semantics are written out via `internal/gostd/bits`

- **Status:** accepted
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Checked and right. Every Go excerpt in the Context is at the cited place in `merkle@v0.0.2` (`range.go` `getMergePath`, `Decompose`
    with `uint64(1)<<uint(d) - 1`, `nodes.go` `Coverage`). The fixture `compact_range.json` does pin node `(63, 2^63-1)` with
    `coverageEnd: "0"`. `src/internal/gostd/bits.ts` implements the six helpers as listed, with Go's zero conventions
    (`trailingZeros64(0) == 64`, `len64(0) == 0`); `bits_test.ts` has the cases the Decision lists (26 tests pass), and
    `gostd_differential_test.ts` ("bits and uint64 shifts match math/bits and Go's << and >>") replays Go-printed values,
    so the intrinsics are checked against Go and not only against the port's own reference. Each site in the Decision's list uses
    the helpers: `coverage()`, `getMergePath` (`len64(asUint64(mid - 1n) ^ end)`), `decompose` (`asUint64(shiftLeft64(1n, d) - 1n)`,
    `asUint64(~xbegin) & mask`), `getRootHash` (`size &= size - 1n` is the same as Go's wrap, for size 0 too),
    `#appendImpl`, `proof.nodes`/`consistency`, and the five shifts of `verify.ts`. Where a site subtracts without `asUint64`
    (`innerProofSize`'s `size - 1n`, `index & (shiftLeft64(1n, high - low) - 1n)`) the next operation (`len64`, `&` with a
    non-negative `index`) normalises the value, so the result is Go's. I read the TypeScript against `proof.go`, `verify.go`,
    `range.go` and `nodes.go`.
  - **Changes requested, 1 (substantive): the "degenerate case" in Consequences is not unreachable, and the port does not match
    Go there.** The ADR says `getMergePath` returns `high == 0` only "which requires `mid < begin` or `end == mid - 1`, both outside the
    documented precondition `begin <= mid <= end`", and that "no caller can observe the difference". But `mid = 0`, `end = MaxUint64`
    satisfies `begin <= mid <= end` (with `begin = 0`) and also `end == mid - 1` modulo 2^64. It is reachable through the exported API: a
    range `[0, 2^64-1)` is valid (`NewRange(0, MaxUint64, 64 hashes)`), and `NewEmptyRange(0).AppendRange(thatRange)` passes both
    checks of `AppendRange` and calls `getMergePath(0, 0, MaxUint64)`, which returns `(64, MaxUint64)` in Go (`uint(high-1)` with
    `high == 0`) and `[64, -1]` here. I ran both. Go (`merkle@v0.0.2`) panics with `runtime error: index out of range [63] with
    length 63` (the loop `for h := low; h < high` runs past the 63 right-hand hashes). The port returns normally: `appendImpl` clamps
    `high` to `low`, runs no merge step and yields a range with `end() == 2^64-1` and 64 hashes. So an input within the documented
    precondition behaves differently, which is exactly the class of boundary this ADR exists to get right. `Append` cannot reach it
    (`(mid-1)^(mid+1)` is never 0); only this one `AppendRange` input can. The differential corpus does not cover it (its merge
    spans are at most 48 leaves; sequential `Append` is not affected). What must change: replace "unreachable ... no caller can observe
    the difference" with the real statement (reachable at begin = mid = 0, end = MaxUint64; Go panics, the port succeeds), and then
    either record that as an accepted divergence with a test that pins the port's behaviour, or change `appendImpl` to refuse it as Go does
    (a thrown `Error`, since a Go panic is a thrown error under ADR-0004), with a test. I take no position on which; the fidelity
    rule (AGENTS.md section 1) favours the second, but the input is a log of 2^64-1 entries.
  - **Changes requested, 2 (the Update of 2026-10-02, second one): "Every computed shift upstream writes that conversion explicitly" is
    wrong for one site.** `proof.go:96` is `fork := compact.NewNodeID(level+uint(inner), index>>inner)` with `inner` an `int` (the result
    of `bits.Len64(...) - 1`), shifted with no `uint(...)`. There a negative `inner` would panic in Go ("negative shift amount"), and
    `shiftRight64(index, inner)` here yields 0. It cannot happen (`inner >= 0` because `index != size>>level` for every input
    `inclusion` and `consistency` accept), so nothing is wrong in practice, but the sentence is the justification for modelling
    all computed shifts as `x >> uint(n)`, and it should say "all but `index>>inner` in `proof.nodes`, which is unreachable".
  - **Changes requested, 3 (the Update of 2026-10-02, first one): "each with a Port note and a test whose expected values were printed by
    the Go code" is not true of `minImpliedTreeSize`.** It has the Port note (`integrate.ts:600`) but no test refers to it, directly or by a
    case that makes `level * 8` wrap. The other five sites have tests with Go values: `Range(5, MaxUint64-2, 10)` is
    `N:18446744073709551613` in Go (I ran `layout.Range`) and a `RangeError` in `paths_test.ts:523`; `PartialTileSize(1<<61, 60, 12345)` is 57
    in Go and in `tile_test.ts`; and the `stream`, `fsck` and `client` cases are in `stream_test.ts`, `fsck_test.ts:347` and `client_test.ts:468`.
    Either add a test (the function is module-private, so it needs an `@internal` export or a case through `tileWriteCache`) or say that
    this site has none.
  - Not blocking. "`bits.ts` is 110 lines": the file is 184 lines, about 60 of them licence text, and now includes `assertUint64`
    (ADR-0207). The Decision's signature list does not mention `assertUint64`; ADR-0207 does.
  - Status stays `proposed`. Everything else in the ADR, including the choice of named helpers over inline `BigInt.asUintN`, is sound.

## Update (2026-10-02): further sites outside the Merkle port

The same helpers now write out Go's uint64 wraparound at these sites, each with a Port note and a test
whose expected values were printed by the Go code at the pinned commit:

- `api/layout/paths.ts` `range`: `from + N` and `endInc = from + N - 1` wrap. Where the wrap makes
  Go's `uint` count `N` itself wrap (a single bundle whose wrapped end falls before `First`, e.g.
  `Range(5, MaxUint64-2, 10)`, where Go yields `N: 18446744073709551613`), the value cannot be
  represented in `RangeInfo.n: number`, and a `RangeError` is thrown instead. This is the one site that
  is not bit-faithful; making it so would mean typing `RangeInfo.first`/`n` as `bigint`.
- `api/layout/tile.ts` `partialTileSize`: `level * TileHeight` wraps and the shift saturates at 64
  (`PartialTileSize(1<<61, 60, 12345) == 57` in Go and here).
- `storage/internal/integrate.ts` `minImpliedTreeSize`: the `level * 8` shift count wraps, as the
  product already did.
- `client/stream.ts`: `fromEntry + N` in `entryBundles`, and the entry index in `entries`.
- `fsck/fsck.ts` `appendBundle`: `impliedSeq = index * 256 + first`.
- `client/client.ts` `fetchLeafHashes`: `end = first + N`.

*Review of this update: changes requested, ADR review agent (independent), 2026-10-04. Checked the six sites against Go: the
`layout.Range` and `PartialTileSize` values quoted are what the pinned Go prints (`N:18446744073709551613`, 57) and the port gives
a `RangeError` and 57; the other four sites carry the helpers and (except `minImpliedTreeSize`) a test with Go's values. One claim to
correct: item 3 of the Review above.*

## Update (2026-10-02): the remaining Merkle sites, and the negative-shift row

- **`Range.append`** now passes `asUint64(this._end + 1n)` to `appendImpl`, like the other sites listed under
  Decision: Go's `r.end+1` wraps to 0 at `MaxUint64`. Before, the port carried an end of 2^64; the merkle
  differential harness's 20 sequential-append mismatches at that boundary are now 0.
- **`proof.nodes`, `proof.consistency` and `compact.rangeNodes`** compute their shift counts
  (`size >> level`, `index >> inner`, `(size1-1) >> level`, `pos >> level`) and now spell them
  `shiftRight64(x, n)` as the Decision says, instead of `x >> BigInt(n)`. For every valid input the result is
  the same (the counts are in [0, 63] there); the helper is what makes a count outside that range yield Go's
  0 rather than a left shift. Shifts by a literal (`>> 1n`, `index >>= 1n`) stay plain operators, as the
  Decision allows.
- **The negative-shift row of the Context table is imprecise.** In Go, `x << n` with a *signed* negative `n`
  panics at run time ("negative shift amount"); it is `x << uint(n)` that yields 0, because the conversion
  makes the count at least 2^63. Every computed shift upstream writes that conversion explicitly
  (`uint64(1)<<uint(d)` in `Decompose`, `index>>uint(i)` in the verifier), and that is what `shiftLeft64` and
  `shiftRight64` model. Their doc comments and test names in `bits.ts`/`bits_test.ts` now say so.
- Values outside the uint64 domain (negative, or ≥ 2^64) can no longer reach these sites from the exported
  entry points at all: see ADR-0207.

*Review of this update: changes requested, ADR review agent (independent), 2026-10-04. Checked: `Range.append` passes
`asUint64(this._end + 1n)`; `proof.nodes`, `proof.consistency` and `compact.rangeNodes` spell their shift counts `shiftRight64`;
the negative-shift correction is right (a negative signed count panics in Go, `x << uint(n)` saturates) and `bits.ts` and its tests now say so;
the merkle differential harness passes today. Two things to correct: item 2 of the Review above ("every computed shift"), and
the fact that the unreachability claim about `getMergePath` in Consequences, which this update leaves standing, is wrong (item 1).*

## Update (2026-10-04): the reachable `getMergePath` wrap fails as Go does; two corrections

This answers the three points of the Review above. The decision is unchanged.

1. **The degenerate case is reachable, and the port now fails there as Go does.** The Consequences bullet that calls
   it unreachable is wrong. `begin = mid = 0, end = MaxUint64` satisfies `begin <= mid <= end` and gives `high == 0`,
   and it is the only input within the precondition that does: `high` from `begin` is 0 only when `mid < begin`, and
   `high2` is 0 only when `end == mid - 1` modulo 2^64, which with `mid <= end` means `mid = 0, end = MaxUint64`.
   `NewEmptyRange(0).AppendRange(r)` with `r = NewRange(0, MaxUint64, 64 hashes)` reaches it. Go (`merkle@v0.0.2`,
   run under Go 1.24.7 and 1.25.5) does not clamp `uint(high-1) = MaxUint`, so the merge loop runs: it calls the
   visitor 63 times, for nodes `(65, 0)` to `(127, 0)`, then panics with
   `runtime error: index out of range [63] with length 63` and leaves the range unchanged. The port used to clamp
   `high` to `low` and return normally. `Range.#appendImpl` (`src/vendor/merkle/compact/range.ts`) now reads
   `getMergePath`'s `-1` as Go's `MaxUint` in the two comparisons, which are unsigned in Go: the clamp and the loop
   bound. It keeps `-1` in the arithmetic, where it already yields Go's values: `shiftLeft64(1n, high - low)` saturates
   to 0, so the mask is all ones, and `zeros` is negative, as Go's `int(high-low)` is. Go's bounds check on
   `hashes[idx2]` is written out, and it throws Go's panic text, as ADR-0004 maps a panic. The visits, the last merged
   hash and the unchanged range match Go. The test is `range_test.ts`, "panics as Go does when [0, MaxUint64) is
   appended to an empty range". It replays the values the Go probe printed. `getMergePath`'s doc comment carries a
   Port note on its `-1`. The last alternative still stands: matching Go here takes one flag, not `bigint` shift
   counts.
2. **One computed shift upstream is signed.** The second 2026-10-02 update says every computed shift upstream writes
   the `uint(...)` conversion. It has one exception: `index>>inner` in `proof.nodes` (`proof.go:96`), where `inner` is
   an `int`. A negative count would panic in Go ("negative shift amount"), but `shiftRight64` yields 0. The count
   cannot be negative. `inner` is `Len64(index ^ (size>>level)) - 1`, which is -1 only when `index == size>>level`.
   `Inclusion` rejects `index >= size` first. In `Consistency`, `index = (size1-1)>>level` is less than
   `size1>>level <= size2>>level`. So that sentence should read "every computed shift except `index>>inner` in
   `proof.nodes`, whose count is never negative".
3. **`minImpliedTreeSize` now has the test the first 2026-10-02 update claimed.** It is exported as `@internal` (ADR-0010).
   `integrate_test.ts`, "port additions: minImpliedTreeSize wraps as Go's uint64 does", checks ten tile IDs against
   the values `storage/internal`'s `minImpliedTreeSize` printed at the pinned commit under Go 1.25.5. They include a
   wrapped product (`index = 2^56` and `MaxUint64`), a shift count of 64 (`level = 8`), and a wrapped shift count
   (`level = 2^61`, `2^61 + 1` and `MaxUint64`).

The non-blocking note also holds: `bits.ts` has grown beyond the 110 lines that Consequences gives, and it now
includes `assertUint64` (ADR-0207).

*Review of this update: approved, ADR review agent (independent), 2026-10-04. See the Re-review below.*

## Re-review (2026-10-04)

- **Re-review:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - All three points of the earlier Review are answered; I re-ran Go and the tests.
  - Point 1, the reachable `getMergePath` wrap. Reproduced under Go 1.24.7 and 1.25.5 (probe `fixprobe/p1`, `NewRange(0, MaxUint64, 64 hashes)`, then `NewEmptyRange(0).AppendRange`): 63 visitor calls from node (65, 0) to (127, 0), last hash `eafdf4dd...bb12`, then `panic: runtime error: index out of range [63] with length 63`, and the range left at end 0 with no hashes. In `Range.#appendImpl`, `mergeHigh < 0` stands for Go's `uint(high-1)` = MaxUint: it is not clamped to `low` (Go's comparison is unsigned), the loop is unbounded, and the bounds check on `hashes[idx2]` throws Go's text before `_hashes` and `_end` are assigned, so the range is unchanged. The arithmetic that keeps `-1` gives Go's values (`shiftLeft64(1n, high - low)` saturates to 0, so the mask is all ones; `zeros` is negative as Go's `int(high-low)`). The Update's claim that this is the only input inside the precondition holds: `high` from `begin` is 0 only when `mid < begin`, and `high2` is 0 only when `end == mid-1` modulo 2^64, which with `mid <= end` forces `mid = 0`, `end = MaxUint64`, hence `begin = 0`. The test "panics as Go does when [0, MaxUint64) is appended to an empty range" asserts the exact text, the 63 visits, the first and last node IDs, the last hash and the unchanged range, and passes. `getMergePath` carries a Port note.
  - Point 2, `index>>inner` at `proof.go:96`. Go computes `inner := bits.Len64(index^(size>>level)) - 1` as an `int` and shifts by it with no `uint(...)`. The Update's argument that it is never negative is right: `Inclusion` rejects `index >= size` first, and in `Consistency` `index = (size1-1)>>level` is below `size1>>level`, which is at most `size2>>level`, because `level` is `TrailingZeros64(size1)`.
  - Point 3, `minImpliedTreeSize`. It is exported `@internal` and the test "port additions: minImpliedTreeSize wraps as Go's uint64 does" has ten cases. I recomputed all ten with a Go program that transcribes `(id.Index * layout.TileWidth) << (id.Level * 8)` on uint64 (the function itself is unexported in an internal package): every value equals the test's (256, 65536, 0, 0, 0, 18446744073709551360, 768, 196608, 5001117282205630464, 0). `range_test.ts` and `integrate_test.ts`: 500 tests pass.
  - The original Consequences bullet that calls the case unreachable stays in the file as history, and the Update says plainly that it is wrong; that is the form the protocol wants. The non-blocking `bits.ts` line count is acknowledged in the Update.
