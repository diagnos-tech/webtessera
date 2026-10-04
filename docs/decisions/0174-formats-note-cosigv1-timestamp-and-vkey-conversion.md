# ADR-0174: Port `VKeyToCosignatureV1` and `CoSigV1Timestamp`, returning the timestamp as bigint seconds

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** http/witness/mirror agent
- **Upstream reference:** `github.com/transparency-dev/formats/note/note_cosigv1.go`, `note_cosigv1_test.go` @ `v0.0.0-20251017110053-404c0d5b696c`; amends ADR-0071

## Context

ADR-0071 ported only the cosignature/v1 signer and verifier constructors. The witness server
(ADR-0171) needs two more functions from the same file: `VKeyToCosignatureV1`, to publish the witness's
public key in the `0x04` form policies name, and `CoSigV1Timestamp`, to keep its cosignature timestamps
monotonic. A fidelity audit of the extended file also found: `CoSigV1Timestamp` returns `time.Time`
built with `time.Unix(int64(u), 0)`, which accepts any int64, while a JavaScript `Date` is limited to
±8.64e15 ms (year 275760), so a `Date` turns large timestamps into Invalid Date, which compares false
with everything; and `formatCosignatureV1` split the whole message just to count lines, on every
verification.

## Decision

- Port `VKeyToCosignatureV1` → `vKeyToCosignatureV1` (AGENTS §3.2's mechanical camelCase of
  `VKeyTo...`) and `CoSigV1Timestamp` → `coSigV1Timestamp`, with `keyHashSize`, `errInvalidHash` and
  `errMalformedSig`, in upstream order.
- `coSigV1Timestamp` returns the int64 Go passes to `time.Unix`, as a `bigint` of seconds
  (`BigInt.asIntN(64, ...)`): lossless, and a field of 2^63 or more reads negative exactly as in Go.
  Consumers decide what out-of-range means (the witness refuses non-positive timestamps explicitly).
- `formatCosignatureV1` counts newline bytes, stopping at two, instead of splitting
  (`len(Split) < 3` ⇔ fewer than two newlines). Port note in place.
- Tests: `TestCoSigV1Timestamp` (with expected values as bigint) and `TestVKeyToCosignatureV1` ported;
  `TestCoSigV1NewVerifier`'s rows run against `newVerifierForCosignatureV1` (it calls the unported
  `NewVerifier` dispatcher upstream; every row reaches the same verdict), plus port additions pinning
  that the key-hash field is only length-checked, the full int64 range of the timestamp field (0, 2^31,
  2^53, 2^63−1, 2^63, 2^64−1), and the three-line boundary.
- `webtessera/witness` re-exports `newSignerForCosignatureV1`, `newVerifierForCosignatureV1`,
  `vKeyToCosignatureV1` and `coSigV1Timestamp`, because the exports map has no `./formats/note` entry
  and a witness cannot be configured without them.

## Consequences

- `note_verifier.go` and `note_rfc6962.go` remain unported (ADR-0071 stands for them).
- If a `./formats/note` entry point is added, the witness barrel's re-exports can stay as conveniences.
- `newVerifierForCosignatureV1` calls `note.ts`'s `checkEd25519PublicKey` at construction, refusing
  small-order and non-canonically encoded keys as `newVerifier` does (docs/decisions/0206); Go accepts
  them. Port note in place, with tests for both key algorithms (1 and 4).

## Alternatives considered

- **Return a `Date`, as `time.Time`'s usual mapping.** Rejected: lossy and silently invalid beyond year
  275760, which defeated the witness's timestamp guard in the audit.
- **Return seconds as `number`.** Rejected: loses precision above 2^53.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `formats/note/note_cosigv1.go` at v0.0.0-20251017110053-404c0d5b696c (module cache) against `src/vendor/formats/note/note_cosigv1.ts`: `VKeyToCosignatureV1` checks in Go's order (parts and base64 and name and length: malformed verifier id; algorithm 1: unknown verifier algorithm; `ParseUint(hash16, 16, 32)`: invalid key hash; hash comparison: invalid key hash; key length 32: malformed verifier id) and formats `%s+%08x+%s`; `CoSigV1Timestamp` returns the int64 Go gives `time.Unix` as a bigint (`BigInt.asIntN(64, ...)`), with errMalformedSig and errVerifierAlg in Go's cases. The reasoning for bigint over `Date` is right (a `Date` cannot hold Go's range). `formatCosignatureV1`'s newline counting is equivalent to `len(bytes.Split(msg, "\n")) < 3` (n pieces need n-1 separators; the empty message is one piece), and the Port note says so.
  - Tests: all 7 Go test functions of `note_cosigv1_test.go` have TypeScript counterparts, with the same values (`TestCoSigV1Timestamp`'s signature gives 1727964367; `TestVKeyToCosignatureV1` opens a cosigned note with both vkeys and refuses the standard one). The ADR is right that `TestCoSigV1NewVerifier` calls the unported `NewVerifier` dispatcher upstream; the rows run against `newVerifierForCosignatureV1` reach the same verdicts, and every one of the 7 upstream rows plus the two port additions behaves as listed. Port additions pin the int64 extremes (0, 2^31, 2^53, 2^63-1, 2^63, 2^64-1), the three-line boundary and the byte-measured hash field. Passed in my runs.
  - The Consequences hide a behavioural divergence in one bullet: `newVerifierForCosignatureV1` calls `checkEd25519PublicKey` and so refuses small-order and non-canonical keys, which Go accepts (a small-order key verifies signatures nobody made, so for a witness key that would let anyone forge its cosignatures; ADR-0206 is the precedent). It is documented, in a Port note and with tests for key types 1 and 4, so I approve it, but it deserves to be in the Decision rather than the Consequences; no change requested.
  - Alternatives hold. Status: proposed becomes accepted.
