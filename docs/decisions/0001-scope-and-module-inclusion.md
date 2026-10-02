# ADR-0001: Scope — which upstream modules get ported

- **Status:** accepted (framework); per-module rows marked *pending* are **not yet decided**
- **Date:** 2026-08-19
- **Author:** lead maintainer
- **Upstream reference:** whole repository @ `4a6d9f9`

## Context

Upstream Tessera is ~16k lines of non-test Go plus ~8k lines of tests, spread over the root package,
`api/`, `internal/`, `storage/` (four cloud/POSIX drivers), `client/`, `fsck/`, `ctonly/`, `cmd/`
(binaries), and `internal/hammer` (a load generator with a terminal UI).

Not all of it is meaningful in a browser or on the edge, and a port that silently drops things is
worse than one that drops them loudly. The maintainers' instruction is explicit: **everything is in scope
by default, and each exclusion must be argued case by case and signed off by both the implementing
contributor and the reviewer.**

## Decision

1. **Default is: port it.** Omission requires its own ADR, not a line in this table.
2. This table is the register of the argument's *state*, not the argument itself. A row marked
   `pending` means no contributor has yet made the case either way; nobody may act on it.
3. The reviewer for a work package owns challenging that package's rows. A row moves out of
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
| `storage/posix/` | proposed: `files.go` ported as the ObjectStore engine; `file_ops.go`, `otel.go` and `antispam/` (Badger) not ported | ADR-0141, ADR-0100 | proposed — ADR-0141 |
| `storage/gcp/`, `storage/aws/`, `storage/mysql/` (+ their `antispam/`) | proposed: not ported — server SDKs and databases; any object store plugs in through the `ObjectStore` contract | ADR-0141 | proposed — ADR-0141 |
| `internal/hammer/` (+ `loadtest/`) | proposed: not ported — a load-test command with a terminal UI, driving a log over HTTP | ADR-0141 | proposed — ADR-0141 |
| `cmd/conformance/*`, `cmd/examples/*`, `cmd/experimental/*`, `keygen/` | proposed: not ported — binaries and personalities, whose role the examples play; `keygen/` does not exist at the pinned commit | ADR-0141 | proposed — ADR-0141 |
| `integration/`, `integration/fault/` | proposed: not ported as files — end-to-end coverage by `describeDriverConformance` on every backend, without fault injection | ADR-0141 | proposed — ADR-0141 |

### Additions upstream does not have

These are ours and each needs its own ADR before implementation, arguing that it is a faithful
*extension* of an upstream interface rather than a fork of upstream behaviour:

| Addition | Rationale sketch | State |
| --- | --- | --- |
| `storage/memory/` | The browser's equivalent of `storage/posix` — needed as the reference driver that the conformance suite runs against. | proposed — ADR-0141 (implemented: ADR-0100, ADR-0104, ADR-0106) |
| `storage/indexeddb/` | Level-1 persistence in a tab. | proposed — ADR-0141 (implemented: ADR-0110 to ADR-0113) |
| `storage/durableobject/` | Level-1 persistence on the edge. | proposed — ADR-0141 (implemented: ADR-0120 to ADR-0123) |
| `storage/s3/` | Level-2 sync to an S3-compatible object store. | proposed — ADR-0141 (deferred) |
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

## Alternatives considered

- **Declare the cloud drivers and `cmd/` out of scope up front.** It is very probably where each of
  those rows lands. Rejected as a *decision*: the maintainers asked for the argument to be made and
  recorded per module, and "obviously irrelevant" is exactly the reasoning that loses a detail —
  e.g. `storage/posix/file_ops.go` encodes the crash-safety contract every driver must meet, which
  is relevant to the IndexedDB and Durable Object drivers whether or not POSIX itself is.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
