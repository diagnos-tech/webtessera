# ADR-0203: A checkpoint origin must be valid UTF-8

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** hardening agent
- **Upstream reference:** `formats/log/checkpoint.go` (`Checkpoint.Unmarshal`, `Checkpoint.Marshal`), `formats/log/identifier.go` (`ID`); `golang.org/x/mod/sumdb/note` (`Open`); C2SP tlog-checkpoint, signed-note

## Context

`Checkpoint.Unmarshal` takes the origin as `string(l[0])`. A Go string is a byte sequence: invalid UTF-8 is
kept verbatim, so two checkpoints whose origin lines differ in invalid bytes have different origins, and
`log.ID(origin)` hashes the raw bytes.

A JavaScript string is UTF-16 and cannot hold invalid UTF-8. The port decoded the line with a non-fatal
`TextDecoder`, which replaces each invalid sequence with U+FFFD. The conversion is lossy: distinct origin
lines (for example `0xFE` and `0xFF`) decode to the same string, `Checkpoint.marshal` re-encodes U+FFFD
rather than the original bytes, and `id()` hashes the replacement. The merkle/formats fidelity audit measured
it: every `Unmarshal` input that is valid UTF-8 is bit-identical to Go, while invalid-UTF-8 origins diverged
in the origin, in `marshal` and in `id`. An origin is an identity — `parseCheckpoint` compares it with the
expected one, and witnesses and distributors key logs by it — so a conversion that can make two identities
compare equal must not happen silently.

The specifications leave no room for such origins in practice: signed-note requires a note to be valid UTF-8
(and `note.Open` rejects anything else, in Go and here), and C2SP tlog-checkpoint defines the origin as text.
Only a caller that feeds unsigned bytes straight into `Checkpoint.unmarshal` can reach the lossy path.

## Decision

Choose the safe direction — reject — rather than document the replacement:

- `Checkpoint.unmarshal` throws `invalid checkpoint - origin is not valid UTF-8` when the origin line is not
  valid UTF-8. The check runs after upstream's own checks (too few newlines, empty origin, size, hash), so
  upstream's errors keep their precedence, and nothing is assigned to the receiver, as for every other error.
- `Checkpoint.marshal` throws the same message when `origin` contains an unpaired UTF-16 surrogate, the only
  string a JavaScript caller can build that UTF-8 cannot encode (it would otherwise be written as U+FFFD).
- `id(origin)` is unchanged: it takes a JavaScript string, every string it can be given from a checkpoint is
  now valid UTF-8, and for those it is bit-identical to Go's `ID`.
- `fromUTF8`'s documentation, which claimed to match Go's `string(b)`, now says that it matches only for valid
  UTF-8 and that invalid sequences become U+FFFD where Go keeps the bytes.

## Consequences

- Every valid-UTF-8 checkpoint behaves exactly as upstream (the differential harness: 9,783 such inputs, zero
  mismatches). Checkpoints arriving through `parseCheckpoint` cannot be affected: their note already passed
  `open`'s UTF-8 check.
- Go accepts invalid-UTF-8 origins from unsigned input; the port rejects them. That is a deliberate,
  documented divergence on input no conforming log produces.
- A Go program can construct a `Checkpoint` with an invalid-UTF-8 origin and marshal it; a TypeScript caller
  cannot represent one at all, so there is nothing to marshal.

## Alternatives considered

- **Keep U+FFFD substitution and document it.** Rejected: it keeps a silent identity collision on the one
  field that is an identity.
- **Carry the origin as bytes (`Uint8Array`).** Faithful, but it changes the type of an exported field that
  every caller compares with a string, to support input the specifications exclude.
- **Decode bytes to a string with a lossless escape (Latin-1, say).** Rejected: the origin would then differ
  from the same origin taken from a correctly decoded note, which is worse.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
