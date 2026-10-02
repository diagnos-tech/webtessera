# ADR-0078: `witness.go`'s URL handling — a scoped `path.Join`/`Clean` stand-in for `url.URL.JoinPath`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate contributor
- **Upstream reference:** `witness.go`'s `NewWitness`, `NewWitnessGroupFromPolicy`'s `"witness"` case

## Context

`NewWitness` builds each witness's update endpoint with Go's `net/url` package:

```go
u := witnessRoot.JoinPath("/add-checkpoint")
```

`(*url.URL).JoinPath` joins further path elements onto an existing URL's path, cleaning the result
the way `path.Join`/`path.Clean` do (collapsing `//`, resolving `.`/`..`, preserving a single leading
`/`). The platform `URL` type (Node, browsers, workerd — every runtime this port targets) has no
equivalent method. `NewWitnessGroupFromPolicy`'s `"witness"` case also calls `url.Parse(witnessURLStr)`,
which — unlike the `URL` constructor's single-argument form — accepts relative references as well as
absolute ones.

## Decision

- `witnessURLStr` is parsed with `new URL(witnessURLStr)`, requiring an absolute URL. Every witness
  URL in `witness_test.go`/`witness_policy_test.go` (and realistically, every witness URL a policy
  file would name) is absolute; a relative witness URL would only make sense client-side, which
  `NewWitnessGroupFromPolicy`'s own Go doc comment explicitly says this function does not need to
  handle ("Strictly, the URL is optional so policy files can be used client-side ... we'll ignore that
  special case here").
- `src/witness.ts` adds a small, module-local `urlJoinPath(u, ...elem)` plus `goPathJoin`/`goPathClean`
  helpers that reproduce exactly the subset of `path.Join`/`path.Clean` semantics `JoinPath` uses
  internally (join with `/`, drop empty/`.` segments, resolve `..` against a rooted path). This is
  **not** a general port of Go's `path` package — no other file in this port needs one — scoped
  narrowly to the one call site (`newWitness` joining `/add-checkpoint` onto a witness root that may
  itself already carry a path prefix).

## Consequences

- `TestWitnessGroup_URLs` (`witness_test.ts`) exercises this directly: a bare root
  (`https://witness.example.com/` → `.../add-checkpoint`), a root with an existing path prefix
  (`https://b1.example.com/wit1prefix/` → `.../wit1prefix/add-checkpoint`), and duplicate witnesses
  across nested groups collapsing to the same URL — all pass, which is the concrete evidence this
  reimplementation matches `JoinPath`'s behaviour for every shape this port's witness URLs take.
- A policy file naming a genuinely relative witness URL (unusual, and explicitly out of scope per
  `NewWitnessGroupFromPolicy`'s own doc comment quoted above) throws a `TypeError` from the `URL`
  constructor instead of parsing successfully the way Go's `url.Parse` would. No test in this
  codebase exercises that case.
- `goPathClean` does not implement every corner of Go's `path.Clean` (for example, it has no notion
  of Windows-style paths, irrelevant to a URL path). It is sufficient for, and scoped to, the rooted
  (`/`-prefixed) paths every `URL.pathname` this file constructs actually produces.

## Alternatives considered

- **A general-purpose `path.ts` gostd module.** Rejected as premature: nothing else in this port needs
  `path.Join`/`Clean`, and `PORTING.md` §3.5.1's "add it there with tests" instruction is for shims
  with more than one caller — a single-caller helper living next to its only caller is the more
  honest scope statement.
- **Accept relative witness URLs via a manual "does it start with a scheme" check, falling back to a
  base URL.** Rejected: adds real complexity and an invented resolution rule (which base?) for a case
  upstream's own doc comment says this function does not need to handle.
- **A string-concatenation shortcut** (`witnessRoot.toString().replace(/\/$/, "") + "/add-checkpoint"`)
  instead of a `path.Clean`-shaped join. Rejected: it does not correctly collapse a witness root whose
  path already contains internal double slashes or handle `.`/`..` segments the way `JoinPath`'s
  documented contract does, and would silently diverge from Go for policy files this port has not
  seen but a real deployment might.

## Review

- **Reviewer:** Witness/Migrate Reviewer
- **Verdict:** approved
- **Notes:** Checked `urlJoinPath`/`goPathJoin`/`goPathClean` against `witness.go`'s
  `witnessRoot.JoinPath("/add-checkpoint")` and Go's `path.Join`/`path.Clean` semantics.
  `goPathClean` correctly collapses `//`, drops `.`, resolves `..` against a rooted path, and
  preserves a single leading `/` for the absolute paths every `URL.pathname` here produces — the
  subset `JoinPath` uses. `TestWitnessGroup_URLs` exercises the three real shapes (bare root, root
  with an existing `/wit1prefix` path prefix, duplicate-witness collapse across nested groups) and
  all match Go's expected `.../add-checkpoint` outputs. The `new URL(witnessURLStr)` absolute-only
  requirement vs Go's relative-accepting `url.Parse` is a genuine narrowing, but `NewWitnessGroupFromPolicy`'s
  own doc comment explicitly says client-side/relative URLs are out of scope, and no test exercises
  a relative witness URL — acceptable and documented. Scoped single-caller helper, not a general
  `path` module — right call.
