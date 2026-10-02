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

- **Reviewer:** _pending — foundational ADR, to be challenged by the first reviewer agent_
- **Verdict:** _pending_
- **Notes:**
