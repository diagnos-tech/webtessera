# ADR-0034: Do not port Go benchmarks

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** layout contributor
- **Upstream reference:** `api/state_test.go` (`BenchmarkLeafBundle_UnmarshalText`), `internal/parse/parse_test.go` (`BenchmarkCheckpointUnsafe`)

## Context

Two of the Go test files in this work package contain benchmarks alongside their tests:

```go
func BenchmarkLeafBundle_UnmarshalText(b *testing.B) {
	// builds a 222-entry bundle with entries of varying length, then:
	for b.Loop() {
		tile := api.EntryBundle{}
		if err := tile.UnmarshalText(rawBundle); err != nil { b.Fatal(err) }
	}
}

func BenchmarkCheckpointUnsafe(b *testing.B) { ... }
```

They exist for a reason. `internal/parse`'s package comment says the code is "critical enough that it
should be reused, tested, and **benchmarked** rather than copied around willy nilly", so the
benchmark is part of that package's stated contract, and `EntryBundle.UnmarshalText` is on the
hottest decode path in the library.

`PORTING.md` §4 requires a TypeScript counterpart for every Go **test** file; it does not say what to
do with the benchmark functions inside them. Vitest has `bench()`, but it needs its own config
(`benchmark.include`), it does not run under `vitest run`, and its numbers are not comparable to
`go test -bench` output in any way that would let a reviewer check a claim.

## Decision

**Benchmarks are not ported.** `BenchmarkLeafBundle_UnmarshalText` and `BenchmarkCheckpointUnsafe`
have no counterpart in `state_test.ts` or `parse_test.ts`.

The *test* functions in both files are ported in full, so no assertion is lost — a benchmark asserts
nothing beyond "does not error", and both benchmarks' error paths are already covered by the ported
`TestLeafBundle_UnmarshalText` and `TestCheckpointUnsafe` tables.

This ADR covers the whole port, not just this work package: if a later work package wants
benchmarks, it supersedes this ADR rather than quietly adding a `bench()` here and there.

> **Update (2026-10-02):** the same decision covers the benchmarks of the vendored dependencies, which were
> never listed: `merkle/compact/range_test.go` (`BenchmarkAppend`), `merkle/rfc6962/rfc6962_test.go`
> (`BenchmarkHashChildren`), and `formats/log/note_test.go` (`BenchmarkParse`, `BenchmarkLotsOfIDs`, and its
> helper `benchmarkLotsOfIDs`). None is ported; each sits beside tests that are (`TestAppend`,
> `TestRFC6962Hasher`, `TestParseCheckpoint`/`TestSumDBNoteParsing`).

## Consequences

- No performance regression detection. If someone makes `EntryBundle.unmarshalText` allocate a copy
  per entry instead of a `subarray` view, no test fails. The mitigation is a reviewer instruction,
  not a test: `REVIEW-PROTOCOL.md` §2.2 already makes slice aliasing a blocking check.
- The `internal/parse` package comment, which is ported verbatim, promises benchmarking that this
  port does not deliver. A reader of `parse.ts` will see the word "benchmarked" with nothing behind
  it. Left as-is rather than edited, because editing upstream comments to match our omissions is a
  worse habit than a comment that slightly over-promises — and this ADR is the record.
- Adding them later is cheap: a `*_bench.ts` next to the test file plus a `vitest.bench.config.ts`.
  Nothing here forecloses it.

## Alternatives considered

- **Port them as `bench()` in a separate benchmark config.** The honest option, and the one to take
  if performance work starts. Rejected for now: it adds a config, a script, and a suite that CI would
  not run, in exchange for numbers nobody is currently comparing against anything. Cost with no
  present consumer.
- **Port them as ordinary `it()` tests that just execute the loop body once.** Rejected: that is a
  test pretending to be a benchmark. It would measure nothing and would give a false impression of
  coverage in `PORTING-MAP.md`.
- **Port them and assert a wall-clock budget.** Rejected outright: timing assertions are flaky on
  shared CI and would be the first thing anyone disabled.

## Review

- **Reviewer:** Layout Reviewer (2026-08-19)
- **Verdict:** approved
- **Notes:** Confirmed `BenchmarkLeafBundle_UnmarshalText` and `BenchmarkCheckpointUnsafe` have no
  counterpart in state_test.ts / parse_test.ts, and that the *test* tables they sit beside
  (`TestLeafBundle_UnmarshalText`, `TestCheckpointUnsafe`) are ported in full with every case — so no
  assertion is lost, since a benchmark asserts only "does not error" and both error paths are covered.
  Agreed with keeping the ported `internal/parse` package comment's "benchmarked" wording verbatim
  rather than editing an upstream comment to match an omission; this ADR is the record of that gap.
  The ADR correctly scopes itself to the whole port (a later package that wants benchmarks supersedes
  it).
