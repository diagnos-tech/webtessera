# ADR-0171: Add a C2SP tlog-witness server, `webtessera/witness`

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** http/witness/mirror contributor
- **Upstream reference:** `internal/witness/witness.go` (the client side), n/a for the server; behaviour cross-checked against `github.com/transparency-dev/witness` (`witness/witness.go`, `witness/http.go`) at `v0.0.0-20260925114237-b4c9458d9b14`

## Context

Tessera's appender asks witnesses to cosign its checkpoints (`withWitnesses`, ported in
`src/internal/witness/witness.ts` and `src/witness.ts`), but Tessera contains no witness. The
maintainer's use case needs one that runs where webtessera runs: a server witnessing the logs its
users' browsers keep, one per session, so the set of logs is open-ended and not known at start-up.

The protocol is C2SP tlog-witness. Its stable release is **v1.0.0**; the editor's draft has since
(a) moved a same-size root mismatch from 409 to 422, (b) added the empty-tree root rule for size-zero
checkpoints, (c) required canonical base64, (d) added the monitoring endpoint, an optional
`sign-subtree` call, and a recommendation of ML-DSA-44 cosignatures.

## Decision

New module `src/witness/` (exports map `./witness`), distinct from the root's client-side
`src/witness.ts`. Names avoid the root's: `newWitnessServer`/`WitnessServer`. Barrel docs explain the
two halves.

- `newWitnessServer({ signer, additionalSigners?, store, keyPrefix?, logs?, lookupLog?, prefix?,
  monitoringPrefix?, maxBodyBytes?, onInconsistency?, onError? })`; `handle` (a bound
  `webtessera/http` Handler), `addCheckpoint(req, signal)`, `latestCheckpoint(origin)`.
- **Status codes follow v1.0.0**, which Tessera's pinned client was written against: 400 malformed body,
  bad checkpoint, or old size > size; 404 unknown origin; 403 no trusted signature verifies, or a
  signature naming a trusted key fails; 409 + `text/x.tlog.size` + `"<size>\n"` for a stale old size;
  409 (plain text) for a same-size root mismatch; 422 for a bad or unexpected proof. Checks run in the
  order the spec states them, each quoted in a comment.
- Adopted from the editor's draft because they only reject what v1.0.0 leaves undefined: size-zero
  checkpoints must carry the empty-tree root (422); proof lines and root hashes must be canonical base64
  of exactly 32 bytes; the monitoring endpoint `GET <monitoring prefix>/<sha256(origin) hex>/checkpoint`
  (a SHOULD), serving the stored checkpoint with the verified log signatures and the witness's own.
- Hardening (security review): request body and checkpoint capped (16 KiB default, as the Go witness);
  at most 63 proof lines, each exactly 32 bytes, also for programmatic callers; the old-size line and
  the checkpoint's size line matched against bounded patterns before conversion; the checkpoint text
  parsed strictly per tlog-checkpoint (no leading zeroes, 32-byte root), not with the lenient
  `formats/log` parser; the response is only the witness's own signature lines; refusal bodies echo at
  most ~100 characters of the request; a witness key that is also a log key (static config: rejected at
  construction; `lookupLog`: refused as unknown) is detected behaviourally by probing log verifiers with
  a signature from each witness signer.
- Cosignatures: signed once per request (`sign` over the verified text), so the stored and returned
  signatures are identical. cosignature/v1 timestamps must be positive and never go backwards for a log
  (compared as int64 seconds via `coSigV1Timestamp`); otherwise the request fails with 500 and nothing is
  stored.
- `lookupLog(origin, signal)` is consulted, on every request, for origins the static `logs` lack.
- `onInconsistency` receives validly signed checkpoints refused as inconsistent ("MAY log").
- Opt-in CORS (`cors`, the same helper the log handler uses): a log kept in a browser tab posts to its
  witness cross-origin and must be able to read the answer, 409 bodies included.

**Not implemented:** `sign-subtree` (OPTIONAL) and ML-DSA-44 cosignatures (SHOULD in the draft, not
in v1.0.0; it would need `@noble/post-quantum`, which is not a permitted dependency, and Tessera's
pinned client verifies cosignature/v1 only). Any `note.Signer` can be passed, so an ML-DSA signer can be added later without
API changes.

## Consequences

- Interop is tested against the ported appender (`withWitnesses` from a policy, 2-of-2 group, and the
  409 recovery path), and cosignatures against the ported cosignature/v1 verifier.
- If C2SP tags a version with the draft's 422, switching is one table entry in `src/witness/http.ts`;
  Tessera's client treats both as failures.
- New public API, including re-exports of the cosignature/v1 key functions (see ADR-0174).

## Alternatives considered

- **Follow the editor's draft throughout (422 for root mismatch).** Rejected for now: v1.0.0 is the
  published version and the one c2sp.org/tlog-witness resolves to; Tessera's client quotes its 409 text.
- **Port transparency-dev/witness.** Rejected: not a Tessera dependency, server-only Go with SQL
  persistence and OpenTelemetry; we reuse its error taxonomy and ordering, not its code.
- **Require keys as strings to compare them directly.** Rejected: the behavioural probe works for any
  Ed25519 `Signer`/`Verifier`, including custom ones.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
