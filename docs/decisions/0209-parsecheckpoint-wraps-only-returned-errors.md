# ADR-0209: `parseCheckpoint` wraps the port's returned errors, not programming errors

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** hardening agent
- **Upstream reference:** `formats/log/note.go` (`ParseCheckpoint`); ADR-0004, ADR-0021, ADR-0022

## Context

Go's `ParseCheckpoint` turns every *error* returned by `note.Open` and `Checkpoint.Unmarshal` into its own
error (`failed to verify signatures on checkpoint: %v`, `failed to unmarshal checkpoint: %v`). A Go panic — a
nil dereference, an index out of range in a buggy `Verifier` — is not an error return and propagates through it
untouched.

The port throws for both. `parseCheckpoint` caught everything and flattened it into a `ParseCheckpointError`
message (audit finding F24), so a `TypeError` from a bug in a custom verifier surfaced as "failed to verify
signatures on checkpoint: Cannot read properties of undefined", indistinguishable from a bad signature. A caller
that treats `ParseCheckpointError` as "this checkpoint is invalid, try another source" then hides the bug.

## Decision

`parseCheckpoint` wraps a caught value only if it is an `Error` that is not a `TypeError`, `RangeError`,
`ReferenceError` or `SyntaxError` — the classes JavaScript raises where Go would panic. Anything else, and any
thrown non-`Error`, is rethrown unchanged. Every error class `sumdb/note` and `Checkpoint.unmarshal` use for their
results (`SentinelError`, `UnverifiedNoteError`, `InvalidSignatureError`, `ambiguousVerifierError`,
`UnknownVerifierError`, plain `Error`s, `NumError`) is a plain `Error` or a subclass of it and is still wrapped,
with upstream's text.

## Consequences

- Every error upstream's `ParseCheckpoint` returns is still reported as a `ParseCheckpointError` with the same
  message; all ported tests and the formats/log fixtures are unchanged.
- A custom `Verifier`/`Verifiers` that wants its failure reported as a parse failure must throw an `Error` that
  is not one of the four classes above — which is what returning an `error` maps to (ADR-0004).

## Alternatives considered

- **Keep wrapping everything.** Rejected: it hides programming errors behind a security-relevant error type.
- **Wrap only known classes from `note.ts`.** Rejected: Go wraps *any* error a custom `Verifiers` returns
  ("If known.Verifier returns any other error, Open returns that error"), and an allow-list would turn those
  into unwrapped throws.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `ParseCheckpoint` wraps what `note.Open` and `Unmarshal` return; a panic passes through. TS `note.ts` `isReturnedError` wraps a caught `Error` unless it is a `TypeError`, `RangeError`, `ReferenceError` or `SyntaxError`, and rethrows those and any non-Error unchanged; the messages and `ParseCheckpointError.note` are as before. Every error class the note and checkpoint code throw for results is a plain `Error` or subclass (`SentinelError`, `NumError`, the note errors).
  - Checked that no legitimate failure of the port turns into a raw error: I fuzzed `parseCheckpoint` with 60,000 mutated fixture checkpoints (bit flips, truncations, inserted control/non-ASCII bytes) and every outcome was either success (451) or `ParseCheckpointError` (59,549); no `TypeError` or `RangeError` escaped. A direct probe of `multiplyUnsafe(0n)` in the Ed25519 path, which could have been a source, does not throw. The test 'wraps returned errors but lets panic-like errors through unchanged' exists in `formats/log/note_test.ts`.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
