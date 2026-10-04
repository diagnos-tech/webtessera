# ADR-0002: Mirror upstream file paths; map identifiers mechanically

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** lead maintainer
- **Upstream reference:** whole repository @ `4a6d9f9`

## Context

A port can optimise for one of two readers: someone who knows TypeScript and has never seen Tessera,
or someone who knows Tessera and is checking whether this port is faithful.

This project's stated goal is donation to transparency-dev. The second reader is the one who decides
whether that donation is accepted, and their question is not "is this nice TypeScript" but "does
this do what our code does". Everything about the file and naming scheme should serve them.

There is also a practical constraint: much of the porting work is delegated across many contributors. A
mechanical, stated mapping removes an entire category of drift — with a rule, `EntriesPathForLogIndex`
becomes `entriesPathForLogIndex` in every file; without one, it becomes
`getEntriesPathForLogIndex` in one file and `entryBundlePath` in another.

## Decision

**Paths and file names are identical to upstream**, including snake_case (`append_lifecycle.ts`,
`ct_only.ts`) and directory structure. Test files use the `_test.ts` suffix mirroring `_test.go`, and
Vitest is configured for that pattern rather than the usual `*.test.ts`.

**Identifiers map mechanically:**

| Go | TypeScript |
| --- | --- |
| exported type / struct / interface | unchanged (`Entry`, `HashTile`, `RangeInfo`) |
| exported const | unchanged (`TileWidth`, `CheckpointPath`) |
| exported func | camelCase (`NewEntry` → `newEntry`) |
| unexported func | camelCase, not exported (`fmtN` → `fmtN`) |
| struct field | camelCase (`RangeInfo.Index` → `.index`) |
| method | camelCase (`MarshalText` → `marshalText`) |
| sentinel error var | unchanged (`ErrPushback`) |

**Declaration order within a file is identical to upstream**, so the two files can be scrolled in
parallel.

Where a stdlib facility has no TypeScript equivalent, its shim lives under `src/internal/gostd/`
(`bytes.ts`, `errors.ts`, `sync.ts`, …). The directory name is deliberately unsubtle: a reviewer
opening it immediately knows these files replace Go's standard library and are not Tessera logic.

Ports of upstream dependencies that have no TypeScript equivalent (`merkle`, `sumdb/note`,
`formats/log`) live under `src/vendor/`, mirroring their own upstream paths, so they can be extracted
into standalone packages later without moving code.

## Consequences

- snake_case file names look wrong to a TypeScript reader on first contact. That cost is paid once,
  on first contact. The benefit — `diff <(ls upstream/api/layout) <(ls src/api/layout)` being empty —
  is paid on every review, forever.
- Functions are camelCase, so the mapping is not literally character-for-character. This is the one
  deliberate break from "identical names", and it is the *faithful* rendering: Go's PascalCase
  encodes visibility, which TypeScript expresses with `export`. A donated TypeScript library exposing
  `NewEntry()` reads as a machine translation and would be the first thing a reviewer asked us to
  change.
- Because the mapping is mechanical, reversing it is a codemod rather than a rewrite. If the
  transparency-dev reviewers prefer exact Go spelling, that is a cheap change.
- `_test.ts` is non-standard and required configuring Vitest's `include`. Worth it for the same
  parallel-scroll reason.

## Alternatives considered

- **Idiomatic TypeScript layout** (`src/log/append-lifecycle.ts`, `*.test.ts`, renamed functions).
  Rejected: optimises for the reader who matters least here, and makes fidelity unverifiable by
  inspection.
- **Exact Go spelling for functions too** (`NewEntry`, `EntriesPathForLogIndex`). Rejected: see
  Consequences. Genuinely arguable, and cheap to reverse if upstream asks.
- **Flatten `src/vendor/` into the main tree.** Rejected: it would hide that this code is a port of
  *someone else's* library with its own upstream, licence, and update cadence.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - The Decision is a set of checkable claims, so I checked them mechanically against the pinned tree
    rather than reading a sample.
  - Paths. For each of the 106 `.go` files of `.upstream/tessera` (`4a6d9f9`), I derived the mirrored
    `src/` path (`x.go` to `x.ts`, `x_test.go` to `x_test.ts`) and tested for it. Every file outside the
    deliberately unported trees (`cmd/`, `integration/`, `internal/hammer/`, `storage/{aws,gcp,mysql,posix}/`)
    exists, except the five `otel.go` / `cast.go` files that ADR-0051, ADR-0061, ADR-0070, ADR-0080 and
    ADR-0134 record as not ported. `storage/posix/files.go` has a counterpart at a different path by
    ADR-0100.
  - Identifiers. For every non-test Go file that has a TypeScript twin, I extracted each top-level
    `func`, each method and each `type`, and looked for the camelCase name (types: the exact name) in the
    twin. The only name not found is the method `sample` of `append_lifecycle.go`, which fed the metrics
    ADR-0181 deletes. So the mapping table holds across `api`, `client`, `fsck`, `ctonly`,
    `internal/*`, `storage/internal`, `testonly` and the root package.
  - Declaration order. For the same pairs I took the top-level `func` and `type` declarations in Go
    order and located their definitions in the TypeScript file. No file has two of them in a different
    relative order. This is the claim that costs the most to keep and I expected a violation; there is none.
  - Test naming. `vitest.config.ts` includes `src/**/*_test.ts` and its comment gives the same reason as
    this ADR; the browser, workers and services suffixes are layered on top without changing the
    pattern.
  - Vendoring. `src/vendor/merkle/{rfc6962,compact,proof,testonly}`, `src/vendor/note/note.ts` and
    `src/vendor/formats/log` have the file names of `merkle@v0.0.2`, `golang.org/x/mod@v0.31.0/sumdb/note`
    and `formats@v0.0.0-20251017110053-404c0d5b696c/log` in the Go module cache. The one place where a file
    does not mirror is `merkle/testonly/reference.ts` + `reference_test.ts` for Go's single
    `reference_test.go`, and that split is argued in ADR-0010.
  - Challenge. (1) "This is the one deliberate break from identical names" is true of the mapping rule,
    but the repository has since recorded other, narrower renames (`keyName` in ADR-0021, the `_` prefix
    in ADR-0010, `New` becoming `newList` in ADR-0090 and a class constructor in ADR-0011). They each carry their own ADR, so the rule is not
    contradicted, but a reader who takes this sentence literally will think there are none. Not blocking.
    (2) The vendoring paragraph names `merkle`, `sumdb/note` and `formats/log`; `src/vendor/formats/note`
    and `src/vendor/formats/proof` have since joined them (PORTING.md lists them, ADR-0071 and ADR-0224
    argue them). The principle stated here covers them. (3) The decision to reject "exact Go spelling for
    functions" is described as arguable and cheap to reverse; I agree with both, and with taking the
    camelCase side on the grounds the ADR gives, which is also what PORTING.md section 3.2 enforces.
