# ADR-0078: `witness.go`'s URL handling — a scoped `path.Join`/`Clean` stand-in for `url.URL.JoinPath`

- **Status:** accepted; superseded in part by [ADR-0241](0241-witness-policy-urls-parsed-as-go-parses-them.md) (2026-10-04)
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

## Update (2026-10-02)

The URL handling described above was changed, and one statement in it was wrong:

- **The URL is kept as written.** Go's `url.Parse` followed by `JoinPath(...).String()` keeps a
  witness URL as written apart from lower-casing the scheme: `https://EXAMPLE.com:443/x` becomes
  `https://EXAMPLE.com:443/x/add-checkpoint`. Passing the string through the platform `URL` type
  lower-cased the host and dropped the default port. `newWitnessGroupFromPolicy` now keeps the
  string, and `urlJoinPath` works on it directly: it lower-cases the scheme, keeps the authority,
  query and fragment, and joins the path the way `JoinPath` does (including keeping one trailing
  slash). `newWitness`, whose signature takes a `URL`, joins onto `witnessRoot.href` the same way.
  Port additions in `witness_policy_test.ts` and `witness_test.ts` pin the results against Go's
  output for the same inputs.
- **Relative URLs are still rejected**, now together with absolute URLs that have no `//`
  authority (`https:example.com`), which Go parses as opaque and renders without the joined path.
  The platform parser (`URL.canParse`) is used only for that check. Go's own check for control
  characters runs first, with Go's error text.
- **Correction:** the Consequences said a relative witness URL "throws a `TypeError` from the
  `URL` constructor". It did not: the constructor's `TypeError` was caught and rethrown as
  `invalid witness URL "...": <message>`, with a message that differed between runtimes. The
  error is now `invalid witness URL "<url>": parse "<url>": not an absolute URL with a "//"
  authority`, the same everywhere, wrapping its cause with `wrapError` as Go wraps with `%w`.
- **Still not reproduced:** Go re-escapes a path, userinfo, host or fragment that is not validly
  percent-encoded (non-ASCII bytes, for example) and rejects some malformed URLs the platform
  parser accepts (an invalid escape such as `%zz`, an invalid character in the host) with its own
  error text. This port keeps such bytes as written and relies on the platform parser's
  acceptance.
- `goPathJoin` now ignores empty elements, as `path.Join` does.
- Witness URLs are additionally restricted to https, or http to a loopback host, by ADR-0185.

## Update (2026-10-04): superseded in part by ADR-0241

The final fidelity audit found that the 2026-10-02 update recorded only part of what the platform parser did to policy
URLs: `URL.canParse` also rejected URLs Go accepts (ports above 65535, IPv6 zones, IPv4-like numeric hosts, empty
hosts, `<` and `>` in hosts), its one message replaced `url.Parse`'s own errors, and URLs Go rejects (`%zz`,
`https://ü@example.com/`) were accepted. [ADR-0241](0241-witness-policy-urls-parsed-as-go-parses-them.md) replaces the
URL handling of this ADR: `src/internal/gostd/url.ts` transcribes Go's `url.Parse`, `JoinPath` and `String` (with
`path.Join`/`path.Clean`), so a policy URL gets Go's verdict, error text and endpoint byte for byte, escaping included,
and `urlJoinPath`, `goPathJoin`, `goPathClean` and the absolute-URL check are gone. What remains of this ADR is its
context. The ADR-0216 entries `witness-url-absolute` and `witness-url-escaping`, which recorded the behaviour this ADR
described, are retired; ADR-0241 records the URLs the port still refuses, and why.
