# ADR-0171: Add a C2SP tlog-witness server, `webtessera/witness`

- **Status:** accepted
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

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Compared with C2SP tlog-witness v1.0.0 (tag `tlog-witness/v1.0.0`) and the editor's copy, diffing the two. The Context's list of draft changes is right: 409 becomes 422 for a same-size root mismatch, the empty-tree root rule, canonical base64, the monitoring endpoint, `sign-subtree`, ML-DSA-44. The same-size 409 is also what Tessera's pinned client expects (`internal/witness/witness.go` branches on `Content-Type: text/x.tlog.size` and otherwise reports "old root hash did not match"), and the Go witness at the cited version maps `ErrRootMismatch` to 422, as the ADR says. `ErrCheckpointStale` gives 409 with `text/x.tlog.size` there too, and its 16 KiB body limit with the comment "16 should be more than enough, even in a PQ world" is the source of `DefaultMaxBodyBytes`.
  - Walked `WitnessServer.addCheckpoint` against the spec text in order: grammar (`old N`, at most 63 proof lines, canonical 32-byte base64), origin read before the note, 404 unknown origin, 403 for no trusted signature or a trusted key that fails, malformed note 400, old size above size 400, lock, old size not the latest 409 with the size body, size-zero empty root 422, same-size root mismatch 409, empty proof when old size is 0 or sizes are equal, consistency proof 422, cosign once, timestamps checked, `put` before the response. `onInconsistency` receives evidence only for the two proof failures the spec says may be logged. One imprecision: the ADR lists 403-on-a-failing-trusted-signature under "Status codes follow v1.0.0", whereas v1.0.0 literally says 403 only when no signature verifies; the behaviour is justified (signed-note v1.0.0 says clients SHOULD reject a note whose known-key signature fails, and the editor's draft makes it a MUST), but it belongs in the list of draft behaviours adopted.
  - Ran: `src/witness` tests pass (part of the 989), including `interop_test.ts` (a Tessera appender with a witness policy, 2-of-2, 409 recovery) and the Chromium test. I wrote a scratch check of the ADR-0172 race claim (see ADR-0172). `parseCheckpointBody` is strict where `formats/log` is lenient, as the ADR says. The key-separation check probes log verifiers with each witness signer's signature (and its underlying Ed25519 form); cosignature timestamps are positive and never decrease for a (name, key hash) per log; refusal bodies echo at most 96 characters per field.
  - Not implemented, as stated and accurately: `sign-subtree` and ML-DSA-44. tlog-cosignature's requirement that a timestamp not exceed 2^63-1 is enforced through the int64 reading. The origin line is not checked against tlog-checkpoint's 255-byte limit; the witness only needs it to name a configured log, so I do not ask for it.
  - Alternatives hold (follow the draft throughout, port transparency-dev/witness, string-compared keys). Status: proposed becomes accepted.

## Update (2026-10-03)

- **Signers must make cosignature/v1 signatures.** `newWitnessServer` has `signer` and each of
  `additionalSigners` sign a probe at construction, and throws unless the signature has the cosignature/v1
  shape (a positive 8-byte timestamp and a 64-byte Ed25519 signature) and, when the signer can produce its
  verifier (as `newSignerForCosignatureV1`'s can), that verifier has the signer's name and key hash and
  accepts the signature. The review showed that a plain Ed25519 note signer was accepted and answered
  add-checkpoint with what verifies as the witness key's own signed note over the request's text,
  extension lines included. This narrows "Any `note.Signer` can be passed, so an ML-DSA signer can be added
  later without API changes" above: an ML-DSA cosigner would need this check extended, which is no API
  change but is a code change. A custom cosignature/v1 signer without a `verifier()` is held to the shape
  alone.
- **Looked-up keys are checked once.** The key separation check costs a signature verification per key
  and per witness signer, and ran on every request for an origin found through `lookupLog`. The witness now
  keeps, per key string (at most 4,096, least recently used first out), the verifier and its verdict, and per
  `Verifier` object (weakly) the verdict. `lookupLog` itself still runs on every request, before any
  signature is checked; its documentation now says bounding that cost is the caller's job and recommends a
  bounded, short-lived cache of answers, unknown origins included.
- `maxBodyBytes` must be a positive safe integer ([ADR-0212](0212-http-request-targets-limits-and-error-bodies.md)).

*Review of this update: approved, ADR reviewer (independent), 2026-10-04. `keycheck.ts` (`checkCosigner`) signs a probe at construction and requires a 72-byte signature with a positive timestamp and, where the signer has `verifier()`, a verifier with the signer's name and hash that accepts it; a plain Ed25519 note signer is refused (`server_test.ts` `insists that every signer makes cosignature/v1 signatures`). The looked-up-key cache is bounded (4,096, least recently used out) with a weak per-`Verifier` verdict, as written; `maxBodyBytes` goes through `positiveInteger`. The narrowing of "any note.Signer can be passed" is stated honestly.*

## Update (2026-10-04)

- **`cosignerVkey(skey)`**, added to `webtessera/witness` (`src/witness/keys.ts`): the cosignature/v1
  (type 0x04) vkey of the cosigner that `newSignerForCosignatureV1(skey)` builds, which is what a witness
  publishes and what policies name. A witness then needs only its signer key: the session-receipts example
  used to require `WITNESS_SKEY` and `WITNESS_VKEY` and check that they matched. It validates the key with
  the ported `newSignerForCosignatureV1` (so its errors are formats/note's, which never quote the key),
  derives the public key with `@noble/curves` from the seed it decodes, wipes the decoded bytes, and
  composes the ported `newEd25519VerifierKey` and `vKeyToCosignatureV1`. A `vkey` on `WitnessServer`
  itself, derived from its `signer`, was the other option and is not possible without changing ported
  code: a `note.Signer` (Go's and the port's) carries a name, a key hash and a sign function, and the
  formats/note cosignature signer keeps its public key in a closure, as Go's does; a key cannot be
  recovered from Ed25519 signatures. Exposing it would add a member to a ported type (the BSD-licensed
  `note_cosigv1.ts`), and a second way to give `newWitnessServer` its key would duplicate the input.
  Tests: `keys_test.ts` (agreement with `vKeyToCosignatureV1` of the pair's vkey, verification of the
  signer's cosignatures by `newVerifierForCosignatureV1`, use in `newWitness` and a policy file, and the
  errors for a vkey, a truncated key, another algorithm and a non-string, none quoting the key).
- **The handler never reads `request.signal`**, for the reasons in ADR-0170's update of the same date:
  `addCheckpoint` is no longer passed it, and a 500 is reported to `onError` whether or not the client is
  still there (it used to be skipped when the request's signal had aborted, which read the signal on the
  failure path). Not cancelling is safe for the protocol: a checkpoint cosigned for a client that left is
  one the log learns of from the witness's next 409. Test: `server_test.ts` answers 200, 409, 400, the
  monitoring endpoint and a 500 from requests whose `signal` getter throws.

*Review of this update: approved, ADR reviewer (independent), 2026-10-04. `cosignerVkey` (`keys.ts`) validates with `newSignerForCosignatureV1`, derives the public key from the decoded seed with `@noble/curves`, wipes the decoded bytes and composes `newEd25519VerifierKey` with `vKeyToCosignatureV1`; `keys_test.ts` checks it against the vkey of the pair, verifies cosignatures with it, uses it in a policy, and checks that errors do not quote the key. The reasoning for not exposing a vkey on `WitnessServer` (a `note.Signer` has no public key, and adding one would change the BSD-licensed ported file) is right. The handler no longer reads `request.signal` (`server_test.ts` asserts through a throwing getter, including the 500 path); the session-receipts example derives the vkey from the signer key only.*

## Update (2026-10-04)

Answering 403 when a trusted key's signature fails to verify does not come from tlog-witness v1.0.0. That version
says 403 only when no signature from a known key verifies. The behaviour comes from signed-note v1.0.0, which says a
client SHOULD reject a note whose known-key signature fails, and from the tlog-witness editor's draft, which makes it
a MUST. It belongs among the draft behaviours this ADR adopts, not under "Status codes follow v1.0.0".

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. Checked against the spec texts, fetched from the C2SP repository today.
`tlog-witness/v1.0.0` says: "If none of the signatures verify against any of the trusted public keys, the witness MUST respond with a 403". The editor's
draft says 403 "if either no signature from a trusted key for the origin is present, or a signature line's key name and ID match a trusted key but the
signature itself fails to verify (such a note is malformed per signed-note)". `signed-note/v1.0.0` says "If a signature from a known key fails to verify,
clients SHOULD reject the whole note", so the Update's three attributions are exact. In `src/witness/server.ts`, `open()` throws `UnverifiedNoteError` (no trusted
signature) or `InvalidSignatureError` (a signature naming a trusted key that fails), and both become `ErrNoValidSignature`, 403; the two cases are tested in
`server_test.ts` ("refuses unknown origins, untrusted signatures ...": a wrong key with the log's name, and the log's signature over different text). I
ran that file: 30 passed. The Decision's bullet "Status codes follow v1.0.0 ... 403 ... or a signature naming a trusted key fails" is the text the Update corrects.
