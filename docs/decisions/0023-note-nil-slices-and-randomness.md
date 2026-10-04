# ADR-0023: `Note`'s signature lists are optional, and `generateKey` keeps its randomness parameter

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** note contributor
- **Upstream reference:** `golang.org/x/mod/sumdb/note/note.go`, `note_test.go`, `example_test.go`

## Context

Two small shape questions in `sumdb/note`, both of which upstream's tests answer for us.

**Nil slices.** `Note` has two slice fields, and the overwhelmingly common construction leaves both
nil:

```go
type Note struct {
	Text           string
	Sigs           []Signature
	UnverifiedSigs []Signature
}

msg, err := note.Sign(&note.Note{Text: text}, signer)   // both nil
```

`Open` also returns a note with `UnverifiedSigs` nil when every signature verified, and `Sign`'s
loop is written as `for _, list := range [][]Signature{n.Sigs, n.UnverifiedSigs}`, which handles nil
and empty identically. So nil-ness is not observable to `Sign`, but it *is* the ergonomic default
for constructing a note.

**Randomness.** `GenerateKey` takes an `io.Reader`:

```go
func GenerateKey(rand io.Reader, name string) (skey, vkey string, err error)
```

Both upstream tests use that parameter for something a fixed CSPRNG could not provide.
`TestGenerateKey` passes `iotest.TimeoutReader(iotest.OneByteReader(rand.Reader))` and requires an
error. `ExampleSign_add_signatures` passes an all-zero reader, which makes the derived `EnochRoot`
key deterministic — and that derived key is byte-for-byte the `EnochRoot` verifier key that
`note_test.go` hardcodes in `TestOpen` and `TestVerifierList`.

## Decision

**`Note.sigs` and `Note.unverifiedSigs` are optional properties.** This is the faithful rendering of
a nil slice: absent means "none", exactly as `len(nil) == 0`. `sign` accepts a note with either or
both omitted; `open` always populates both with arrays, so a caller who obtained a note from `open`
never sees `undefined`.

```ts
export interface Note {
	text: string;
	sigs?: Signature[];
	unverifiedSigs?: Signature[];
}
```

Consumers read them as `n.sigs ?? []`, which is what `formats/log/note.ts` does and what the Go
`range` over a nil slice does.

**`generateKey` keeps the reader**, as `Reader | undefined`:

```ts
export function generateKey(rand: Reader | undefined, name: string): { skey: string; vkey: string }
```

`undefined` means "use the platform CSPRNG", which is what Go's nil `io.Reader` means to
`ed25519.GenerateKey`. A supplied reader is drained with `readFull` for exactly 32 bytes, matching
Go's `io.ReadFull(rand, seed)` over `ed25519.SeedSize`. `Reader` and `readFull` live in
`gostd/io.ts` (ADR-0020).

The two returned keys come back in an object per ADR-0031.

## Consequences

- Two optional properties mean callers write `n.sigs?.[0]` or `n.sigs ?? []`. That is noisier than a
  guaranteed array, and it is what makes the nil/empty distinction visible instead of guessed at.
- A single `Note` type serves both construction and results, so there is no `NoteInput`/`Note` pair
  to keep in sync. `open`'s stronger guarantee — both fields always present — is documented rather
  than encoded in the type. A reviewer who wants it in the type can propose a follow-up ADR.
- Keeping the reader parameter means `generateKey(undefined, name)` is the common call, which reads
  slightly oddly. The payoff is that `example_test.ts` derives
  `EnochRoot+af0cfe78+ATtqJ7zOtqQtYqOo0CpvDXNlMhV3HeJDpjrASKGLWdop` from an all-zero seed and
  asserts it against the key upstream hardcodes elsewhere — an end-to-end check of the seed length,
  the public key derivation, the key hash preimage and the encoding, in one line.
- `Reader` cannot express Go's "n bytes read *and* an error" from a single call. `readFull`
  documents that a Reader with bytes to deliver must return them and report the error on the next
  call, which is how every Reader in this port and its tests behaves.

## Alternatives considered

- **Required `sigs: Signature[]` with a separate `SignableNote` input type.** Rejected: two types
  for one Go struct, and the seam between them is where a future bug lives.
- **Required `sigs: Signature[]` and make callers pass `[]`.** Rejected: `sign({ text }, signer)` is
  the single most common call in the package and upstream writes it with no slices at all.
- **Drop the reader; always use `crypto.getRandomValues`.** Rejected: deletes upstream's
  error-propagation test and its deterministic example, and with it the cross-check above.
- **Type the reader as a plain function `(p: Uint8Array) => number`.** Rejected: `io.Reader` is an
  interface in Go and the ported `zeroReader`/`timeoutOneByteReader` read as classes implementing
  it, which keeps `example_test.ts` diffable against `example_test.go`.

## Review

- **Reviewer:** note reviewer (independent)
- **Verdict:** approved
- **Notes:**
  - Optional `sigs`/`unverifiedSigs` is the faithful rendering of Go's nil slices: `sign` reads both
    as `?? []`, matching Go's `range` over `[][]Signature{n.Sigs, n.UnverifiedSigs}` where nil and
    empty behave identically; `open` always populates both. Confirmed `sign({ text }, signer)` — the
    common no-slices construction — works and is byte-identical to Go via the fixtures.
  - `generateKey(rand, name)` keeps the `Reader | undefined` parameter. Verified `readFull` drains
    exactly 32 bytes (`ed25519.SeedSize`), that `undefined` uses the platform CSPRNG, that
    `timeoutOneByteReader` triggers the error path (`TestGenerateKey`), and that `zeroSeedReader`
    reproduces `EnochRoot+af0cfe78+…` — the key `note_test.go` hardcodes — end to end.
