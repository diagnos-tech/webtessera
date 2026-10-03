# Documentation

Everything here exists to answer one question for a reviewer: *is this TypeScript what the Go
original does, and where it is not, why not?* Start with [`../AGENTS.md`](../AGENTS.md) for the
rules, and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the workflow.

| Path | What it is |
| --- | --- |
| [`PORTING-MAP.md`](PORTING-MAP.md) | The file-by-file status of the port: one row per upstream Go file. |
| [`compatibility.md`](compatibility.md) | How byte compatibility with Tessera is proven, per backend and in both directions, and how to reproduce it. |
| [`RELEASING.md`](RELEASING.md) | How a release is prepared, published to npm and GitHub Packages, and verified. |
| [`REVIEW-PROTOCOL.md`](REVIEW-PROTOCOL.md) | What a reviewer checks, in priority order, for ports, ADRs and pull requests. |
| [`guides/`](guides/) | Task-oriented guides for users of the package, starting with [the safe API](guides/safe-api.md). |
| [`decisions/`](decisions/) | Architecture decision records (ADRs): every divergence from Go and every file not ported. |
| [`notes/`](notes/) | Free-form analysis that is not (yet) a decision. |
| [`../fixtures/README.md`](../fixtures/README.md) | The golden fixtures: what they contain and how to audit them. |

## Architecture decision records

An ADR records one decision, why it was taken, what it costs and what else was considered. They live
in [`decisions/`](decisions/), are named `NNNN-kebab-title.md`, and start from
[`decisions/0000-template.md`](decisions/0000-template.md).

The rule is in `AGENTS.md` §6: **any divergence from Go, however small, and any upstream file left
unported, needs an ADR.** That is what makes the port auditable — a reviewer who finds a difference
between the TypeScript and the Go can look for the ADR that explains it, and a difference with no
ADR is a bug.

How to read them:

- **Start with 0001–0006.** They set the ground rules everything else builds on: scope
  ([0001](decisions/0001-scope-and-module-inclusion.md)), naming
  ([0002](decisions/0002-file-and-identifier-naming.md)), `uint64` as `bigint`
  ([0003](decisions/0003-uint64-as-bigint.md)), errors, `context.Context` and concurrency
  ([0004](decisions/0004-errors-context-and-concurrency.md)), the crypto library
  ([0005](decisions/0005-noble-not-webcrypto.md)) and the golden fixtures
  ([0006](decisions/0006-golden-fixtures-from-go.md)).
- **Status matters.** An ADR is in force only once someone other than its author has signed its
  `## Review` section. A superseded ADR is kept, marked, and points at its replacement.
- **They are historical.** An accepted ADR is not rewritten to match later thinking; it is
  superseded by a new one. Two small exceptions: private paths have been generalised, and a dated
  `Update` note may record that an open obligation has since been met, that a later ADR supersedes
  part of the decision, or that a count or a claim was wrong.
- **Numbers group by area**, because they were allocated in blocks as the port grew: roughly
  0001–0006 foundations, 0010s Merkle, 0020s `note` and the Go standard-library stand-ins, 0030s API
  and test conventions, 0040s CT, 0050s `storage/internal`, 0060s `client`, 0070s witness and
  migrate, 0080s append lifecycle, 0090s `list` and `fsck`, 0100s the ObjectStore storage engine and
  memory driver, 0110s IndexedDB, 0120s the Durable Object backend (superseded by the SQLite backend,
  where a Durable Object is one engine among several), 0130s the remaining root-package ports and the
  package barrel, 0140s testonly, the README check, scope disposition and shared locks, 0150s the
  SQLite backend, 0160s the compatibility suites (the golden suite for every backend, the `.state/`
  fixtures, the Go interop harness), 0170s the protocol modules (`http`, `witness`, `mirror`) and
  the `formats/note` additions they need, 0180s the fixes to the root package, 0190s the fixes to
  `client`, `fsck`, `storage/internal` and the witness client, 0200s hardening (input validation,
  fail-closed locks and publication, and the `merkle`, `note` and Go standard-library fixes that go
  with them), 0210–0213 the second security review's fixes (SQLite locking and fencing, the HTTP
  surface, rqlite and S3 requests). 0215–0219 are the differential tests and the test-parity check,
  0220–0227 the safe high-level API, and 0240 the move to Bun. New ADRs take the next unused number.
- **"Work package" and "wave"** in the older ADRs refer to the initial port's work plan, an internal
  coordination document that is not part of this repository. Read them as "the files this change
  covered".

## Reading the porting map

[`PORTING-MAP.md`](PORTING-MAP.md) lists every `.go` file in upstream Tessera at the pinned commit
with the TypeScript file that replaces it, a status, and a count of test cases on each side.

- **Status** is one of `done`, `in progress`, `not started`, `pending ADR` or `not ported`; the
  vocabulary and the rules for editing the table are at the top of the file. `not ported` always
  names the ADR that explains it.
- **Tests (TS/Go)** counts individual cases, so `48 / 48` means every upstream case has a
  counterpart. A TS count above the Go count means the port added cases, which the `notes` column
  says.
- Below the main table are the ports of Tessera's *dependencies* (`src/vendor/`, the Go
  standard-library stand-ins in `src/internal/gostd/`), the code this port adds (the storage
  backends, `webtessera/http`, `webtessera/witness` and `webtessera/mirror`), the golden-fixture
  coverage table, and the open items.
- Update it in the same pull request as the code it describes (`AGENTS.md` §4, step 5).

## Notes

[`notes/`](notes/) holds thinking that is not yet a decision: analysis, dead ends, and things the
tooling could not reach. Currently
[`fixture-coverage-gaps.md`](notes/fixture-coverage-gaps.md) records what the fixture generator
cannot cover and why. Put speculation there rather than in code comments; promote it to an ADR when
it becomes a decision.
