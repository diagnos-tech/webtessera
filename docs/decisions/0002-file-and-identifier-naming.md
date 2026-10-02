# ADR-0002: Mirror upstream file paths; map identifiers mechanically

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** lead (human-directed)
- **Upstream reference:** whole repository @ `4a6d9f9`

## Context

A port can optimise for one of two readers: someone who knows TypeScript and has never seen Tessera,
or someone who knows Tessera and is checking whether this port is faithful.

This project's stated goal is donation to transparency-dev. The second reader is the one who decides
whether that donation is accepted, and their question is not "is this nice TypeScript" but "does
this do what our code does". Everything about the file and naming scheme should serve them.

There is also a practical constraint: much of the porting work is delegated across many agents. A
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

- **Reviewer:** _pending — foundational ADR, to be challenged by the first reviewer agent_
- **Verdict:** _pending_
- **Notes:**
