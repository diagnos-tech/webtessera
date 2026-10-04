# ADR-0001: Scope — which upstream modules get ported

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** lead (human-directed)
- **Upstream reference:** whole repository @ `4a6d9f9`

## Context

Upstream Tessera is ~16k lines of non-test Go plus ~8k lines of tests, spread over the root package,
`api/`, `internal/`, `storage/` (four cloud/POSIX drivers), `client/`, `fsck/`, `ctonly/`, `cmd/`
(binaries), and `internal/hammer` (a load generator with a terminal UI).

Not all of it is meaningful in a browser or on the edge, and a port that silently drops things is
worse than one that drops them loudly. The human's instruction is explicit: **everything is in scope
by default, and each exclusion must be argued case by case and signed off by both the implementing
agent and the reviewer agent.**

## Decision

1. **Default is: port it.** Omission requires its own ADR, not a line in this table.
2. This table is the register of the argument's *state*, not the argument itself. A row marked
   `pending` means no agent has yet made the case either way; nobody may act on it.
3. The reviewer agent for a work package owns challenging that package's rows. A row moves out of
   `pending` only when an ADR exists **and is signed** in its `## Review` section.
4. Where a module is excluded, the ADR must state what capability is lost and what replaces it.

### Register

| Upstream module | Disposition | ADR | State |
| --- | --- | --- | --- |
| root package (`entry.go`, `log.go`, `lifecycle.go`, `append_lifecycle.go`, `await.go`, `antispam.go`, `witness.go`, `migrate*.go`, `ct_only.go`, `otel.go`) | port | — | accepted |
| `api/`, `api/layout/` | port | — | accepted |
| `internal/parse`, `internal/future`, `internal/otel`, `internal/fetcher`, `internal/migrate`, `internal/witness` | port | — | accepted |
| `storage/internal/` (`integrate.go`, `queue.go`, `tileid.go`) | port | — | accepted |
| `client/` | port | — | accepted |
| `ctonly/` | port | — | accepted |
| `testonly/` | port | — | accepted |
| vendored `merkle/{rfc6962,compact,proof,testonly}` | port into `src/vendor/` | ADR-0002 | accepted |
| vendored `formats/log` | port into `src/vendor/` | ADR-0002 | accepted |
| vendored `golang.org/x/mod/sumdb/note` | port into `src/vendor/` | ADR-0002 | accepted |
| `fsck/` (`fsck.go`, `status.go`) | port as a library | — | accepted |
| `cmd/fsck/tui/`, `cmd/fsck/internal/tui/` | not ported — terminal UI (bubbletea/lipgloss), no meaning without a real TTY | ADR-0093 | not ported |
| `cmd/fsck/main.go` | not ported — CLI flag parsing / process wiring around `fsck.New`/`.Check`; `Fsck.check()`/`.status()` themselves are fully ported as a library | ADR-0093 | not ported |
| `storage/posix/` | `files.go` ported as the ObjectStore engine; `file_ops.go`, `otel.go` and `antispam/` (Badger) not ported | ADR-0141, ADR-0100 | accepted — ADR-0141 |
| `storage/gcp/`, `storage/aws/`, `storage/mysql/` (+ their `antispam/`) | not ported — server SDKs and databases; any object store plugs in through the `ObjectStore` contract | ADR-0141 | not ported — ADR-0141 |
| `internal/hammer/` (+ `loadtest/`) | not ported — a load-test command with a terminal UI, driving a log over HTTP | ADR-0141 | not ported — ADR-0141 |
| `cmd/conformance/*`, `cmd/examples/*`, `cmd/experimental/*` | not ported — binaries and personalities, whose role the examples play. `cmd/experimental/mirror/internal/mirror.go` is the exception: see the next row | ADR-0141 | not ported — ADR-0141 |
| `cmd/experimental/mirror/internal/mirror.go` | port as `src/mirror/` (`webtessera/mirror`), with S3-compatible sinks and verification of what it copies; `cmd/experimental/mirror/posix/main.go` stays not ported | ADR-0173, ADR-0175, ADR-0176 | accepted — ADR-0173 |
| `integration/`, `integration/fault/` | not ported as files — end-to-end coverage by `describeDriverConformance` on every backend, without fault injection | ADR-0141 | not ported — ADR-0141 |

### Additions upstream does not have

These are ours and each needs its own ADR before implementation, arguing that it is a faithful
*extension* of an upstream interface rather than a fork of upstream behaviour:

| Addition | Rationale sketch | State |
| --- | --- | --- |
| `storage/memory/` | The browser's equivalent of `storage/posix` — needed as the reference driver that the conformance suite runs against. | accepted — ADR-0141 (implemented: ADR-0100, ADR-0104, ADR-0106) |
| `storage/indexeddb/` | Level-1 persistence in a tab. | accepted — ADR-0141 (implemented: ADR-0110 to ADR-0113) |
| `storage/sqlite/` | Level-1 persistence on the server and the edge: any SQLite engine (node:sqlite, bun:sqlite, better-sqlite3, libSQL/Turso, rqlite, Cloudflare D1, SQLite-backed Durable Objects, sqlite-wasm), one adapter per engine. Replaces `storage/durableobject/`. | accepted — ADR-0141 (implemented: ADR-0150 to ADR-0155) |
| `http/` | Serving a log as the tlog-tiles read API, which upstream leaves to each personality. | accepted — ADR-0170 (implemented) |
| `witness/` | A tlog-witness server: the other half of the witness protocol whose client the root package ports. | accepted — ADR-0171, ADR-0172, ADR-0174 (implemented) |
| `storage/s3/` | Level-2 sync to an S3-compatible object store. | accepted — ADR-0141 (deferred; replicating a log into a bucket is now the S3 sink of `webtessera/mirror`, ADR-0175) |
| Application code outside the library (originally `src/adapters/**`) | Not part of this repository: the library never imports it, and it bolts onto the upstream interfaces from the outside. | accepted |

## Consequences

- Work is gated on argument, which is slower than a blanket cut. That is the point: the register
  makes every omission visible to a reviewer at the moment they open the repo, and a
  transparency-dev reviewer's first question will be "what did you leave out and why".
- The `pending` rows are the honest state of this port. They must not be quietly reclassified as
  "out of scope" by anyone's summary.

**Update (2026-10-02).** [ADR-0141](0141-dispose-of-the-remaining-scope-register-rows.md) proposes a
disposition for every register row above that was `pending`, and for the four additions, now that the
ObjectStore driver and its memory, IndexedDB and Durable Object backends exist to say what replaces what is
left out (rule 4). The State column reads `proposed — ADR-0141`, which is deliberately not `accepted`: under
rule 3 these rows stay undecided until that ADR's review is signed, and `docs/PORTING-MAP.md` keeps their
files at `pending ADR` until then (the four `storage/posix/` files that ADR-0100 already covers carry the
status that ADR gives them). ADR-0141 also finds that the `keygen/` entry names a directory that does not
exist at `4a6d9f9`. Everything else in this ADR is left as written, including the register's `otel.go` and
`internal/otel` entries, which read `port` and were later recorded as not ported in ADR-0080 and ADR-0134.

**Review of this update:** ADR review agent (independent), 2026-10-04. Verdict: approved. This Update is reviewed claim by claim in the Review section below, which
found it accurate as of its date; I re-checked what still holds today. `keygen/` does not exist at the pin (`ls` fails and `git ls-tree HEAD keygen` is empty), and
there is no `src/internal/otel/` and no `src/storage/internal/otel.ts`; ADR-0080 and ADR-0134 are accepted. Its statements that the State column reads `proposed — ADR-0141`
and that PORTING-MAP keeps the rows at `pending ADR` were true on the day and are replaced by the 2026-10-04 Update below.

**Update (2026-10-03).** The additions have changed since. `storage/sqlite/` replaces
`storage/durableobject/`: one `ObjectStore` over any SQLite engine, of which a SQLite-backed Durable Object
is one ([ADR-0150](0150-sqlite-object-store.md) to [ADR-0155](0155-sqlite-test-strategy.md)). It supersedes
ADR-0120 to ADR-0123, and `src/storage/durableobject/` no longer exists. Two modules with no upstream
counterpart were added, `http/` ([ADR-0170](0170-http-log-handler.md)) and `witness/`
([ADR-0171](0171-witness-server.md), [ADR-0172](0172-witness-state-on-objectstore.md) and
[ADR-0174](0174-formats-note-cosigv1-timestamp-and-vkey-conversion.md)). One upstream file in a row
that ADR-0141 proposes not to port is ported after all: `cmd/experimental/mirror/internal/mirror.go` is
`webtessera/mirror` ([ADR-0173](0173-mirror-port.md), [ADR-0175](0175-mirror-sinks.md),
[ADR-0176](0176-mirror-verification.md)). The rows above show the new state; the text of this ADR is
otherwise as written. Like ADR-0141, the new ADRs are proposed until their reviews are signed.

**Review of this update:** ADR review agent (independent), 2026-10-04. Verdict: approved. This Update is reviewed claim by claim in the Review section below, which
found it accurate as of its date; I re-checked what still holds today. `src/storage/durableobject/` does not exist and `src/storage/sqlite/` does; ADR-0120 to
ADR-0123 read `superseded by` ADR-0150, ADR-0152, ADR-0153 and ADR-0154; `package.json` exports `./http`, `./witness` and `./mirror` (and `./storage/sqlite`);
`cmd/experimental/mirror/internal/mirror.go` is `src/mirror/mirror.ts` (PORTING-MAP `done`). "The new ADRs are proposed until their reviews are signed" was true on the day;
ADR-0170 to ADR-0176 are accepted now, as the 2026-10-04 Update says.

**Update (2026-10-04).** ADR-0141 is accepted: its review is signed and approved. So are the ADRs the
register cites for the additions and for `mirror.go`: ADR-0100, ADR-0104, ADR-0106, ADR-0110 to ADR-0113, ADR-0150
to ADR-0155, and ADR-0170 to ADR-0176. Under rule 3 the rows that read `proposed — ADR-…` are decided, and the State
column now records the decision:
- the `storage/posix/` row, the `mirror.go` row and every addition read `accepted`;
- the cloud and MySQL driver rows, and the `internal/hammer/`, `cmd/*` and `integration/` rows, read `not ported`,
  with the ADR that decided them.

The Decision column no longer carries "proposed:". `docs/PORTING-MAP.md` moves the 40 files it kept at
`pending ADR` to `not ported`, with ADR-0141 in their notes. `cmd/experimental/mirror/internal/mirror.go` was
already `done`, and the four `storage/posix/` files carry ADR-0100's statuses. No register row is `pending` or
`proposed` any more.

**Review of this update:** ADR review agent (independent), 2026-10-04. Verdict: changes requested (two small items; most of it checks out).
Checked. ADR-0141 is `accepted` with an approved Review. Every ADR it names is `accepted` (ADR-0100, 0104, 0106, 0110 to 0113, 0150 to 0155, 0170 to 0176; ADR-0150 and ADR-0152
with their supersession notes for locking, ADR-0210). The register now reads `accepted — ADR-0141` for `storage/posix/` and the additions, `accepted — ADR-0173` for `mirror.go`, and
`not ported — ADR-0141` for the cloud and MySQL, hammer, `cmd/*` and `integration/` rows, with no "proposed:" left in the Decision column. Against `docs/PORTING-MAP.md` (107 rows, the 106 Go files
plus `keygen/main.go`): the 40 files that were `pending ADR` (posix antispam 3, aws/gcp/mysql 13, hammer 10, `cmd/` 12, `integration/` 2) are all `not ported` with "ADR-0141" in their notes; `mirror.go` is `done`; the four
`storage/posix/` rows carry ADR-0100's statuses (`files.go` and `files_test.go` `done`, `file_ops.go` and `otel.go` `not ported`); no row is `pending ADR`. Row by row, the register agrees with ADR-0141's Decision table
except for the two items below.
What must change. (1) `keygen/`. ADR-0141's table says "none: the row was a mistake", and its section 6 decides that the entry is withdrawn from the register "when ADR-0001 is next revised". This Update is that revision, and
the register still lists `keygen/` in the `cmd/*` row with State `not ported — ADR-0141`; PORTING-MAP's `keygen/main.go` row meanwhile says "ADR-0141 withdraws ADR-0001's `keygen/` row". Either remove `keygen/` from
that row (leaving the sentence in the 2026-10-02 Update, which is history) and say so here, or say here that it is kept, annotated, and correct ADR-0141 section 6 and the PORTING-MAP note. As written the
three disagree. (2) The Status line, which I may not edit, still reads "per-module rows marked *pending* are **not yet decided**"; with this Update no row is `pending`, so the maintainers should reduce it to "accepted".
Not blocking: `storage/s3/` reads `accepted — ADR-0141 (deferred; ...)` where ADR-0141 section 8 says to mark the row `deferred`, so the State column has no `deferred` value of its own. The Consequences' "the `pending` rows are the honest state of this port" is history.

## Alternatives considered

- **Declare the cloud drivers and `cmd/` out of scope up front.** It is very probably where each of
  those rows lands. Rejected as a *decision*: the human asked for the argument to be made and
  recorded per module, and "obviously irrelevant" is exactly the reasoning that loses a detail —
  e.g. `storage/posix/file_ops.go` encodes the crash-safety contract every driver must meet, which
  is relevant to the IndexedDB and Durable Object drivers whether or not POSIX itself is.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Scope of this review: the framework (the four rules and the register) and the two Updates. The
    exclusions themselves are argued, and reviewed, in the ADRs the register points at; this ADR only
    claims they exist.
  - Register against the pinned tree (`.upstream/tessera` at `4a6d9f9`, which `git log -1` confirms).
    All 106 `.go` files are accounted for: every file outside `cmd/`, `integration/`,
    `internal/hammer/`, `storage/{aws,gcp,mysql,posix}/` has a TypeScript file at the mirrored path,
    except the five `otel.go`/`cast.go` files, which are the ones ADR-0051, ADR-0061, ADR-0070, ADR-0080
    and ADR-0134 record as not ported. That is exactly what the Update of 2026-10-02 says about the
    `otel.go` and `internal/otel` rows ("read `port`, later recorded as not ported"), and it is true:
    there is no `src/internal/otel/`. The root-package row lists the right files (`entry.go`,
    `log.go`, `lifecycle.go`, `append_lifecycle.go`, `await.go`, `antispam.go`, `witness.go`,
    `migrate.go`, `migrate_lifecycle.go`, `ct_only.go`, `otel.go`), and the six `internal/*` packages
    named exist upstream. `keygen/` does not exist at the pin (`ls` and `git ls-tree` agree), so
    ADR-0141's finding quoted in the 2026-10-02 Update is right.
  - 2026-10-02 Update, claim by claim. The State column does read `proposed — ADR-0141` and not
    `accepted`; ADR-0141 is still `proposed`; `docs/PORTING-MAP.md` keeps the affected `cmd/`,
    `internal/hammer/`, `storage/posix/antispam/` rows at `pending ADR` with the proposal in `notes`;
    the four `storage/posix/` files that ADR-0100 covers (`files.go`, `files_test.go`, `file_ops.go`,
    `otel.go`) carry the status ADR-0100 gives them. The Update is accurate and its handling of rule 3 is
    the careful reading: it does not let a proposed ADR move a row.
  - 2026-10-03 Update, claim by claim. `src/storage/durableobject/` does not exist; `src/storage/sqlite/`
    does; ADR-0120 to ADR-0123 all read `superseded by ADR-0150` to `ADR-0154` as stated;
    `src/http/`, `src/witness/` and `src/mirror/` exist and are exported by `package.json`
    (`./http`, `./witness`, `./mirror`); ADR-0170 to ADR-0176 exist and are `proposed`, which is what
    "proposed until their reviews are signed" says. `cmd/experimental/mirror/internal/mirror.go` is
    ported as `src/mirror/mirror.ts` (PORTING-MAP: done), which is the one-file exception to ADR-0141's
    row that the Update describes.
  - Rule 4 ("state what capability is lost and what replaces it") is not satisfied by this ADR on its
    own, and does not claim to be; ADR-0141's Decision table has a Lost and a Replaced-by column for
    every excluded row, which is what rule 4 asks for. I checked that every non-ported row of the
    register is covered by a row of that table or by ADR-0093.
  - Challenge. (1) Only one alternative is recorded. A second one that deserves a line is "port the
    cloud drivers behind the `ObjectStore` contract rather than leave them out", which is what ADR-0141
    ends up arguing against per driver; recorded there, so not blocking. (2) The Status line and the
    Consequences bullet still speak of rows "marked *pending*", but no row of the register's State
    column reads `pending` any more (the Updates replaced them with `proposed — ADR-...`). That is
    history read against later updates, not an error; the 2026-10-02 Update says as much. (3) The
    Status `accepted (framework)` was set before this review. It is consistent with AGENTS.md section 6
    only now that the framework part is signed; the per-module rows remain exactly as undecided as the
    ADRs behind them.

## Update (2026-10-04, after review)

Answering the review of the 2026-10-04 Update above: the `keygen/` entry is withdrawn from the register's
`cmd/*` row, as ADR-0141 §6 decided (it named a directory that does not exist at the pinned commit), so the
PORTING-MAP note "ADR-0141 withdraws ADR-0001's `keygen/` row" is now true. The Status line no longer mentions
*pending* rows: none remains, every row of the register carries a decided state.
