# ADR-0217: Check upstream test parity mechanically with `pnpm test:parity`

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** Gustavo Simões
- **Upstream reference:** every `*_test.go` of Tessera at the pin and of the vendored modules (`merkle`,
  `formats/{log,note}`, `sumdb/note`, `cryptobyte`)

## Context

PORTING.md §4 requires every upstream test to have a TypeScript counterpart under the same name, or an ADR
saying why not. The fidelity audits checked that by hand, package by package. A test added upstream at the next
pin bump, or a ported test renamed or deleted later, would go unnoticed until the next audit.

## Decision

`scripts/test-parity.mjs` (`pnpm test:parity`; `bun run test:parity` since ADR-0240):

1. lists every Go `Test*`, `Example*`, `Fuzz*` and `Benchmark*` with `go test -list` (Tessera inside
   `.upstream/tessera`, the vendored modules from `fixtures/gen`, whose `go.mod` pins them), merged with a
   static scan of the `*_test.go` files, because `go test -list` runs the test binary and a `TestMain` that
   exits without its services (MySQL, the integration suite) lists nothing;
2. reads vitest's JSON report (it runs the unit suite itself unless given `--report`);
3. counts a Go test as ported when a *passing* TypeScript test in the mapped directory carries its name as a
   title or an enclosing describe title (exactly, or followed by ` `, `/`, `:` or `(`); `storage/posix` maps to
   `src/storage/objectstore` as well, where its tests live with the engine (ADR-0100);
4. fails on a missing or failing counterpart unless `scripts/test-parity-allowlist.json` names the test, or a
   glob covering it, with the ADR that decided it; fails on an allow-list entry that cites a missing ADR, matches
   nothing, or covers a test that has since been ported; and fails if the differential suites' divergence
   allow-list (ADR-0216) cites a missing ADR.

It compares top-level names only. Subtest names are not compared: Go builds many of them from data
(`range:0:15`), and the TypeScript tables keep the cases but not always the same rendering.

## Consequences

- A pin bump that adds upstream tests fails `test:parity` until they are ported or allow-listed with an ADR.
- The allow-list is the single list of upstream tests the port does not carry, with the reason for each.
- The job needs Go, the upstream checkout, and on its first run the Go module proxy (upstream's test packages
  import the cloud SDKs).

## Alternatives considered

- **Parse PORTING-MAP.md.** Rejected: it records files and counts, not names, and is written by hand.
- **Static scan only.** Rejected as the only source: `go test -list` is what Go itself considers a test (build
  tags, generated files); the scan complements it.
- **Compare subtests too.** Deferred: would need a per-package naming map; top-level parity is what PORTING.md
  requires.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
