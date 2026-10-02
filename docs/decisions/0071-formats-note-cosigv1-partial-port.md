# ADR-0071: Port only `formats/note`'s cosignature/v1 functions, not the whole package

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate contributor
- **Upstream reference:** `github.com/transparency-dev/formats/note/note_cosigv1.go`, `note_verifier.go`, `note_rfc6962.go` @ `v0.0.0-20251017110053-404c0d5b696c`

## Context

`witness.go`'s `NewWitness` calls `f_note.NewVerifierForCosignatureV1(vkey)`
(`github.com/transparency-dev/formats/note`, a *different* package from the already-ported
`golang.org/x/mod/sumdb/note` at `src/vendor/note/note.ts`) to build the `note.Verifier` a
`Witness` checks cosignatures against. `witness_test.go` and `internal/witness/witness_test.go` also
call `f_note.NewSignerForCosignatureV1(skey)` to build test signers that produce real cosignature/v1
signatures. Neither this work package's mission (`PORTING.md`'s file table for the witness/migrate
contributor) nor any prior wave lists `formats/note` — it is a new, previously-unported dependency
discovered while implementing `witness.go`, analogous to how `internal/migrate/migrate.go` turned out
to be a dependency of `migrate_lifecycle.go` (ADR-0076).

The full `formats/note` package is considerably larger than what `witness.go` needs:
`note_cosigv1.go` also has `VKeyToCosignatureV1` and `CoSigV1Timestamp`; `note_verifier.go` has a
general `NewVerifier` dispatcher, `NewEd25519SignerVerifier`, and a full ECDSA-over-SHA256 verifier
(`NewECDSAVerifier`) for Sigstore/Rekor compatibility; `note_rfc6962.go` (not read in full for this
ADR, but named in `docs/PORTING-MAP.md`'s scope discussion) verifies RFC 6962 STH-shaped signatures.
None of it is reachable from `witness.go`, `witness_test.go`, or `internal/witness/witness.go`/
`witness_test.go`.

## Decision

`src/vendor/formats/note/note_cosigv1.ts` ports exactly `NewSignerForCosignatureV1` →
`newSignerForCosignatureV1` and `NewVerifierForCosignatureV1` → `newVerifierForCosignatureV1`, plus
the private machinery they need: `formatCosignatureV1`, `verifyCosigV1`, `keyHashEd25519`,
`isValidName` (Go duplicates this function verbatim from `sumdb/note`; so does this port, in the same
file, for the same reason — see that function's own Port note), and the `Signer`/`verifier` structs.

**Not ported, with no file or symbol standing in for them:**

- `VKeyToCosignatureV1`, `CoSigV1Timestamp` (`note_cosigv1.go`) — no caller in scope.
- `NewVerifier`, `NewEd25519SignerVerifier`, `NewECDSAVerifier`, `keyHashECDSA` (`note_verifier.go`)
  — no caller in scope; `NewVerifier`'s algorithm-dispatch table exists to serve exactly the callers
  this ADR excludes.
- All of `note_rfc6962.go`.

`src/vendor/formats/note/note_cosigv1_test.ts` ports the 4 of `note_cosigv1_test.go`'s 8 test
functions that exercise only the ported functions (`TestSignerRoundtrip`,
`TestSignerVerifierRoundtrip`, `TestVerifierInvalidSig`, `TestSigCoversExtensionLines`).
`TestCoSigV1NewVerifier` and `TestVKeyToCosignatureV1` call `NewVerifier`/`VKeyToCosignatureV1`
directly; `TestCoSigV1Timestamp` calls `CoSigV1Timestamp`. None are ported.

`verifyCosigV1`'s Ed25519 check reuses `src/vendor/note/note.ts`'s `verifyEd25519` (exported
`@internal` for exactly this purpose — see that function's own doc comment) rather than
reimplementing RFC 8032/cofactorless verification a second time: both `formats/note` and
`sumdb/note` call the identical Go `crypto/ed25519.Verify` function, so the port sharing one
verification routine is *more* faithful than two independently-written copies risking divergence,
not less.

## Consequences

- `docs/PORTING-MAP.md` gains a new sub-table row group for `github.com/transparency-dev/formats/note`
  (a package with no prior row anywhere), marked to name this ADR and list exactly the two functions
  ported.
- If a future work package needs `NewVerifier`'s dispatch, `VKeyToCosignatureV1`, `CoSigV1Timestamp`,
  the ECDSA verifier, or RFC 6962 STH verification, it extends this same file/directory rather than
  creating a second, competing partial port — `src/vendor/formats/note/` is now the established
  location.
- A transparency-dev reviewer diffing `ls src/vendor/formats/note/` against
  `ls formats/note/` will see 4 upstream files with only 1 TS counterpart; this ADR is that gap's
  explanation, following the same pattern ADR-0040 (`cryptobyte`) and ADR-0064 (`FileFetcher`)
  already set for narrower-than-upstream vendor ports in this codebase.

## Alternatives considered

- **Port the whole `formats/note` package.** More complete and arguably more useful to a future
  caller. Rejected: `PORTING.md`'s TDD workflow (§4) requires porting a file's test alongside it, and
  `NewECDSAVerifier`/`NewVerifier`'s dispatch pull in `crypto/x509`/ASN.1-shaped parsing this work
  package has no test-driving need for and no time budget to verify byte-for-byte; a wider surface
  ported without upstream-test coverage is a liability, not a convenience.
- **Reimplement `verifyCosigV1`'s Ed25519 check independently of `note.ts`'s `verifyEd25519`.**
  Would keep this vendor directory fully self-contained. Rejected: it duplicates the exact
  cofactorless/zip215-false reasoning ADR-0025 already worked out once, and any future fix to that
  reasoning would need to be applied in two places instead of one.

## Review

- **Reviewer:** Witness/Migrate Reviewer
- **Verdict:** approved (with a review-added test)
- **Notes:** Diffed `src/vendor/formats/note/note_cosigv1.ts` line by line against upstream
  `note_cosigv1.go` @ `v0.0.0-20251017110053-404c0d5b696c` (read in full), and confirmed the
  three not-ported files (`note_verifier.go`'s `NewVerifier`/ECDSA, `note_rfc6962.go`) have no
  caller in `witness.go`/`witness_test.go`/`internal/witness/witness.go`. Every security-relevant
  detail matches: the 4-way `strings.Cut` on `+` (base64 key material keeps its internal `+`
  because `cut` splits at the first only), the alg-byte switch (`algEd25519`=1 and
  `algEd25519CosignatureV1`=4 accepted, everything else → `errVerifierAlg`/`errSignerAlg`), the
  32-byte key-length guard, `keyHashEd25519` (name + "\n" + `algEd25519CosignatureV1`-prefixed key,
  BE uint32 of the SHA-256), and — the crux — `verifyCosigV1`'s exact length check
  (`timestampSize+ed25519.SignatureSize` = 72), BE timestamp read, `formatCosignatureV1`
  reconstruction (`cosignature/v1\ntime <t>\n` + raw msg, `< 3` line guard), and delegation to
  `note.ts`'s already-reviewed cofactorless `verifyEd25519` (ADR-0025). Sharing that one Ed25519
  routine rather than reimplementing it is the more faithful choice, as the ADR argues. **One gap
  found and fixed:** the 4 ported tests exercise acceptance (full crypto verify → true) and two
  *malformed-input* rejections — `TestVerifierInvalidSig` opens "nobbled" (structural parse
  failure) and `TestSigCoversExtensionLines` corrupts the signature's final base64 padding byte
  (index `len-2`, a `=`), which fails at base64 decode ("malformed note") *before* the Ed25519
  check. Neither reaches `verifyCosigV1`'s cryptographic-rejection path — the exact failure mode a
  witness-cosigning bug would take (accepting an invalid cosignature as valid). Verified this
  empirically, then added a port-addition case to `note_cosigv1_test.ts` that signs a genuine
  cosignature/v1 note, flips a byte of the note *text* (leaving the 72-byte signature well-formed
  and cleanly-decoding), and asserts `open()` throws — pinning the Ed25519-returns-false path. Now
  5/8 cases (the other 3 need the unported `NewVerifier`/`VKeyToCosignatureV1`/`CoSigV1Timestamp`).
