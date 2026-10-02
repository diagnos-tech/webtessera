# ADR-0022: `parseCheckpoint` returns a result object and throws an error that carries the note

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** note contributor
- **Upstream reference:** `github.com/transparency-dev/formats/log/note.go`, `log/note_test.go`

## Context

`log.ParseCheckpoint` is the one function in this work package whose Go signature does not fit
ADR-0004's "errors are thrown" rule, because it returns useful data *together with* its error:

```go
func ParseCheckpoint(chkpt []byte, origin string, logVerifier note.Verifier, otherVerifiers ...note.Verifier) (*Checkpoint, []byte, *note.Note, error)
```

Its doc comment is explicit that this is intended:

> In all other cases, an empty checkpoint is returned. **The underlying note is always
> returned where possible.**

And upstream's own test depends on it. `TestParseCheckpoint` has twelve cases, four of which expect
an error *and* a non-zero signature count:

```go
_, _, n, err := log.ParseCheckpoint(nBs, test.logID, logVerifier, known1Verifier, known2Verifier)
if gotErr := err != nil; gotErr != test.wantErr { ... }
gotSigs := 0
if n != nil { gotSigs = len(n.Sigs) }
if gotSigs != test.wantSigs { ... }
```

The `"just known"` case — a checkpoint correctly signed by two witnesses but not by the log — is
an error with two verified signatures. Discarding the note on the error path would delete that case,
and would also delete the information a real caller wants: *which* keys did sign this thing, so the
operator can tell a witness misconfiguration from an attack.

ADR-0031 already settled that a Go multi-value return becomes a named `readonly` result object. It
did not cover the case where the error path carries data too.

## Decision

Success returns a result object, per ADR-0031:

```ts
export interface ParsedCheckpoint {
	checkpoint: Checkpoint;
	otherData: Uint8Array | undefined;
	note: Note;
}
```

Failure throws **`ParseCheckpointError`**, an `Error` subclass with a `note: Note | undefined`
field. `note` is populated on every path where Go returns one, and is `undefined` only when the note
could not be opened at all — which is precisely when Go returns `nil` for it.

This is the same shape upstream already chose for `note.UnverifiedNoteError`, which carries a `*Note`
on its error, so it is not a new idea in this codebase; it is the existing idea applied to the one
other function that needs it.

Message text is Go's, verbatim: `failed to verify signatures on checkpoint: …`,
`failed to unmarshal checkpoint: …`, `got Origin %q but expected %q`, `no log signature found on
note`. The `%q` rendering uses `gostd/strconv.quote` (ADR-0020).

**The wrapped error is not set as `cause`.** Go formats all three wrapped cases with `%v`, not `%w`,
so `errors.Is` cannot see past the boundary in Go. Setting `cause` would make `errorIs` see past it
in TypeScript, which is a behavioural divergence in the permissive direction — a caller testing
`errorIs(e, errMalformedNote)` would get `true` here and `false` in Go. The message text still
carries the underlying reason, so nothing diagnostic is lost.

## Consequences

- A caller who wants the note after a failure must catch and read `.note`, where a Go caller reads
  the third return value. That is more ceremony, and it is the price of ADR-0004's rule.
- `ParseCheckpointError` is a new exported type with no Go counterpart, so it must be listed in the
  donation notes as an addition rather than a translation.
- Losing the `cause` chain costs a stack trace at the wrap point. The thrown error's own stack still
  points at `parseCheckpoint`, and the message names the cause. Faithfulness to Go's error identity
  was judged the more important of the two for a verification function.
- If upstream ever changes `%v` to `%w` — which would be an improvement — this ADR should be revised
  to set `cause`, and `errorIs` would then match on both sides.

## Alternatives considered

- **Throw a plain `Error` and drop the note.** Rejected: deletes four upstream test cases and the
  operational signal they represent.
- **Return `{ checkpoint?, otherData?, note?, error? }` and never throw.** Rejected: it makes the
  single most security-relevant call in the package one that a caller can get wrong by forgetting to
  check a field, and it diverges from ADR-0004 for one function.
- **Return the note through an out-parameter object the caller passes in.** Rejected: it is the
  cryptobyte pattern (ADR-0042) applied where there is no Go out-parameter to justify it.
- **Set `cause` anyway, for debuggability.** Rejected on fidelity grounds; recorded here so a
  reviewer can overrule it deliberately rather than by accident.

## Review

- **Reviewer:** note reviewer (independent)
- **Verdict:** approved
- **Notes:**
  - Checked `parseCheckpoint` against `formats/log/note.go` `ParseCheckpoint` branch by branch: the
    `note.Open` failure, the `n.Sigs` scan matching `s.Hash == logVerifier.KeyHash() && s.Name ==
    logVerifier.Name()`, the `Unmarshal` failure, the origin mismatch, and the "no log signature
    found on note" fall-through all correspond, in order. Message text is verbatim (`%v` rendered via
    `errText`, `%q` via `gostd/strconv.quote`).
  - `ParseCheckpointError.note` carries the opened note on every path Go returns one, and is
    `undefined` only when `open` itself threw — exactly Go's `nil`. Verified `note_test.ts`'s four
    error-with-signatures cases (`"bad body good sigs"`, `"just known"`, `"all sigs but wrong
    logID"`) recover the signature count through `.note`, matching upstream's third return value.
  - The decision **not** to set `cause` (because Go wraps with `%v`, not `%w`) is correct and
    preserves Go's `errors.Is` boundary; agreed and not disputed.
