# ADR-0224: Port transparency-dev/formats `proof` (C2SP tlog-proof) from formats v0.1.1, with canonical base64

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** DX guardrails contributor
- **Upstream reference:** `github.com/transparency-dev/formats/proof/tlog_proof.go` and `tlog_proof_test.go` @
  `v0.1.1` (Go module cache); C2SP `tlog-proof.md` @ C2SP/C2SP `625d8db`

## Context

The safe API's receipts must prove offline that an entry is in a log (ADR-0225). C2SP specifies exactly that
format, [tlog-proof](https://c2sp.org/tlog-proof): a header line, optional base64 `extra` data, the entry's
index, the RFC 6962 inclusion proof one hash per line, a blank line, and the log's signed checkpoint verbatim,
with any witness cosignatures. transparency-dev, the organisation behind Tessera, implements it in its `formats`
module as package `proof` (`TLogProof`, with `Marshal` and `Unmarshal`).

That package postdates the `formats` version Tessera pins (`v0.0.0-20251017110053-404c0d5b696c`, which this
repository ports `log` and `note` from). It first appears in a tagged release in `v0.1.1`, which is in the Go
module cache.

Go's decoder is more lenient than the spec in places, recorded here from running v0.1.1 under Go 1.25:

- It decodes base64 with `base64.StdEncoding`, which accepts non-zero padding bits and skips `\r` and `\n`; the
  spec says "decoders MUST reject non-canonical encodings".
- It accepts an index with leading zeros (`index 007`), CRLF line endings (bufio's `ScanLines` drops a `\r`
  before each newline, including the checkpoint's), a checkpoint without a final newline (it appends one), and
  a proof with no blank line and no checkpoint.

## Decision

- Port `tlog_proof.go` to `src/vendor/formats/proof/tlog_proof.ts` and `tlog_proof_test.go` to
  `tlog_proof_test.ts` with every upstream case (`TestMarshal`, `TestUnmarshalErrors`, `TestRoundTrip`), under
  the Apache header of the upstream file (Google LLC, 2026). Publish it as `webtessera/formats/proof`, barrel
  `src/vendor/formats/proof/index.ts`. Error texts are Go's.
- **Harden only where the spec states a decoder requirement.** After each base64 decode Go accepts, check that the
  input is the canonical encoding of what it decoded to, and throw "tlog proof extra data not canonically base64
  encoded" or "tlog proof hash not canonically base64 encoded" otherwise. Everything Go rejects is rejected first,
  with Go's error. Go's other leniencies, which no decoder requirement forbids and which cannot change what a
  verified proof proves (the index is bound by the inclusion proof, the checkpoint by its signatures), are kept,
  and pinned by tests that record Go's output for each.
- Port-specific guards, as elsewhere in the port: the index must be a uint64 (ADR-0207), `marshal` refuses a hash
  that is not 32 bytes (Go's `[32]byte` cannot hold one), `unmarshal` assigns nothing on failure, and returns
  copies rather than views of its input.
- Add `src/internal/gostd/bufio.ts`, a `Scanner` that stands in for `bufio.NewScanner(bytes.NewReader(p))` with
  `ScanLines` (line splitting, `\r` dropping, the final unterminated line, `ErrTooLong` at 64 KiB), with tests.
  `tlog_proof.go` drives its scanner statefully (`Scan` then `Text`, including after a failed `Scan`), which the
  port follows line for line. `src/witness.ts` has a private generator with the same line semantics; switching
  it to the shared `Scanner` is a follow-up that touches a ported root-package file and is left to its owner.

## Consequences

- `formats` is now ported from two versions. A later bump of the pin to v0.1.1 or beyond would let the generator
  produce golden fixtures for `proof` and should be checked against `log` and `note` at the same time.
- **No golden fixture yet.** `fixtures/gen` builds against the pinned `formats`, and Go modules cannot hold two
  versions of one module, so a generator case would mean moving the whole generator to v0.1.1. Until the
  maintainers decide that, the evidence is the ported upstream test cases plus Go-recorded vectors for every
  lenient edge in `tlog_proof_test.ts` ("matches Go on its lenient edges").
- A proof Go accepts with non-canonical base64 is refused here. The spec requires that, and an encoder that
  follows it, Go's included, never produces one.
- The spec is an editor's copy without a version tag ("main", rendered 2026-10-01). ADR-0225 records what that
  means for receipts.

## Alternatives considered

- **Design a receipt format of our own.** Rejected: a C2SP specification exists and its reference implementation
  is from the same organisation as Tessera; inventing a format would contradict PORTING.md §1.
- **Write a decoder from the spec alone.** Rejected: porting transparency-dev's implementation keeps the port's
  rule that byte-producing code is a translation, and its tests come with it.
- **Follow Go exactly, non-canonical base64 included.** Rejected: the spec states it as a decoder MUST, and a
  stricter decoder cannot reject anything a conforming encoder produces.
- **Reject everything the spec's grammar excludes** (leading zeros, CRLF, a missing final newline). Rejected for
  now: none is a decoder requirement, Go accepts each, and a receipt that crossed a CRLF-converting transport
  still verifies in Go; the choice can be revisited if the spec adds decoder requirements.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending

## Update (2026-10-04): `witness.ts` uses the shared `Scanner`

The follow-up named above is done: `newWitnessGroupFromPolicy` (`src/witness.ts`) reads its policy with
`Scanner` from `src/internal/gostd/bufio.ts` instead of a private `scanLines` generator, `scanner.scan()` /
`scanner.text()` in the loop and `scanner.err()` thrown after it, which is `witness.go` line for line. The
two had the same splitting, `\r` dropping, final-line and 64 KiB rules, and the same error text; the only
difference is where the error is raised (after the loop, as Go returns `scanner.Err()`, rather than from
inside it), which changes nothing observable because nothing runs between the long line and the end of the
loop. The error is now the shared `ErrTooLong` sentinel, unwrapped. `witness_policy_test.ts` (its line-length
cases, plus two asserting the sentinel's identity and that nothing after the long line is parsed),
`witness_test.ts` and the differential corpus in `root_differential_test.ts` pass unchanged.
