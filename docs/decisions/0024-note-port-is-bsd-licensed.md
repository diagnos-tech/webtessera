# ADR-0024: `src/vendor/note/` is BSD-3-Clause, not Apache-2.0, and the package must ship the Go LICENSE

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** note contributor
- **Upstream reference:** `golang.org/x/mod/sumdb/note/note.go`, `~/go/pkg/mod/golang.org/x/mod@v0.31.0/LICENSE`

## Context

Every Tessera file this port has touched so far carries an Apache-2.0 header, and PORTING.md §9's
template assumes it. `sumdb/note` does not:

```go
// Copyright 2019 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.
```

`golang.org/x/mod` is BSD-3-Clause. Tessera depends on it as a module, so Go's tooling records the
licence automatically and nobody has to think about it. A hand-port copies the code into *our*
repository, where nothing records it automatically.

BSD-3-Clause requires that redistributions in source form "retain the above copyright notice, this
list of conditions and the following disclaimer" — that is the full licence text, not just the
copyright line. The three-line header in the Go source is a pointer to a `LICENSE` file that exists
in the x/mod module and does not exist in this package.

This is not a formality for a codebase whose stated goal is donation to transparency-dev. A project
that accepts a contribution containing an unlicensed translation of Go Authors code has a problem,
and it is the kind of problem that is discovered late.

## Decision

**`src/vendor/note/note.ts`, `note_test.ts` and `example_test.ts` are BSD-3-Clause.** Their headers
keep the Go Authors copyright line and the BSD notice verbatim, with the MedDeck copyright added
below it — MedDeck holds copyright in the translation, distributed under the same terms:

```ts
// Copyright 2019 The Go Authors. All rights reserved.
// Copyright 2026 MedDeck LTDA. All Rights Reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.
//
// Ported from golang.org/x/mod/sumdb/note/note.go @ v0.31.0
```

They are **not** relicensed to Apache-2.0 and do not carry the Apache header.

`src/vendor/formats/log/` is unaffected: `github.com/transparency-dev/formats` is Apache-2.0 and
those files keep the Google LLC Apache header per PORTING.md §9.

**Outstanding obligation.** The package does not yet contain the BSD-3-Clause text that these
headers point at. Before this package is published or donated, it needs:

- `src/vendor/note/LICENSE` — a verbatim copy of
  `~/go/pkg/mod/golang.org/x/mod@v0.31.0/LICENSE`; and
- a note in the package README or `licenses` field recording that `src/vendor/note/` is
  BSD-3-Clause while the rest is Apache-2.0.

That is a repository-level decision about layout and packaging metadata, not one this work package
should make unilaterally, so it is recorded here as a `TODO(<owner>)` in `docs/PORTING-MAP.md`
rather than guessed at.

## Consequences

- The package is dual-licensed in practice: Apache-2.0 with one BSD-3-Clause directory. Consumers
  and any SPDX tooling need to be told, which is what the outstanding obligation above covers.
- A reviewer must not "tidy" `src/vendor/note/` by giving it the Apache header the rest of the tree
  has. The header difference is deliberate and this ADR is why.
- Donating this to transparency-dev is *easier*, not harder: upstream Tessera already depends on
  `golang.org/x/mod`, so the licence is one they already carry.

## Alternatives considered

- **Apply the Apache-2.0 header for consistency with the rest of the package.** Rejected: it is a
  relicensing of someone else's code, which we cannot do.
- **Do not port `sumdb/note`; find a TypeScript implementation of the note format.** Rejected under
  ADR-0001 — there isn't one, and a transparency log's signature verification is the last thing to
  take on trust from an unaudited third party.
- **Reimplement the format from the specification without reading the Go source.** Rejected: the
  doc comment at the top of `note.go` *is* the specification, so a clean-room reimplementation would
  read it anyway, and the result would be a less faithful port with the same provenance question.
- **Ship the LICENSE file now as part of this work package.** Rejected as out of scope: where the
  file goes and how `package.json` declares it affects the whole repository, and another contributor may
  already be shaping that.

## Review

- **Reviewer:** note reviewer (independent)
- **Verdict:** approved
- **Notes:**
  - Confirmed `src/vendor/note/note.ts`, `note_test.ts` and `example_test.ts` carry the BSD-style
    header (Go Authors copyright + BSD notice + MedDeck line), not the Apache header, matching the
    upstream `golang.org/x/mod` source. Confirmed `src/vendor/formats/log/*` correctly keep the
    Google LLC Apache-2.0 header, since `transparency-dev/formats` is Apache-2.0.
  - The outstanding obligation is real and correctly deferred: there is no
    `src/vendor/note/LICENSE`, and a verbatim copy of
    `~/go/pkg/mod/golang.org/x/mod@v0.31.0/LICENSE` plus `package.json`/README SPDX metadata is
    needed before donation. The `TODO(<owner>)` is present in `docs/PORTING-MAP.md` (shared with
    cryptobyte's ADR-0040). This is a genuine legal-hygiene item, not busywork; leaving it as a
    repository-level decision is the right call for this work package.

## Update (2026-10-02)

The outstanding obligation is resolved at the repository level, as anticipated above. The verbatim
Go licence text is `LICENSES/BSD-3-Clause-Go.txt`, `NOTICE` lists every Go-derived file group
(including `src/vendor/note/`), and `PORTING.md` §9 prescribes the header form. None of the decisions
above changed.

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. `LICENSES/BSD-3-Clause-Go.txt` is
byte-identical to `golang.org/x/mod@v0.31.0/LICENSE` (`diff` clean), and `Go-PATENTS.txt` sits beside it. `NOTICE` has a
"BSD-3-Clause sources (The Go Authors)" section that lists `golang.org/x/mod v0.31.0, package sumdb/note` with
`note.ts`, `note_test.ts` and `example_test.ts`, plus the other Go-derived groups. `PORTING.md` section 9 prescribes the header form
and says never to tidy it into an Apache one. `note.ts`, `note_test.ts` and `example_test.ts` carry that header (Go Authors line, MedDeck line, BSD
notice pointing at `LICENSES/BSD-3-Clause-Go.txt`); the other files in `src/vendor/note/` are not translations and carry the
Apache header. `package.json` `files` ships `LICENSE`, `LICENSES` and `NOTICE`, and the README's License section says the
Go-derived files are BSD-3-Clause, so the outstanding obligation (the licence text, and a note that the directory is
BSD) is met, at repository level and not in `src/vendor/note/LICENSE`. The Decision's header sample says "the LICENSE file"; the
files now say `LICENSES/BSD-3-Clause-Go.txt`, which is what the Update means by "PORTING.md section 9 prescribes the header
form". Not blocking: `package.json` still declares `"license": "Apache-2.0"`, so tooling that reads only that field is not
told that the package contains BSD-3-Clause files (an SPDX expression such as `Apache-2.0 AND BSD-3-Clause` would).
