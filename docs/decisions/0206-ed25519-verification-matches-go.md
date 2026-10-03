# ADR-0206: Verify Ed25519 exactly as Go does, and refuse degenerate verifier keys when they are configured

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** hardening contributor
- **Upstream reference:** `golang.org/x/mod/sumdb/note/note.go` (`NewVerifier`); Go 1.25.5 `crypto/ed25519/ed25519.go` (`Verify`, `VerifyWithOptions`) and `crypto/internal/fips140/ed25519/ed25519.go` (`NewPublicKey`, `verifyWithDom`); supersedes ADR-0025

## Context

ADR-0025 set out to make the port accept exactly the signatures Go's `sumdb/note` accepts, and justified
`@noble/curves`' `zip215: false` mode by stating that Go "decodes `R` and `A` canonically" and rejects
small-order keys. That is not what Go 1.24/1.25 does:

```go
// crypto/internal/fips140/ed25519: newPublicKey
// SetBytes checks that the point is on the curve.
if _, err := pub.a.SetBytes(pubBytes); err != nil {
```

`edwards25519.Point.SetBytes` accepts *every* encoding of a curve point, including non-canonical ones, and
nothing rejects small-order points. `verifyWithDom` then checks `sig[63]&224 == 0`, requires a canonical `S`,
computes `k = SHA-512(R || A || M) mod L` over the key bytes as given, and accepts iff the canonical encoding of
`[S]B − [k]A` equals `sig[:32]`. For a small-order public key, signatures that pass this check can be produced
without any private key; Go accepts them.

The port's verifier (noble's `zip215: false` gate plus a cofactorless residual check) therefore *rejected*
signatures Go accepts — every small-order key and every non-canonically encoded key. The note/gostd fidelity
audit measured it over 2,366 vectors: no vector the port accepted and Go rejected, and 78 small-order-key
vectors Go accepted and the port rejected. So the port was stricter than Go, which fails closed, but for the
wrong stated reason, and in a way that makes two implementations disagree.

Accepting signatures under a small-order key is not something a log or a witness should do; but disagreeing
with Go at *verification* time is also a split-view hazard. The better place to refuse such keys is where they
enter: when a verifier is configured.

## Decision

1. **`verifyEd25519` is a transcription of Go's `NewPublicKey` + `verifyWithDom`**, built from noble's point
   arithmetic and `@noble/hashes`' SHA-512: decode `A` with `Point.fromBytes(pub, true)` (ZIP-215 decoding
   accepts exactly the encodings `SetBytes` accepts), return false if it is not a point, require a 64-byte
   signature with `sig[63] & 224 == 0` and `S < L`, compute `k` over the key bytes as given, and compare the
   canonical encoding of `[S]B − [k]A` with `sig[:32]` byte for byte. It is `@internal`-exported for
   `formats/note`'s cosignature verifier, as before. It agrees with Go's `crypto/ed25519.Verify` on all 2,366
   audit vectors; the audit's representative vectors (honest, every small-order encoding, mixed-order accepted
   and rejected, torsioned `R`, non-canonical `S`) are pinned in `note_test.ts` with Go's verdicts.
2. **`newVerifier` refuses degenerate Ed25519 keys at configuration time** — a deliberate, fail-closed
   divergence from Go's `NewVerifier`, which accepts any 32 bytes:
   - a small-order public key: `errVerifierSmallOrderKey` ("unsafe verifier key: Ed25519 public key is a
     small-order point"), including non-canonical encodings of small-order points;
   - a non-canonical encoding of a large-order point: `errVerifierNonCanonicalKey` ("unsafe verifier key:
     Ed25519 public key is not canonically encoded"), because one point would otherwise have several key
     encodings, key hashes and key IDs.
   32 bytes that are not a curve point are still accepted, as in Go: the verifier verifies nothing.
3. The check is exported as `checkEd25519PublicKey(pub)` so that the cosignature/v1 verifier constructor in
   `src/vendor/formats/note` can apply the same rule; that file belongs to another work package.

## Consequences

- With a well-formed key, every signature verdict is now Go's, in both directions.
- A verifier key that Go would load and this port refuses fails loudly when the application starts, not as a
  disagreement on some later checkpoint. No key produced by `generateKey`, `newEd25519VerifierKey` over a real
  public key, or any honest Ed25519 implementation is affected: honest keys are canonical encodings of
  large-order points.
- The port no longer relies on noble's `verify` at all for note signatures; it composes noble's `Point`
  operations, which ADR-0005 permits. The mixed-order regression test from ADR-0025 still passes.
- ADR-0025's claims about Go's behaviour are wrong and it is superseded; its goal (agree with Go) is what
  Decision 1 achieves.

## Alternatives considered

- **Keep the stricter verifier.** Rejected as the sole defence: it makes the port's verdicts differ from Go's on
  the same bytes, and it hides the degenerate key until a signature happens to exercise it.
- **Match Go exactly and accept degenerate keys.** Rejected: there is no legitimate use for a small-order
  verifier key, and refusing it at configuration time costs nothing.
- **Refuse degenerate keys in `newEd25519VerifierKey` too.** Not done: that function only encodes a key and
  upstream's tests call it with arbitrary bytes; the refusal belongs where a key starts being trusted.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
