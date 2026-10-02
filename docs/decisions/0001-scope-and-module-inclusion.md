# ADR-0001: Scope — which upstream modules get ported

- **Status:** accepted (framework); per-module rows marked *pending* are **not yet decided**
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
| `storage/posix/` | **pending** | — | pending |
| `storage/gcp/`, `storage/aws/`, `storage/mysql/` (+ their `antispam/`) | **pending** | — | pending |
| `internal/hammer/` (+ `loadtest/`) | **pending** | — | pending |
| `cmd/conformance/*`, `cmd/examples/*`, `cmd/experimental/*`, `keygen/` | **pending** | — | pending |
| `integration/`, `integration/fault/` | **pending** | — | pending |

### Additions upstream does not have

These are ours and each needs its own ADR before implementation, arguing that it is a faithful
*extension* of an upstream interface rather than a fork of upstream behaviour:

| Addition | Rationale sketch | State |
| --- | --- | --- |
| `storage/memory/` | The browser's equivalent of `storage/posix` — needed as the reference driver that the conformance suite runs against. | pending |
| `storage/indexeddb/` | Level-1 persistence in a tab. | pending |
| `storage/durableobject/` | Level-1 persistence on the edge. | pending |
| `storage/s3/` | Level-2 sync to an S3-compatible object store. | pending |
| Application code outside the library (originally `src/adapters/**`) | Not part of this repository: the library never imports it, and it bolts onto the upstream interfaces from the outside. | accepted |

## Consequences

- Work is gated on argument, which is slower than a blanket cut. That is the point: the register
  makes every omission visible to a reviewer at the moment they open the repo, and a
  transparency-dev reviewer's first question will be "what did you leave out and why".
- The `pending` rows are the honest state of this port. They must not be quietly reclassified as
  "out of scope" by anyone's summary.

## Alternatives considered

- **Declare the cloud drivers and `cmd/` out of scope up front.** It is very probably where each of
  those rows lands. Rejected as a *decision*: the human asked for the argument to be made and
  recorded per module, and "obviously irrelevant" is exactly the reasoning that loses a detail —
  e.g. `storage/posix/file_ops.go` encodes the crash-safety contract every driver must meet, which
  is relevant to the IndexedDB and Durable Object drivers whether or not POSIX itself is.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
