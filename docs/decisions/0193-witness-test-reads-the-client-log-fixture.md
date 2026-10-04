# ADR-0193: `internal/witness`'s tests serve the `client_log` fixture instead of a POSIX-backed reader

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity contributor
- **Upstream reference:** `internal/witness/witness_test.go` (`TestWitness_UpdateRequest`, `testLogTileFetcher`, `loadCheckpoint`)

## Context

Upstream's witness tests read tiles and checkpoints from the checked-in `testdata/log` directory.
`TestWitness_UpdateRequest` goes further: it opens that directory with `posix.New`, wraps it with
`tessera.NewAppender`, and passes the appender's `reader.ReadTile` as the gateway's tile fetcher.
No storage driver in this port reads a POSIX directory, and `testonly.newTestLog` builds a fresh
log with its own key, so neither can serve that particular log, whose checkpoints and expected
consistency-proof lines the test asserts byte for byte.

## Decision

The tests serve the `client_log` fixture (`fixtures/gen/client.go` reads `testdata/log` back,
ADR-0065) through an in-test `TileFetcherFunc`, for every test including
`TestWitness_UpdateRequest`. A reader over the same directory would return the same bytes for the
same 15-entry log. The fake witness in `TestWitness_UpdateRequest` keeps upstream's checks: it
splits the request body at the first blank line, as `bytes.Cut` does, fails on a body without one,
and parses and verifies the checkpoint after it with the log's verifier before signing its text.

## Consequences

- `TestWitness_UpdateRequest` does not exercise an appender's reader; the reader is covered by the
  storage driver's own suites.
- The expected request bodies are upstream's literals, unchanged.

## Alternatives considered

- **Build the log with `newTestLog` and recompute the expected bodies.** Rejected: the expected
  proof lines are upstream's own test vectors; recomputing them with the code under test would
  make the test circular.
- **Add a read-only POSIX-directory driver for tests.** Rejected: test tooling with no use beyond
  this one case, and Node-only.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `internal/witness/witness_test.go` loads `loadCheckpoint(t, 9)` and `testLogTileFetcher` from `testdata/log`, and `TestWitness_UpdateRequest` wraps `posix.New("../../testdata/log/")` in `tessera.NewAppender` for its tile reader.
  - TS (`internal/witness/witness_test.ts`) serves the `client_log` fixture (checkpoints for sizes 0-15, the 15 partial tiles of a 15-entry log; `fixtures/gen/client.go` reads `.upstream/tessera/testdata/log`, ADR-0065). The expected bodies are upstream's literals (`old 6\nycRkk...`), and the fake witness splits at the first blank line, fails without one, and parses and verifies the checkpoint with the log verifier before signing. A POSIX reader over the same directory returns the same bytes for the paths requested, and none needs the partial-to-full fallback. The ADR's claim that `testonly.newTestLog` cannot serve this log (own key) is right, and recomputing the proof lines would indeed be circular.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
