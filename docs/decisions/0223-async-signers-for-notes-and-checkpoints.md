# ADR-0223: Add asynchronous signers to note signing and checkpoint publication, additively

- **Status:** accepted
- **Date:** 2026-10-03
- **Author:** DX guardrails agent
- **Upstream reference:** golang.org/x/mod `sumdb/note/note.go` (`Signer`, `Sign`); tessera
  `append_lifecycle.go` (`WithCheckpointSigner`, `CheckpointPublisher`)

## Context

Go's `note.Signer.Sign(msg []byte) ([]byte, error)` is synchronous, and so is the `newCP` function that
`WithCheckpointSigner` installs:

```go
o.newCP = func(ctx context.Context, size uint64, hash []byte) ([]byte, error) {
	...
	cpRaw, err := note.Sign(&n, s, additionalSigners...)
```

The port keeps both synchronous (`src/vendor/note/note.ts`; `#newCP` in `src/append_lifecycle.ts`). WebCrypto
is not: `crypto.subtle.sign` returns a Promise, and a non-extractable key (ADR-0222) cannot be handed to a
synchronous implementation instead. Without an asynchronous path, the safe API could not sign with the keys it
exists to protect.

## Decision

Three additions, each with no upstream counterpart and each marked so in its doc comment:

1. **`AsyncSigner`** in `src/vendor/note/note.ts`: `Signer` with `sign(msg): Promise<Uint8Array>`.
2. **`signAsync(n, ...signers)`** in the same file, taking any mix of `Signer` and `AsyncSigner`. It is `sign`:
   it checks the note's final newline, then for each signer in order checks its name with `isValidName`, awaits
   its signature over the note's text, and finally hands the signatures, as synchronous signers that return
   them, to the unchanged `sign`. The encoding is therefore `sign`'s by construction, and so are its errors and
   their order: a malformed note is refused before any signer is asked, an invalid name before that signer is
   asked, and a malformed existing signature after signing, as in `sign`; a signer's own rejection passes through
   unchanged.
3. **`AppendOptions.withCheckpointAsyncSigner(s, ...additionalSigners)`** in `src/append_lifecycle.ts`: the same
   body as `withCheckpointSigner` (origin from the primary signer, the same additional-signer name check and
   message, the RFC 6962 empty root for size 0, `wrapError("note.Sign", …)`), calling `signAsync`. Like
   `withCheckpointSigner` it replaces any signer set before it. `#newCP`'s type becomes
   `(size, hash) => Uint8Array | Promise<Uint8Array>`, and `checkpointPublisher` awaits the result **only when it
   is not a `Uint8Array`**, so a synchronous signer's checkpoint is computed with no extra microtask, exactly as
   before.

These are the only changes to ported files the safe API makes. `signAsync` lives in the note port, which is
BSD-3-Clause (ADR-0024); MedDeck's contribution in that file is under the same licence, whose header already
carries the MedDeck line.

## Consequences

- The synchronous path is untouched: every golden, fixture and differential test of `sign`, `newSigner` and
  `checkpointPublisher` passes unchanged.
- **Byte identity is tested, not assumed.** Ed25519 (RFC 8032) is deterministic, so a WebCrypto key must sign
  exactly as @noble/curves does with the same seed. `src/safe/testing/golden.ts` imports every key of the Go
  fixture `note.json` into a non-extractable WebCrypto key and replays every `sign` case of that fixture through
  `signAsync` (byte-identical to Go's output, error cases included), compares each with the synchronous ported
  signer, and publishes the checkpoints of `log_1`, `log_256` and `log_5000` through
  `withCheckpointAsyncSigner`, which must equal the checkpoints the real Tessera POSIX driver wrote. It runs in
  Node (`src/safe/keys_test.ts`), Chromium (`src/browser/log_browser_test.ts`) and workerd
  (`src/server/server_workers_test.ts`). `src/append_lifecycle_async_test.ts` and
  `src/vendor/note/note_async_test.ts` cover the rest, including `MaxUint64` sizes and error order.
- A future upstream asynchronous signer, should one appear, would likely take a different shape; this ADR would
  then be superseded by a port of it.

## Alternatives considered

- **Widen `Signer.sign` to return `Uint8Array | Promise<Uint8Array>`.** Rejected: every caller of the ported
  synchronous `sign` and `open` would have to handle a Promise, a divergence spread across the note port, the
  cosignature port and the witness server.
- **Make `#newCP` always async.** Rejected: an `await` on every checkpoint adds a microtask to the path every
  Go-equivalent configuration takes; the requirement is that it stay identical.
- **Re-implement the note encoding for the async path.** Rejected: two encoders would have to be kept equal by
  tests; delegating to `sign` makes them equal by construction.
- **Sign in parallel.** Rejected: signers are few, ordering then matches `sign`'s, and a hardware or remote signer
  is not obliged to be re-entrant.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `signAsync` (`src/vendor/note/note.ts`) against `sign`: same final-newline check, then the UTF-8 check added by ADR-0203's update, then for each signer in order the `isValidName` check before `await s.sign`, then `sign(n, ...stubs)`. So the error order is `sign`'s: malformed note before any signer is asked, invalid name before that signer is asked, a malformed existing signature after signing, a signer's rejection unchanged. `withCheckpointAsyncSigner` has the body of `withCheckpointSigner` (origin, additional-signer name check and message, empty root for size 0, `wrapError("note.Sign", ...)`), and `checkpointPublisher` awaits only a non-`Uint8Array` result, so the synchronous path runs as before.
  - `describeWebCryptoGolden` (`src/safe/testing/golden.ts`) does what the ADR claims: imports every `note.json` key into a non-extractable WebCrypto key, replays every `sign` case through `signAsync` (errors included, by message), compares each success with the synchronous noble signer, and publishes `log_1`, `log_256` and `log_5000` through `withCheckpointAsyncSigner` against the checkpoints the Go POSIX driver wrote. It passes in Node, Chromium (8 files / 265 tests) and workerd (8 files / 300 tests). `append_lifecycle_async_test.ts` covers sizes 0, 1, 255, 256 and MaxUint64; `note_async_test.ts` covers ordering and the UTF-8 refusal.
  - "These are the only changes to ported files the safe API makes" is overtaken by ADR-0224's first Update (`src/witness.ts` now uses the shared `Scanner`); non-blocking, the change is recorded in that ADR.
