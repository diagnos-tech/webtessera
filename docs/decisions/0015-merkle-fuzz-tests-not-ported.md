# ADR-0015: Do not port the merkle fuzz tests

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** merkle agent
- **Upstream reference:** `merkle/compact/node_fuzz_test.go`, `merkle/testonly/tree_fuzz_test.go`, `merkle/.clusterfuzzlite/`, `merkle/testdata/FuzzRangeNodes/`

## Context

Two files in this work package are Go fuzz targets rather than tests:

```go
// compact/node_fuzz_test.go
func FuzzRangeNodes(f *testing.F) {
	// seeds, then:
	f.Fuzz(func(t *testing.T, begin, end uint64) {
		if begin > end { return }
		nodes := RangeNodes(begin, end, nil)
		// Nodes should be contiguous covering begin to end
		previousEnd := begin
		for _, node := range nodes {
			b, e := node.Coverage()
			if b != previousEnd { t.Errorf(...) }
			previousEnd = e
		}
		if previousEnd != end { t.Errorf(...) }
	})
}

// testonly/tree_fuzz_test.go
func FuzzConsistencyProofAndVerify(f *testing.F) { ... }
func FuzzInclusionProofAndVerify(f *testing.F) { ... }
```

They are wired into OSS-Fuzz via `.clusterfuzzlite/`, and `testdata/FuzzRangeNodes/` holds the
20 corpus entries that previous runs found interesting. Under a plain `go test` (no `-fuzz`), Go
runs each target once per seed and once per corpus file — so upstream's own CI gets seed coverage,
not fuzzing.

Vitest has no fuzzing engine and no corpus format. The properties these targets check are cheap to
state but the *value* of a fuzz target is the engine behind it, which we cannot bring across.

## Decision

**The fuzz targets are not ported**, and there is no `node_fuzz_test.ts` or `tree_fuzz_test.ts`.

The properties they assert are covered by ported tests that are exhaustive rather than sampled over
the ranges that matter:

| Fuzz target | Property | Covered by |
| --- | --- | --- |
| `FuzzRangeNodes` | `rangeNodes(begin, end)` covers `[begin, end)` contiguously | `TestGenRangeNodes` (`nodes_test.ts`) checks `rangeNodes` against a recursive reference implementation for **every** `(begin, end)` with `0 <= begin <= end <= 512` — a stronger statement than contiguity, over 131k pairs. `range_fixtures_test.ts` adds the pairs the Go fuzzer cannot easily reach, up to and including `(MaxUint64-1, MaxUint64)`, against values the real Go implementation produced. |
| `FuzzConsistencyProofAndVerify` | `verifyConsistency` accepts what `Tree.consistencyProof` produces | `TestTreeConsistencyProof` (exhaustive over `[0,8]^2`), `TestTreeConsistencyProofFuzz` (randomised, ADR-0012), and `proof_fixtures_test.ts`, which verifies every recorded proof for **every** `(size1, size2)` pair up to 40 plus selected pairs up to 5000. |
| `FuzzInclusionProofAndVerify` | `verifyInclusion` accepts what `Tree.inclusionProof` produces | `TestTreeInclusionProof` (every leaf of every tree up to 256), and `proof_fixtures_test.ts`, which verifies every recorded proof for every leaf of every tree of size 1..40 plus selected leaves in trees up to 5000. |

The 20 corpus files in `testdata/FuzzRangeNodes/` are **not** imported. Each is a Go fuzz-corpus
file (a small text format with `go test fuzz v1` plus typed literals); the interesting inputs it
encodes — the boundaries around powers of two and near `MaxUint64` — are already in
`compact_range.json`'s `rangeNodes` table, generated from the same Go code.

Note this is a *stronger* omission claim than ADR-0034 makes for benchmarks: a benchmark asserts
nothing, whereas a fuzz target does. The claim above is that the assertions survive, not that they
did not exist.

## Consequences

- **No engine-driven input discovery.** If a future change breaks `rangeNodes` only for some
  `(begin, end)` pair above 512 that no fixture happens to contain, nothing here finds it. That is a
  genuine reduction against upstream, whose OSS-Fuzz integration runs continuously. The mitigations
  are the exhaustive small-range test, the MaxUint64 fixtures, and the fact that `compact_range.json`
  can be regenerated with more pairs cheaply if a reviewer wants them.
- Anyone who does want fuzzing here has a clear path: the properties are one-liners over
  `rangeNodes`/`Tree`, and a property-testing library would express them directly. That would need a
  devDependency (AGENTS.md §7) and would supersede this ADR.
- Upstream's OSS-Fuzz config, `build.sh` and `Dockerfile` are Go-toolchain specific and have no
  counterpart at all; they are out of scope for the same reason `go.mod` is.

## Alternatives considered

- **Port them as seeded property tests over a fixed input list** (the seeds plus the checked-in
  corpus). Rejected: it produces a test that looks like fuzzing and is not, which is worse than not
  having it — a reader would over-trust it. The seeds themselves are small and already inside
  `TestGenRangeNodes`'s exhaustive range.
- **Port them using fast-check.** The honest port, and the one to take if fuzzing is wanted.
  Rejected here: AGENTS.md §7 permits `@noble/*` and nothing else in donatable code, and adding a
  test-time dependency to a package intended for donation is a decision for the humans, not for this
  work package.
- **Transcribe `testdata/FuzzRangeNodes/` into a fixture.** Rejected: it would mean hand-decoding
  Go's corpus format into JSON, which AGENTS.md §5 forbids ("never hand-edit a file in
  `fixtures/data/`"). If those exact inputs are wanted, the generator in `fixtures/gen/compact.go`
  should emit them, which is a change to the fixtures work package.

> **Update (2026-10-02):** corrections to the record above.
>
> - **There are six fuzz targets, not three**: `compact/node_fuzz_test.go` has `FuzzRangeNodes`, and
>   `testonly/tree_fuzz_test.go` has `FuzzConsistencyProofAndVerify`, `FuzzInclusionProofAndVerify`,
>   `FuzzHashAtAgainstReferenceImplementation`, `FuzzInclusionProofAgainstReferenceImplementation` and
>   `FuzzConsistencyProofAgainstReferenceImplementation`. The last three compare `Tree` against the
>   reference implementations; their properties are what `TestTreeHashAt`, `TestTreeInclusionProof` and
>   `TestTreeConsistencyProof`/`TestTreeConsistencyProofFuzz` assert, over the ranges given below.
> - **The corpus has 19 files, not 20**, all under `compact/testdata/fuzz/FuzzRangeNodes/` (there is no
>   `testdata/` at the module root). `FuzzRangeNodes`' seeds call `f.Add(end, end)`, so under plain `go test`
>   they exercise empty ranges only.
> - **Test descriptions:** `TestTreeInclusionProof` checks every leaf of one generated 256-leaf tree and of
>   the golden trees of sizes 0–7, not "every leaf of every tree up to 256".
> - **The corpus claim is withdrawn.** `compact_range.json`'s `rangeNodes` table does not contain every corpus
>   input: `(1, 767)` lies outside both it and `TestGenRangeNodes`' exhaustive `end <= 512` range. Adding the
>   pair to the generator would mean regenerating committed fixtures in a directory another work package is
>   changing, so it is not done here. For the record, the 19 corpus inputs were replayed against the port's
>   `rangeNodes` with `FuzzRangeNodes`' contiguity property during the 2026-10-02 merkle audit, and all 19 pass.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. (The update carried no review line; every correction in it is
verified in the Review below.)*

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Upstream, in `merkle@v0.0.2`. The fuzz files are `compact/node_fuzz_test.go` (`FuzzRangeNodes`) and `testonly/tree_fuzz_test.go`
    (five targets, so six in all and not the three the Context names; the Update says so, correctly). `FuzzRangeNodes` asserts that `RangeNodes(begin, end)`
    has contiguous coverage ending at `end`; its seeds are `f.Add(end, end)`, as the Update says. The `*AndVerify` targets build a tree of
    size < 65535, produce a proof with `testonly.Tree` and check it with `proof.VerifyInclusion`/`VerifyConsistency`; the three
    `*AgainstReferenceImplementation` targets compare `Tree` with `refRootHash`/`refInclusionProof`/`refConsistencyProof`. The corpus is
    `compact/testdata/fuzz/FuzzRangeNodes/`, 19 files, as the Update corrects (the ADR's "20" and "`testdata/` at the root" were wrong).
  - Is the substitute coverage real? I checked the figures. `TestGenRangeNodes` is exhaustive for `0 <= begin <= end <= 512` against a recursive
    reference (131,841 pairs) and passes in `nodes_test.ts`. `compact_range.json` contains `(MaxUint64-1, MaxUint64)` and `(0, MaxUint64)` in
    its `rangeNodes` table and does not contain `(1, 767)`, which is exactly what the Update withdraws. `proof_consistency.json` has 861 cases
    (every `0 <= size1 <= size2 <= 40`, since 41*42/2 = 861) plus 94 larger ones, and `proof_inclusion.json` has 820 proofs for sizes 1..40
    (every leaf of every tree, 1+2+...+40) plus 9 larger trees up to 5000, so "every pair up to 40" and "every leaf of every tree 1..40" are right.
    `TestTreeInclusionProof` runs on one generated 256-leaf tree and the golden trees of sizes 0..7, which is the Update's wording
    ("not every leaf of every tree up to 256"); `TestTreeHashAt` and `TestTreeConsistencyProof` (`[0,8]^2`) are as described.
  - I repeated the Update's corpus claim. I parsed the 19 files in the Go module cache and ran `FuzzRangeNodes`' property against the port's
    `rangeNodes`/`coverage()`: 18 satisfy it and one has `begin > end`, which the target skips with `return`. So none fails, consistent with
    "all 19 pass".
  - The decision is sound: the properties the targets assert are covered by exhaustive or fixture-backed ported tests, and the ADR is honest that
    the engine-driven discovery is lost. Two imprecisions that do not change it. (1) The Context says the targets are "wired into OSS-Fuzz via
    `.clusterfuzzlite/`" and the Consequences that upstream's "OSS-Fuzz integration runs continuously". The directory is ClusterFuzzLite's
    (`project.yaml`, `build.sh`), and upstream's workflows run it as PR fuzzing for 600 s in `code-change` mode (`cflite_pr.yml`) and a build on
    push; there is no continuous batch run in the repository. What is lost is therefore somewhat less than the Consequences say. (2) The
    Consequences name only `rangeNodes` above 512 as uncovered, but the `*AndVerify` and `*AgainstReferenceImplementation` targets accept
    sizes up to 65534 and the fixtures stop at 5000 (every pair only to 40). Same kind of gap, one more sentence.
  - Challenge on the alternatives. "Port them as seeded property tests ... looks like fuzzing and is not" is a fair reason, and the rejection of
    hand-decoding the Go corpus into `fixtures/data/` follows AGENTS.md section 5. I did not find a reason to overrule the omission.
