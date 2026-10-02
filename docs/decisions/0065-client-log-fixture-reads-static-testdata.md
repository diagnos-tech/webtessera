# ADR-0065: `client_log` fixture reads back upstream's static `testdata/log`, and exposes its signing key

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** client contributor
- **Upstream reference:** `client/client_test.go`, `testdata/build_log.sh`, `testdata/log/**`

## Context

`client/client_test.go` does not build a log itself. It reads a small, real, already-built
15-entry tlog-tiles log checked into the upstream repository at `testdata/log/` — 16
checkpoint snapshots (`checkpoint.0` .. `checkpoint.15`, one per growth step, plus the
final `checkpoint`), and the tile/entry-bundle files a real `cmd/examples/posix-oneshot`
run produced while building it. `testdata/build_log.sh` documents exactly how it was made,
including the literal signing key it used:

```sh
export LOG_PRIVATE_KEY="PRIVATE+KEY+example.com/log/testdata+33d7b496+AeymY/SZAX0jZcJ8enZ5FY1Dz+wTML2yWSkK+9DSF3eg"
export LOG_PUBLIC_KEY="example.com/log/testdata+33d7b496+AeHTu4Q3hEIMHNqc6fASMsq3rKNx280NI+oO5xCFkkSx"
```

That directory has no counterpart anywhere in this repository — TypeScript has no
`os.ReadFile`-against-a-relative-testdata-directory equivalent that would run identically
in a browser tab, and `PORTING.md` §5's fixture pipeline exists precisely to turn real
upstream byte output into something a TypeScript test can load. Every other `log_<N>.json`
fixture (`fixtures/gen/log.go`) is built by *driving* a fresh Tessera log to a target
size; `testdata/log` is different in kind — it is not rebuilt, it already exists, checked
in, at the pinned commit, and the whole point of `client_test.go`'s design is that this
exact log, exactly as built once by a human running `build_log.sh`, is what a port must
reproduce fetching against.

Separately, the mission brief for this work package (the original work plan's
Wave 2 client row) requires "`LogStateTracker`'s consistency-rejection path has an
explicit test — not just the happy path" (also stated directly in `PORTING.md`'s spirit of
testing error branches, per `docs/REVIEW-PROTOCOL.md` §2.1). Upstream's own
`TestCheckLogStateTracker` does not actually exercise this: every one of its four cases
feeds `LogStateTracker` checkpoints taken from the same real, honestly-grown log, so
`proof.VerifyConsistency` never fails in any of them — the "Out of order" case tests the
*not-newer* early-return, not `ErrInconsistency`. Constructing a validly-signed-but-wrong
checkpoint to reach `ErrInconsistency` requires the log's actual private key, which
`client_test.go` itself never needs (it only ever reads pre-signed files).

## Decision

- `fixtures/gen/client.go` is a new generator, added to this work package, that reads
  `testdata/log` back from the pinned upstream checkout (the same checkout
  `fixtures/gen/go.mod`'s `replace github.com/transparency-dev/tessera =>
  ../../.upstream/tessera` directive points at) and dumps it verbatim into
  `fixtures/data/client_log.json`: all 16 checkpoint snapshots, and every tile/entry-bundle
  file present. Nothing is computed or invented; every byte is read straight off disk,
  matching `PORTING.md` §5's "nothing in this program computes a hash, a path, or an
  encoding by itself" rule as closely as a *reading* generator can (as opposed to
  `genLogs`'s *building* generators).
- The fixture also carries `logSkey`: the private key from `testdata/build_log.sh`,
  copied verbatim. This key protects nothing — it is a throwaway key Google committed to
  the public upstream repository specifically so this exact log could be reproduced by
  anyone — and exposing it is what lets `client_test.ts` forge a checkpoint that is
  validly signed but claims a hash inconsistent with the real tree, and add the
  rejection-path test upstream's own suite does not have (see the "rejects a checkpoint
  whose hash is inconsistent" case in `client_test.ts`, called out explicitly in its own
  comment as not part of upstream).
- `client_test.ts`'s `testOrigin`/`testLogVerifier` are derived from the fixture's
  `origin`/`logVkey` fields rather than retyped as string literals, so the key material in
  the test can never silently drift from what the generator actually read off disk.

## Consequences

- `fixtures/gen/client.go` is a generator with no `genLogs`-style
  sibling anywhere else in this codebase yet — it is the first generator that *reads* a
  static upstream fixture rather than *building* one. A future reviewer comparing
  generators should expect this one kind of file to differ in structure (no
  `posix.New`/`tessera.NewAppender` call at all).
- `client_log.json` is tied to the exact bytes of upstream's `testdata/log` at the pinned
  commit. If upstream's `testdata/build_log.sh` output ever changes (a different entry
  set, a different key), regenerating this fixture picks that up automatically — there is
  nothing hand-maintained to fall out of sync.
- The rejection-path test is an addition beyond what a line-for-line port of
  `client_test.go` would produce. It is clearly marked as such in both the fixture
  generator's comments and the test's own comment, so a reviewer diffing test case names
  against Go's can see exactly which one has no upstream counterpart and why.

## Alternatives considered

- **Hand-copy the 16 checkpoint files' bytes as inline hex literals into `client_test.ts`.**
  Rejected: `PORTING.md` §5 forbids inventing or hand-transcribing fixture data outside the
  generator pipeline precisely because a hand-copy is exactly where a silent transcription
  error would hide; the generator reading the files directly is strictly safer and, since
  it is a `go run` away, no more effort to keep current.
- **Skip `TestCheckLogStateTracker`'s consistency-rejection coverage entirely, deferring
  to upstream's own (also incomplete) coverage.** Rejected: the mission brief for this
  specific work package requires this test explicitly, and "upstream doesn't test it
  either" is not a defence PORTING.md or the review protocol would accept — a
  transparency-log client's rejection path is exactly the kind of code a missing test
  would leave silently unverified.
- **Generate a *synthetic* forged checkpoint (a Note object with arbitrary sig bytes)
  instead of a real signature.** Rejected: it would test `verifyConsistency`'s wrapping in
  isolation but not `LogStateTracker.update`'s real call path, since a syntactically
  invalid signature would be rejected earlier, at `parseCheckpoint`, never reaching the
  consistency check this ADR is about exercising.

## Review

- **Reviewer:** Client Reviewer
- **Verdict:** approved
- **Notes:** Verified `fixtures/data/client_log.json` carries `origin=example.com/log/testdata`,
  `logVkey` byte-identical to `client_test.go`'s `testLogVerifier`, and `logSkey` matching
  `testdata/build_log.sh`'s `LOG_PRIVATE_KEY` (16 checkpoints, 15 tiles, 15 bundles) — so the key
  material is the real upstream throwaway keypair, not retyped, and nothing was hand-edited to suit
  the port. This is what makes the added rejection-path test honest: I confirmed the forged
  checkpoint is signed with `logSkey` (the log's real key), so `parseCheckpoint`'s signature check
  passes and the failure genuinely comes from `proof.VerifyConsistency`, not from a signature or
  parse short-circuit (a synthetic bad-sig checkpoint would be rejected earlier, exactly as
  alternative #3 notes). Agree upstream's own `TestCheckLogStateTracker` never reaches
  `ErrInconsistency`, so this addition closes a real coverage gap. Approved.
