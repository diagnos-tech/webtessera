# ADR-0033: Port Go testable examples as assertion tests

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** layout contributor
- **Upstream reference:** `api/layout/example_test.go`

## Context

`api/layout/example_test.go` contains four Go *testable examples*:

```go
func ExampleTilePath() {
	tilePath := layout.TilePath(0, 1234067, 8)
	fmt.Printf("tile path: %s", tilePath)
	// Output: tile path: tile/0/x001/x234/067.p/8
}
```

These are not documentation comments. `go test` runs them, captures stdout, and fails if it does not
match the `// Output:` comment exactly — so they are real tests, and they are also the rendered
examples in the package's godoc. They are the only upstream coverage of the level-1 tile address
(`ExampleNodeCoordsToTileAddress` asserts tile index 482253 and node index 21 for tree node
(8, 123456789)), so dropping them would lose a case.

TypeScript has neither mechanism: no stdout-capturing test runner convention, and no doc tool that
executes examples.

## Decision

Each `Example…` function becomes one Vitest `it()` in `src/api/layout/example_test.ts`, named after
the Go function, which:

1. performs the same calls with the same inputs;
2. builds the same string the Go builds with `fmt.Printf`, character for character, using a template
   literal;
3. keeps the `// Output:` line as a comment immediately above the assertion, so the file still diffs
   against the Go original line by line;
4. asserts the string equals that output.

Like upstream's `package layout_test`, the file imports the package from the outside — through
`./index`, the barrel — so it exercises the public surface rather than module internals.

## Consequences

- The examples keep working as tests, which is what they are for. They stop working as *documentation*
  in the godoc sense, since there is no TypeScript tool that would render them. They remain readable
  as usage examples in the test file, which is where a reader looking for one would land anyway.
- The assertion is duplicated: the expected string appears twice, once in the ported `// Output:`
  comment and once in `expect(...).toBe(...)`. That duplication is deliberate — the comment is what a
  reviewer diffs against the Go, the assertion is what runs. If they ever disagree, the reviewer sees
  it immediately.
- Formatting is by hand rather than by `fmt`. All four examples use only `%s` and `%d` on values that
  render identically under `String()`, so the template literals are exact. Anything needing real
  `fmt` verb semantics (`%q`, `%x`, width/precision) would need a shim, and none of these do.
- `bigint` renders without an `n` suffix under template-literal interpolation, so `${tileLevel}`
  produces `1`, matching Go's `%d`. This is checked by the tests themselves.

## Alternatives considered

- **Drop the file.** Rejected: `PORTING.md` §4 requires a TypeScript counterpart for every Go test
  file, and this one carries the only assertion in the repository on a level-1 tile address.
- **Capture `console.log` output and compare, so the body stays literally identical to Go.**
  Rejected: it needs a spy on a global, it makes the failure message useless, and `console.log` is
  banned by the definition of done anyway.
- **Fold the four cases into `paths_test.ts` and `tile_test.ts` tables.** Rejected: it would erase
  the correspondence with `example_test.go`, and the mirrored-path rule (ADR-0002) wants the file to
  exist.

## Review

- **Reviewer:** Layout Reviewer (2026-08-19)
- **Verdict:** approved
- **Notes:** All four `Example…` functions from example_test.go have a matching `it()` in
  example_test.ts with the same inputs, the ported `// Output:` line kept immediately above the
  assertion, and the asserted string equal to it. Imports go through `./index` (the barrel), matching
  Go's external `package layout_test`. Confirmed the `%d`/`%s` template-literal claim: `${tileLevel}`
  on a `bigint` renders `1`, not `1n` — checked live, the tests pass. `ExampleNodeCoordsToTileAddress`
  is the only assertion in the repo on the (1, 482253, 0, 21) level-1 address, so dropping the file
  would have lost a case; keeping it is correct.
