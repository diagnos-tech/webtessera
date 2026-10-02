# ADR-0012: Randomised tests use a seeded splitmix64, not a port of Go's `math/rand`

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** merkle agent
- **Upstream reference:** `merkle/compact/range_test.go` (`TestMergeRandomly`), `merkle/testonly/tree_test.go` (`TestTreeConsistencyProofFuzz`)

## Context

Two upstream tests drive their cross-checks with random inputs:

```go
// range_test.go
for seed := int64(1); seed < 100; seed++ {
	rnd := rand.New(rand.NewSource(seed))
	numNodes := rand.Uint64() % 500          // note: the *global* rand, not rnd
	...
	mid := begin + uint64(rnd.Int63n(int64(end-begin)))
}

// tree_test.go
size2 := uint64(rand.Int63n(treeSize + 1))
size1 := uint64(rand.Int63n(int64(size2) + 1))
```

Neither asserts on a specific random value. Both assert that the optimised implementation agrees
with a reference one — `tree.verifyRange` / `tree.verifyAllVisited` in the first case,
`refConsistencyProof` in the second — for whatever inputs happen to come out.

Reproducing Go's numbers bit-for-bit would mean porting `rand.NewSource`, an Additive Lagged
Fibonacci generator seeded through a 607-entry `rngCooked` table of precomputed `int64`s. That is
~600 lines of opaque constants in a donated library, for no assertion.

It would also not help with `TestMergeRandomly`, which draws `numNodes` from the **global** `rand`
rather than from the seeded `rnd`. Since Go 1.20 the global source is randomly seeded per process,
so that test is *already* non-reproducible upstream: two `go test` runs exercise different tree
sizes. Only the merge structure is seeded.

## Decision

`src/internal/gostd/rand.ts` provides a small deterministic generator — splitmix64 — with the two
operations the tests use:

```ts
export class Rand {
	uint64(): bigint;        // stands in for rand.Uint64
	int63n(n: bigint): bigint; // stands in for rand.Int63n, without rejection sampling
}
export function newRand(seed: bigint): Rand;
```

The ported tests keep upstream's loop structure and seed values. Where upstream reaches for the
global `rand`, the port draws from the seeded generator instead, so **the port is more deterministic
than the original**: `TestMergeRandomly` seeds `numNodes` too, and `TestTreeConsistencyProofFuzz`
uses a fixed seed rather than the process-global source.

`int63n` does not reject values to remove modulo bias. The bias is on the order of 2^-64 for the
bounds these tests use, and no assertion depends on the distribution.

This module is `src/internal/gostd/`, not `src/vendor/`: it is a stdlib stand-in, not a port of
anything in Tessera, and no production code imports it.

## Consequences

- A given seed exercises different tree shapes here than in Go. The tests are therefore not
  "the same run" as upstream's — they are the same *property*, checked over a different sample. For
  `TestMergeRandomly` that is unavoidable regardless of the generator, because the upstream test is
  itself non-deterministic.
- Failures are reproducible, which upstream's are not. A failing seed can be pinned and re-run.
- The coverage these tests give is bounded by the sample. `TestGenRangeNodes` (exhaustive over
  `[0,512]^2`), `TestDecompose` (exhaustive over `[0,100]^2`), `TestTreeConsistencyProof`
  (exhaustive over `[0,8]^2`) and the golden fixtures are the real coverage; the randomised tests
  are a supplement, and were upstream too.
- One more file a donation reviewer has to look at. It is 70 lines and imports nothing.

## Alternatives considered

- **Port Go's `rand.NewSource` faithfully, `rngCooked` table and all.** The only way to get
  identical inputs. Rejected: ~600 lines of magic constants in a donated library, buying identical
  inputs for tests that do not assert on their inputs — and still not fixing `TestMergeRandomly`,
  whose sizes come from the unseeded global source.
- **Use `Math.random()`.** Matches upstream's non-determinism exactly, including the global-source
  behaviour. Rejected: a failing CI run would be unreproducible, which is a worse property than a
  slightly different sample.
- **Replace the randomised tests with exhaustive ones.** Attractive, and partly already true (see
  Consequences). Rejected as a *replacement*: deleting an upstream test and asserting the remaining
  ones cover it is exactly the kind of unverifiable claim AGENTS.md §4 forbids.
- **Use a property-testing library (fast-check).** Rejected: AGENTS.md §7 allows `@noble/*` and
  nothing else in donatable code, and this would be a devDependency a donation reviewer has to
  accept.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
