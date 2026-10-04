# ADR-0242: A witness policy line must be valid UTF-8 where it is parsed

- **Status:** proposed
- **Date:** 2026-10-04
- **Author:** Gustavo Simões
- **Upstream reference:** `witness.go` (`NewWitnessGroupFromPolicy`)

## Context

`NewWitnessGroupFromPolicy` scans the policy with `bufio.Scanner` and works on each line's bytes:

```go
for scanner.Scan() {
	line := strings.TrimSpace(scanner.Text())
	if i := strings.Index(line, "#"); i >= 0 {
		line = line[:i]
	}
```

A Go string holds any bytes, so component names, verifier keys and URLs that differ only in bytes that are not valid
UTF-8 stay distinct, and `url.Parse` and `NewVerifierForCosignatureV1` see the bytes as they are. A JavaScript string
cannot hold them. The port decoded each line with `Scanner.text()`, a non-fatal `TextDecoder` that turns every invalid
sequence into U+FFFD, and the final fidelity audit showed the verdicts that changed:

| Policy (`\xNN` is a raw byte) | Go | Port |
| --- | --- | --- |
| witnesses `w\xff` and `w\xfe`, `group g all w\xff w\xfe`, `quorum g` | accepted, two witnesses | `duplicate component name: "�"` |
| witness `\xff`, `quorum \xfe` | `quorum component "\xfe" not found` | accepted |
| witness key named `\xff` (or `\xc0\x80`, `\xed\xa0\x80`) | `... malformed verifier id` | accepted, key name `"�"` |
| URL ending in `\xff` | endpoint `https://a.example/%FF/add-checkpoint` | endpoint `.../%EF%BF%BD/add-checkpoint` |

The second row accepts a quorum the policy never defined. ADR-0203 rejected the same lossy collapse for a checkpoint's
origin, on the grounds that a conversion that can make two identities compare equal must not happen silently; witness
and group names are identities in the same sense, and the policy is the configuration that decides which cosignatures
a log waits for.

## Decision

`newWitnessGroupFromPolicy` throws `witness policy line is not valid UTF-8` for the first scanned line whose bytes before
its first `#` are not valid UTF-8 (`validUTF8` over `Scanner.bytes()`), when the loop reaches that line and before
anything else is done with it.

- Those bytes are exactly the part of the line Go goes on to read: `TrimSpace` removes only whole white-space runes, and
  `#` (0x23) cannot occur inside a multi-byte sequence, so Go's trimmed, comment-stripped line is valid UTF-8 if and
  only if they are.
- A comment, which Go discards, may hold any bytes, and the policy is then read exactly as Go reads it.
- Lines before the offending one get Go's verdict: an error on an earlier line is reported as Go reports it. Errors
  Go would report for the offending line itself, for a later line, or for the quorum at the end are not reached.

## Consequences

- Every policy that is valid UTF-8 (in its parsed parts) behaves exactly as upstream; for those, nothing changed.
- A policy Go accepts with non-UTF-8 names, keys or URLs is rejected. Such a policy cannot be written in the Sigsum
  policy format as text, and no conforming configuration contains one.
- `fixtures/data/differential_witness_policy.json` gains a `binary` section: 151 policies, carried in hex, with invalid
  sequences (`ff`, `fe`, `c0 80`, `ed a0 80`, a truncated `e2 82`, a stray `80`, `f4 90 80 80`) in names, keys, URLs,
  keywords, the quorum and comments. ADR-0216's `witness-policy-utf8` entry lets the harness accept the port's message
  only for a policy that is not valid UTF-8; every other record, comments with invalid bytes included, must match Go.
  Where Go accepts such a policy with a tree that itself holds invalid bytes (an opaque URL is written back verbatim),
  the record holds `"notUTF8"` instead of the tree.
- `witness_policy_test.ts` pins the audit's examples, the earlier-line precedence and the comment case.

## Alternatives considered

- **Reject the whole policy up front if it is not valid UTF-8**, as the audit suggested. Rejected: it would also reject
  invalid bytes in comments, which Go ignores, and would report the UTF-8 error ahead of errors Go reports on earlier
  lines; checking each line as it is reached costs nothing more and keeps both of Go's behaviours.
- **Compare names and keys as bytes.** Faithful, but every name, key and URL would have to travel as bytes through the
  parser, the verifier constructor and `url.parse`, for input that cannot be written as a text policy.
- **Keep the U+FFFD decoding and document it.** Rejected for the reason ADR-0203 gives: it silently merges distinct
  identities, here in the configuration that decides a log's quorum.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
