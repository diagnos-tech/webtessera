# ADR-0187: `witness_test.ts` carries no Tessera copyright line, because upstream's file has none

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** root-package fidelity agent
- **Upstream reference:** `witness_test.go`

## Context

AGENTS.md §9 asks every port of an upstream Apache-2.0 file to keep "the upstream copyright year
and holder exactly as the original file has it", plus this project's own line. At the pinned
commit, `witness_test.go` is the only Go file in Tessera's root package without a header: it
starts directly with `package tessera_test`. The port had given it the
`Copyright 2025 The Tessera authors` line from `witness.go`, the file it tests, with a note saying
so.

## Decision

`src/witness_test.ts` carries this project's copyright line and the Apache-2.0 notice, a
`Ported from tessera/witness_test.go @ 4a6d9f9` line that names Tessera and points at NOTICE, and
a note explaining that upstream's file has no header and that none is invented for it. No Tessera
copyright line is attributed to a file whose authors did not write one.

## Consequences

- The file's provenance stays clear: the "Ported from" line names the source, and NOTICE
  attributes Tessera as a whole ("Copyright The Tessera authors; Copyright Google LLC") under
  Apache-2.0, which covers files with no header of their own.
- If upstream later adds a header to `witness_test.go`, the port should copy it at the next pin
  update.

## Alternatives considered

- **Keep the line borrowed from `witness.go`.** Rejected: it asserts a copyright year and holder
  that the upstream file does not state, which is what §9's "exactly as the original file has it"
  rules out.
- **Treat the file as wholly ours** (MedDeck line, no "Ported from"). Rejected: it is a
  translation of Tessera's test, and saying so is part of attributing it.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Checked every `.go` file in the pinned checkout's root: `witness_test.go` is the only one with no copyright header (it starts at `package tessera_test`).
  - `src/witness_test.ts` carries the MedDeck line, the Apache-2.0 notice, a `Ported from tessera/witness_test.go @ 4a6d9f9` line pointing at NOTICE, and a note that no upstream header exists. That is what AGENTS.md section 9 asks for ('exactly as the original file has it'), and NOTICE attributes Tessera as a whole. No script checks headers, so nothing else depends on the old borrowed line.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
