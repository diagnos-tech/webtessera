# ADR-0216: Allow documented divergences in the differential suites only by name, with a precise rule

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** Gustavo Simões
- **Upstream reference:** n/a (test policy for the corpora of ADR-0215)

## Context

The differential suites (ADR-0215) compare the port with Go on thousands of inputs. Some differences are
decided: each has its own ADR (an invalid-UTF-8 origin is refused, a non-32-byte merkle hash is refused, an
unsafe Ed25519 key is refused when a verifier is configured, ...). A suite that skipped such records, or
compared only "accept or reject", would also hide the next, undecided difference that happens to fall in the
same records. A suite that failed on them would be useless.

## Decision

`src/testonly/testing/differential.ts` holds the allow-list, `DIVERGENCES`. Each entry has a name, the ADRs that
decided it and a rule stating what the port does *instead*, precisely enough to assert. A suite may apply an
entry only to a record where Go's verdict and the port's match that rule exactly; it counts every application,
and fails a record that differs in any other way. A suite also declares which entries it may apply (any other
is a failure) and which it must apply at least once (so a corpus that stops exercising a divergence is noticed).
`pnpm test:parity` (ADR-0217; `bun run test:parity` since ADR-0240) fails if an entry cites an ADR that does not
exist.

The entries at the time of writing:

| Entry | ADRs | What the port does instead of Go |
| --- | --- | --- |
| `invalid-utf8-text` | 0203, 0216 | For an input that is not valid UTF-8, text quoted from it in an error message spells each invalid sequence as the character U+FFFD (`�`, written as is, as Go quotes a genuine U+FFFD; the escape `\ufffd` appears only for a lone surrogate) where Go's `%q` spells each byte as `\xNN`. Verdict and the rest of the message are Go's. Asserted by collapsing each run of invalid-byte spellings on both sides and comparing. A JavaScript string cannot hold the raw bytes. ADR-0203 records it for the checkpoint size line; this ADR applies the same rule to every message that quotes such input (`checkpointUnsafe`'s, for one). |
| `checkpoint-origin-utf8` | 0203 | `Checkpoint.unmarshal` rejects a non-UTF-8 origin with `invalid checkpoint - origin is not valid UTF-8`. |
| `checkpoint-root-hash-size` | 0202 | `parseCheckpoint` rejects a root hash that is not 32 bytes, after upstream's checks, carrying the note. |
| `ed25519-unsafe-verifier-key` | 0206, 0174 | `newVerifier` and `newVerifierForCosignatureV1` throw `errVerifierSmallOrderKey` / `errVerifierNonCanonicalKey` for keys Go accepts; `verifyEd25519` itself returns Go's verdict on every vector. |
| `merkle-hash-size` | 0202 | `verifyInclusion`, `rootFromInclusionProof` and `verifyConsistency` throw `<proof[i]\|root\|root1\|root2> has unexpected size N, want 32` only where Go succeeds, after every upstream check (its root comparisons included), where Go treats the hash as opaque bytes. The named hash must really have that length. Where Go rejects, the port's error is Go's: a `RootMismatchError` with Go's calculated root, or the same text. |
| `uint-count-overflow` | 0014 | `layout.range` throws a `RangeError` where a bundle count would wrap Go's `uint`; items yielded before are Go's. |
| `witness-quorum-hardening` | 0184 | `newWitnessGroupFromPolicy` rejects a repeated child, a repeated verifier key and an explicit threshold of 0 with the ADR's messages, possibly before a later error Go reports first. |
| `witness-url-https` | 0185, 0241 | A witness URL Go accepts whose endpoint (Go's `JoinPath(...).String()`) is not https, or http to loopback, relative references included, is rejected with ADR-0185's message. |
| `witness-url-fetchable` | 0241 | An https or http witness URL Go accepts is rejected with `witness URL %q has no host` when Go's reading has no host, and with `witness URL %q is rejected by the platform URL parser, which fetch uses` when `URL.canParse` rejects the endpoint; both wrapped as `invalid witness config %q: ...`. |
| `witness-policy-utf8` | 0242 | `newWitnessGroupFromPolicy` rejects the first line whose text before its first `#` is not valid UTF-8, when it reaches it, with `witness policy line is not valid UTF-8`; earlier lines get Go's verdict, and invalid bytes in a comment are accepted as in Go. Applied only to a policy that is not valid UTF-8. |
| `numerror-quote-bound` | 0204 | A strconv `NumError` message quotes at most 64 code points of the input, then `...`; Go quotes it all. The prefix and the rest of the message are Go's. |
| `entry-size-limit` | 0182 | `newEntry` throws for more than 65 535 bytes, which Go accepts and then writes with a truncated uint16 length prefix. |
| `tile-bundle-size-limit` | 0194 | `HashTile.unmarshalText` rejects more than 256 hashes and `EntryBundle.unmarshalText` stops at a 257th entry, with the ADR's messages; Go parses any number. |

Documented divergences that no corpus reaches, and why: ADR-0183 (fail-open keeps the log-signed checkpoint)
needs a witness that fails, which the publisher corpus does not configure; ADR-0200 (`appendUint*BE` throw
outside the Go type) and ADR-0207 (uint64 domain guards) concern values a Go `uint16`/`uint64` cannot hold, so
Go cannot produce an input that reaches them; ADR-0195/0196 (response caps, LogStateTracker fork rejection)
concern I/O the corpora do not perform. Each is covered by the owning work package's own tests.

## Consequences

- Every decided divergence is visible in one file and its frequency in every run's report.
- A new divergence cannot ride along with an old one: it fails until it has an ADR and an entry here.
- Adding an entry is a reviewable change to test policy, not a quiet edit to a suite.

## Alternatives considered

- **Exclude divergent records from the corpora in the generator.** Rejected: the generator would have to know
  the port's decisions, and the records would stop proving that the port keeps them.
- **Compare only verdicts for divergent inputs.** Rejected: too weak; the rule for each entry pins the exact
  replacement behaviour.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending

## Update (2026-10-04)

- `witness-url-absolute` and `witness-url-escaping` are retired: ADR-0241 transcribes Go's `url.Parse`, `JoinPath` and
  `String`, so the port no longer rejects URLs for lacking a `//` authority, keeps no URL "as written", and accepts no
  malformed escape. `witness-url-https` also cites ADR-0241, which routes relative references to it, and
  `witness-url-fetchable` (ADR-0241) and `witness-policy-utf8` (ADR-0242) are new; the witness-policy corpus requires
  all four of its entries.
- `merkle-hash-size`: the code now matches this table, applying the size checks only where Go succeeds (ADR-0202's
  2026-10-04 update), and the merkle harness applies the entry only there, instead of wherever Go returned a
  `RootMismatchError`.
- `invalid-utf8-text`: the row said the port spells an invalid sequence `\ufffd`. It writes the character U+FFFD
  itself, as Go writes a genuine U+FFFD; the escape is only for a lone surrogate. The comparison, which collapses
  both spellings, was already right.
- Commands are `bun run fixtures` and `bun run test:parity` since ADR-0240.
