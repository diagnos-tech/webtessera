# ADR-0224: Port transparency-dev/formats `proof` (C2SP tlog-proof) from formats v0.1.1, with canonical base64

- **Status:** accepted
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

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `proof/tlog_proof.go` and `tlog_proof_test.go` at formats v0.1.1 (Go module cache) against `tlog_proof.ts` and `tlog_proof_test.ts`, branch by branch: Marshal, every Unmarshal error and its order, nil-versus-empty extra data, the 32-byte hashes, the uint64 index. The three Go tests are ported with the same cases and values; the extra tests are labelled as beyond upstream.
  - Built a Go harness around the real `formats/proof` v0.1.1 (Go 1.25.5) and replayed 36,000 mutated proofs through it and through the port (bad and non-canonical base64, CR inside lines, CRLF, indices, truncation, lines around 64 KiB). 13,362 accepted by both with identical index, hashes, checkpoint bytes, extra data and `Marshal` output; 19,917 rejected by both with the same text; 2,609 accepted by Go and refused by the port only for non-canonical base64, the hardening the Decision adds; 112 differ only in how an invalid-UTF-8 or over-64-code-point index is quoted in the message (ADR-0203, ADR-0204; ADR-0216 entries). So "Error texts are Go's" needs "except where ADR-0203 and ADR-0204 apply" (non-blocking). Nothing else differs.
  - The lenient edges in the Context are true of Go (padding bits, CR inside a hash, leading-zero index, CRLF, no final newline, no blank line and no checkpoint): I ran Go on every vector that `tlog_proof_test.ts` labels as Go's (the lenient edges, the error texts and the "Go's error first" inputs; the marshal vector too) and its values are what Go returns.
  - Spec: fetched https://c2sp.org/tlog-proof and the main-branch markdown. "Encoders MUST generate canonical base64 ... and decoders MUST reject non-canonical encodings" is in the Conventions, so the hardening is the spec's requirement. Challenge recorded: the Format section also says the index is "an ASCII decimal with no leading zeroes" and gives every line shape as MUST; the ADR keeps Go's acceptance of `index 007`, CRLF and a missing final newline on the reading that only base64 has an explicit decoder requirement. That reading is defensible, the alternative is recorded and its "revisit if the spec adds decoder requirements" is the right exit. No change requested.
  - `NOTICE` lists the proof port and `bufio.ts`; `webtessera/formats/proof` is in `exports` and `tsconfig` paths. Not verified: the C2SP commit hash 625d8db (the session has no GitHub API access); the content hash matches ADR-0225's record, below.

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

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. `newWitnessGroupFromPolicy` now reads with `scanner.scan()` and `scanner.text()` and throws `scanner.err()` unwrapped after the loop, line for line as `witness.go` does (read side by side). `witness_policy_test.ts` has the length cases and the two added ones (sentinel identity; nothing after the long line is parsed). Policies built from 90,000 fresh URLs and replayed through Go's `NewWitnessGroupFromPolicy` and the port agree (ADR-0241 notes), and the differential corpus passes.

## Update (2026-10-04): the scanner's state machine is Go's, and canonicality errors come last

The final fidelity audit found two places where the code did not do what the Decision says.

- **"Everything Go rejects is rejected first, with Go's error"** did not hold. The canonical-base64 check threw as soon
  as a line Go accepts was non-canonical, before later lines Go rejects were read: `index 1`, a hash with a `\r` inside
  it, then `!!!` gave `tlog proof hash not canonically base64 encoded` where Go says `tlog proof hash not base64
  encoded: illegal base64 data at input byte 0`, and non-canonical extra data with no index line gave the extra-data
  message where Go says `tlog proof missing required index` (43 of the audit's 36,506 records). `unmarshal` now
  remembers the first non-canonical line, parses on exactly as Go does, and throws that error only once the parse,
  including the scanner's own error check, has finished without an error of Go's. `tlog_proof_test.ts` pins the
  audit's two inputs, a wrong hash length and a too-long line after non-canonical extra data, and that the first of
  two non-canonical lines is the one reported; the audit's corpus now shows no record where the canonicality error
  pre-empts Go's.
- **"Follows line for line"** did not hold for a scanner stopped by `ErrTooLong`. Go's `Scanner` is not done after
  that error: its next `Scan` hands `ScanLines` the buffered 64 KiB at EOF, returns true with them as a token (less a
  final `\r`), and only then returns false for good, which `tlog_proof.go`'s checkpoint loop reaches after its hash
  loop ended on the error. The stand-in stayed stopped. `src/internal/gostd/bufio.ts` now transcribes Go 1.25.5's
  `Scan`, `advance`, `setErr`, `ScanLines` and `dropCR` over an in-memory reader (the buffer starts at 4,096 bytes and
  doubles to `MaxScanTokenSize`, shifting unread bytes to the front as Go does), so every call, including those after
  a false, returns what Go's returns; the branches only a custom split function or a misbehaving reader can reach are
  left out, and listed in its header. `Bytes` is now a view of the scanner's buffer, as in Go, so `tlog_proof.ts`
  copies each checkpoint line, as Go's `checkpoint.Write` does. The file is a transcription of Go code and carries the
  Go Authors' BSD notice; `NOTICE` lists it. Neither caller's output changes: `TLogProof.unmarshal` still ends with
  `scanning tlog proof: bufio.Scanner: token too long`, and the policy parser still stops at its first false. On the
  audit's 20,000 inputs with lines around 64 KiB and eight `Scan` calls each, the stand-in now equals Go on every call.

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. `bufio.ts` against Go 1.25.5's `Scan`, `advance`, `setErr`, `ScanLines` and `dropCR`: the state machine matches, the omitted branches are unreachable for `ScanLines` over an in-memory reader, as the header says. Replayed 2,500 inputs (lines of 4,095 to 131,072 bytes; 930 end in ErrTooLong) through Go's `bufio.Scanner` over both a `bytes.Reader` and a `bytes.Buffer` and through the port, ten `Scan` calls each, comparing the result, the token's length and hash and `Err()` after every call: identical every time. In the 36,000-proof run above no record has the canonical-base64 error pre-empting an error of Go's, and `nonCanonical ??=` plus the throw after the `b.err()` check is the ordering the update describes; `tlog_proof.ts` copies each checkpoint line because `bytes()` is a view.
