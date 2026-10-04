# ADR-0005: Use `@noble/hashes` and `@noble/curves`, not WebCrypto

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** lead maintainer
- **Upstream reference:** `merkle/rfc6962/rfc6962.go`, `golang.org/x/mod/sumdb/note`

## Context

The port needs SHA-256 (RFC 6962 leaf and node hashing) and Ed25519 (note signing and verification,
per `sumdb/note`). The two candidate sources in a browser/edge runtime are WebCrypto
(`crypto.subtle`) and a pure-JS library.

The decisive property is **synchrony**. Upstream's hasher is a plain function:

```go
func (t *Hasher) HashChildren(l, r []byte) []byte
```

It is called inside tight loops in `compact.Range` and `storage/internal/integrate.go` — building a
tile calls it hundreds of times. `crypto.subtle.digest` returns a `Promise`. Porting on top of
WebCrypto would make the entire Merkle layer async, which would then infect `compact`, `proof`,
`integrate`, and every caller — turning a mechanical translation into a redesign, and destroying the
line-by-line correspondence with the Go source.

Secondary problems with WebCrypto: Ed25519 support is uneven across runtimes and was only recently
stabilised; key import/export ceremony does not map onto `sumdb/note`'s raw-key format without
extra marshalling; and `crypto.subtle` is unavailable in non-secure browser contexts.

## Decision

Use `@noble/hashes` for SHA-256 and `@noble/curves` for Ed25519. These are the only runtime
dependencies of the donatable part of the package (PORTING.md §7).

They are audited, have zero dependencies of their own, are synchronous, and behave identically in
Node, browsers, and workerd — which matters because the same log code has to run in a tab and in a
Durable Object.

The Merkle layer stays synchronous, exactly as upstream.

## Consequences

- Pure-JS SHA-256 is slower than a native WebCrypto implementation for large inputs. For this
  workload the inputs are small and numerous (32–64 byte hash inputs), which is precisely the regime
  where WebCrypto's per-call promise overhead would dominate anyway. If a future profile shows entry
  hashing of large payloads is hot, an *optional* async fast path can be added at the entry boundary
  only — that would be a new ADR, and it must not make the tree code async.
- Two dependencies to vet for a published library. Both are widely used in the wider
  transparency/crypto ecosystem.
- Constant-time properties for Ed25519 come from `@noble/curves`, which is audited for it. We do not
  hand-roll any curve arithmetic.

## Alternatives considered

- **WebCrypto only.** Rejected: forces the whole Merkle layer async (see Context).
- **WebCrypto for Ed25519, noble for SHA-256.** Rejected: two crypto stacks, uneven runtime support
  for Ed25519, and no benefit — signing is not hot.
- **Hand-written SHA-256.** Rejected outright. Never ship hand-rolled crypto in a transparency log.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - The load-bearing claim is that the hasher is a plain synchronous function called in tight loops. Against
    `merkle@v0.0.2/rfc6962/rfc6962.go`: `HashChildren(l, r []byte) []byte` returns a value, no error, no context.
    Upstream hands it around as a function value: `compact.RangeFactory{Hash: rfc6962.DefaultHasher.HashChildren}`
    in `storage/internal/integrate.go` (lines 68 and 339) and `fsck/fsck.go:100`, and
    `nodes.Rehash(hashes, hasher.HashChildren)` and `RangeFactory` in `client/client.go` (lines 243 and 422).
    A `Promise`-returning hash would change all of those signatures, which is the argument made. I agree with it.
  - The TypeScript honours the decision. `src/vendor/merkle/rfc6962/rfc6962.ts` imports `sha256` from
    `@noble/hashes/sha2.js`, `DefaultHasher = new Hasher(sha256)`, `hashChildren` is synchronous, and no file of
    `src/vendor/merkle/{rfc6962,compact,proof}` or `hasher.ts` contains `async` or `Promise`. In
    `storage/internal/integrate.ts` the `async` functions are the tile reads and writes (Go's `context` I/O); the
    hashing inside them is synchronous. `package.json` lists exactly `@noble/curves` and `@noble/hashes` under
    `dependencies`, as PORTING.md section 7 says. `src/vendor/note/note.ts` signs and verifies with
    `@noble/curves/ed25519.js` and `@noble/hashes/sha2.js`.
  - Two statements of fact are slightly off, neither affects the decision, so I do not request changes.
    (1) "have zero dependencies of their own" is true of `@noble/hashes`, but `@noble/curves@2.3.0` declares one
    dependency, `@noble/hashes` itself (`node_modules/@noble/curves/package.json`). The transitive set is still
    exactly the two packages the ADR counts, so "two dependencies to vet" stands. (2) "Audited" is true but dated:
    both READMEs list independent Cure53 audits of 1.x releases (hashes 1.0.0, Jan 2022; curves 1.6.0, Sep 2024,
    whose scope names ed25519) and, for 2.2.0, a self-audit; the pinned range is `^2.3.0`. The ADR's reliance on
    "constant-time properties ... audited" therefore rests on the 1.x audits plus the maintainers' own review of
    2.x. Worth knowing, not a reason to reverse.
  - Challenge on the Alternatives. "WebCrypto for Ed25519, noble for SHA-256: rejected, signing is not hot" is the
    right argument for verification, which stays on noble. It is no longer the whole story for signing: ADR-0223
    and ADR-0227 add WebCrypto-backed asynchronous signers so that non-extractable keys can be used, which is the
    "optional async path ... a new ADR" this ADR's Consequences anticipated, and they keep the Merkle layer and
    verification synchronous as required. ADR-0223 and ADR-0227 do not refer back to this one (ADR-0222 does, in
    passing). I suggest a one-line pointer in an Update here when they are reviewed; it is not needed for this ADR
    to be in force.
  - Browser claims (`crypto.subtle` only in secure contexts; uneven Ed25519 support) are platform facts I did not
    re-test and did not need to.

## Update (2026-10-04)

Two facts, recorded from the Review's notes, and a pointer to the ADRs that build on WebCrypto; the decision is unchanged.

- *Review of this correction:* ADR reviewer (independent), 2026-10-04 — changes requested — The intro sentence is now right: the Review's notes give the two facts (the dependency count and the dated audits) and asked for the pointer, and the three bullets match "two facts and a pointer". But the same review's other remark is not answered, and the third bullet is still inaccurate against the ADRs and the code: ADR-0223 adds `AsyncSigner`, `signAsync` and `withCheckpointAsyncSigner` (`src/vendor/note/note.ts`, `src/append_lifecycle.ts`), ADR-0222 is the one that creates and imports non-extractable WebCrypto keys (`LogKey`, `src/safe/keys.ts`), and ADR-0227 only stores that key in IndexedDB (`src/browser/device_key.ts` defines no signer), so "ADR-0223 and ADR-0227 ... add WebCrypto signers" is the loose attribution the review named, and the pointer omits ADR-0222. Also, the "optional async path ... a new ADR" that the Consequences anticipated is an optional async fast path for hashing large entry payloads at the entry boundary (first Consequences bullet), not async signing, and the quotation is not verbatim ("async fast path"). To fix: say that ADR-0223 adds the async signing path, ADR-0222 the WebCrypto key custody and ADR-0227 device-key storage, and that none of them changes hashing, the Merkle layer or verification, which stay on noble and synchronous (that last claim holds: `crypto.subtle` is called only in `src/safe/keys.ts`). Also, the intro was changed in place with no Correction line, as ADR-0173 and ADR-0176 have.
- "Zero dependencies of their own" holds for `@noble/hashes`. `@noble/curves` 2.3.0 declares one dependency,
  `@noble/hashes` itself, so the transitive set is still exactly the two packages this ADR counts.
- The independent audits both READMEs list (Cure53: hashes 1.0.0, January 2022; curves 1.6.0, September 2024, with
  Ed25519 in scope) cover 1.x releases. For 2.x the maintainers list their own audit. The reliance on audited
  constant-time code rests on those.
- Three later ADRs build on WebCrypto, for keys only: ADR-0222 creates and imports non-extractable WebCrypto
  Ed25519 keys (`src/safe/keys.ts`), ADR-0223 adds the async signing path (`AsyncSigner`, `signAsync`,
  `withCheckpointAsyncSigner`), and ADR-0227 stores a device key in IndexedDB. None of them is the "optional async
  fast path" the first Consequences bullet anticipates, which is about hashing large entry payloads; none changes
  hashing, the Merkle layer or verification, which stay on noble and synchronous.

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. Checked in
`node_modules`: `@noble/curves` is 2.3.0 and declares exactly one dependency, `@noble/hashes` 2.3.0, which has none;
`package.json` pins `^2.3.0` for both. Both READMEs' "Security" sections say what the Update says: Cure53 for hashes at
1.0.0 (January 2022) and for curves at 1.6.0 (September 2024, scope names ed25519), and for 2.2.0 (April 2026) the
maintainers' own self-audit. `src/vendor/merkle/{rfc6962,compact,proof}` contain no `async` or `Promise`, and note
verification (`verifyEd25519`, `src/vendor/note/note.ts`) is synchronous on `@noble/curves`; the only
`crypto.subtle` calls in `src/` are in the key-custody code (`src/safe/keys.ts`), with doc examples in
`src/browser/keys.ts` and `note.ts`, so "keep the Merkle layer and verification on noble and synchronous" holds. Not blocking: the Update opens
"Two facts" and lists three bullets (the third is the pointer to ADR-0223 and ADR-0227, not a fact from the Review),
and "ADR-0223 and ADR-0227 add WebCrypto signers" is loose: ADR-0223 adds the `AsyncSigner` and `signAsync` path,
ADR-0227 stores the non-extractable device key, and the WebCrypto key creation itself is ADR-0222's (`src/safe/keys.ts`).

- *Correction (2026-10-04, after review):* the intro sentence was reworded in place to "two facts … and a pointer",
  and the third bullet now attributes key custody to ADR-0222, async signing to ADR-0223 and device-key storage to
  ADR-0227, and no longer equates them with the Consequences' async hashing path, as the review of this correction
  asked.
- *Review of this correction:* ADR reviewer (independent), 2026-10-04 — approved — Checked the new third bullet and the Correction line against my request and the code. ADR-0222's key creation and import is `generateLogKey` and `importLogKey` in `src/safe/keys.ts`, which calls `subtle.importKey`, `generateKey`, `sign` and `exportKey` for Ed25519 with non-extractable keys. ADR-0223's async signing path is `AsyncSigner` and `signAsync` (`src/vendor/note/note.ts`) and `withCheckpointAsyncSigner` (`src/append_lifecycle.ts`). ADR-0227's device key in IndexedDB is `src/browser/device_key.ts`, which defines no signer. The first Consequences bullet's "optional async fast path" is about hashing large entry payloads, which none of the three is. "For keys only" and "none changes hashing, the Merkle layer or verification" hold: no `subtle.digest` exists, `crypto.subtle` is called only in `src/safe/keys.ts` (doc examples aside), and `LogKey.verifier()` is the ported `newVerifier` on noble. The intro now matches the bullets, and the Correction line records both changes.
