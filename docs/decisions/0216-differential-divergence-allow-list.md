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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Checked all 13 `DIVERGENCES` entries in `src/testonly/testing/differential.ts` against the table and against the ADRs they cite. Names, ADR lists and rules agree: 0203 (origin UTF-8, and the quoting of invalid input), 0202 (root hash size; merkle hash sizes), 0206 and 0174 (unsafe verifier keys: `checkEd25519PublicKey` is called by both `newVerifier` and `newVerifierForCosignatureV1`), 0184 (quorum), 0185 and 0241 (https; platform parser; no host), 0242 (UTF-8 policy line), 0204 (quote bound, `maxQuotedNum` = 64, pinned by `strconv_test.ts`), 0182 (65,535-byte entries), 0194 (tile and bundle limits; both messages exist in `src/api/state.ts`), 0014 (`layout.range` RangeError, covered by ADR-0014's update). The 13 names in the ADR table are the 13 in the code. The retired `witness-url-absolute` and `witness-url-escaping` appear nowhere in code or tests, and the policy suite requires all four of its entries.
  - The merkle harness (`checkVerify`, `checkSizeError`) does what the ADR says, exactly: it applies `merkle-hash-size` only where Go verified the proof, requires the named hash to really have the stated length, and elsewhere demands Go's text or a `RootMismatchError` with Go's calculated root. `bun run test:parity` rejects an entry citing a missing ADR: shown in a scratch copy with ADR-0204 removed (`differential divergence numerror-quote-bound cites ADR-0204, which does not exist`).
  - REQUEST 1 (the Decision is not what four entries do). The Decision says: "A suite may apply an entry only to a record where Go's verdict and the port's match that rule exactly". In `src/testonly/testing/differential/root.ts`, `policyHardening` selects `witness-quorum-hardening`, `witness-url-https`, `witness-url-fetchable` and `witness-policy-utf8` from the port's message text alone; Go's side is never examined. In the committed witness-policy corpus the applications are, by Go's verdict (accepts / rejects with different text): https 7 / 17, quorum 5 / 10, fetchable 8 / 0, utf8 21 / 127. I read all 27 https and quorum records where Go rejects: in each, Go's error is on a later line (or later in the same group) than the port's, so the rule holds today, and for the utf8 ones it holds by construction (the port processes the earlier lines as Go does). But nothing would fail if it stopped holding, for example the port refusing a URL with the https message on the line where Go's own `url.Parse` error is expected. Either tighten `root.ts` (for the URL and quorum entries, require that Go's error is not on or before the offending line, e.g. by replaying both sides on the policy cut at that line; for `witness-policy-utf8`, require that the lines before the first invalid one get Go's verdict) or reword the Decision to say that the policy suite classifies by the shape of the port's message. The same gap, smaller: `sameModuloQuoteBound` does not check the 64-code-point cut (only `strconv_test.ts` does), and the bundle branch of `tile-bundle-size-limit` in `api.ts` is applied for any Go error (sound, because the port has parsed 256 entries before it fails). Say so, or tighten.
  - Minor, in code (not the ADR): the doc comment of `sameModuloInvalidUTF8` in `differential.ts` still describes the port's `\ufffd` escape that the 2026-10-04 Update corrects.
  - Observation, not blocking: the table in the body already holds the post-update state (it lists `witness-url-fetchable` and `witness-policy-utf8`, which the Update calls new), so the Update repeats part of it. Harmless while the ADR is unaccepted.
  - Status stays `proposed` until Request 1 is answered.

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

**Review of this update:** ADR review agent (independent), 2026-10-04. Verdict: approved. Each bullet checked: the two retired entries are gone from code and tests; `witness-url-https` cites 0185 and 0241, `witness-url-fetchable` cites 0241 and `witness-policy-utf8` cites 0242 in `DIVERGENCES`, and `root.ts` requires all four; `merkle-hash-size` matches `checkVerify` (see Notes); for `invalid-utf8-text` the port writes the character U+FFFD itself (ADR-0204's `quote`; only a lone surrogate becomes the escape) and the comparison collapses both spellings; the commands match `package.json` (`bun run fixtures`, `bun run test:parity`). Request 1 above concerns the Decision, not this Update.
