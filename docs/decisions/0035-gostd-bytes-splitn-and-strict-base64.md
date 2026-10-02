# ADR-0035: Add `splitN` to `gostd/bytes` and make `fromBase64` as strict as Go's decoder

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** layout agent
- **Upstream reference:** `internal/parse/parse.go`, `internal/parse/parse_test.go`

## Context

`internal/parse.CheckpointUnsafe` is four lines of Go standard library:

```go
parts := bytes.SplitN(rawCp, []byte{'\n'}, 4)
if want, got := 4, len(parts); want != got { ... }
size, err := strconv.ParseUint(sizeStr, 10, 64)
hash, err := base64.StdEncoding.DecodeString(hashStr)
```

Two of those had no counterpart in `src/internal/gostd/`, and one of them had a counterpart that was
wrong in a way the upstream tests catch.

**`bytes.SplitN`.** No equivalent existed. The cap of 4 is not decoration: it is what puts the note
signature block into the last element instead of splitting it, and the `len(parts) != 4` check is
what rejects a checkpoint with no origin line.

**`base64.StdEncoding.DecodeString`.** `fromBase64` existed and delegated to `atob`. `atob`
implements WHATWG *forgiving-base64*: it strips ASCII whitespace and accepts input whose length is
2 or 3 mod 4, i.e. missing padding. Go's `StdEncoding` accepts neither. `parse_test.go`'s "Bad hash"
case is exactly this difference:

```go
{ desc: "Bad hash", cp: "original.example.com\n42\nthisisnotright\n", wantErr: true },
```

`"thisisnotright"` is 14 characters of valid alphabet. Go rejects it (14 is not a multiple of 4);
`atob` decodes it to 10 bytes and reports success. Ported as it stood, the test would have failed —
and had it been "fixed" by weakening the assertion, the port would silently accept malformed
checkpoint hashes from a hostile log.

## Decision

Two changes to `src/internal/gostd/bytes.ts`, both covered by new cases in `bytes_test.ts`:

1. **Add `splitN(s, sep, n): Uint8Array[]`**, mirroring `bytes.SplitN`: at most `n` subslices, the
   last being the unsplit remainder; `n < 0` returns every subslice; `n === 0` returns none. The
   returned subslices are `subarray` views, as Go's are. An empty separator throws rather than
   implementing Go's `explode` behaviour, which nothing in this port uses.

2. **Make `fromBase64` as strict as `base64.StdEncoding.DecodeString`**, rather than as lenient as
   `atob`. Unpadded input, input whose length is not a multiple of 4, `=` anywhere but the final one
   or two characters, and characters outside the standard alphabet (`+` and `/`, not the URL-safe
   `-` and `_`) are all rejected, with Go's message: `illegal base64 data at input byte N`.

Note that this second change makes `fromBase64` **reject input it previously accepted**. That is the
point, and the doc comment already claimed `StdEncoding` semantics — the function was not doing what
it said.

**Implementation history.** This work package landed the strictness as a validation pass in front of
`atob`. The gostd work package subsequently replaced that with a direct transcription of Go's
`Encoding.Decode`/`decodeQuantum`, which is strictly better and is what is in the tree now: it also
reproduces Go's *acceptance* of `\r` and `\n` anywhere in the input (which `StdEncoding` skips and
the validation pass wrongly rejected), and Go's rejection **offsets**, which are positions reached by
a left-to-right scan and cannot be derived from a length check. The decision recorded here — that
`fromBase64` follows Go and not the platform — is unchanged; only the mechanism is.

Related, and deliberately *not* done: `strings.TrimPrefix`, `strings.TrimSuffix` and `strings.Count`
are needed by `api/layout/paths.ts` and are one-liners over TypeScript built-ins. They live as
unexported helpers at the bottom of `paths.ts` rather than in `gostd/strings.ts`, which is reserved
for shims with behaviour of their own (`cut`). A comment in `paths.ts` says so.

## Consequences

- Any existing caller of `fromBase64` that was relying on unpadded input now throws. At the time of
  writing the only callers are `internal/parse` and `bytes_test.ts`, but `sumdb/note` and
  `formats/log` will both decode base64 and both must be strict — Go is, and a note with a
  mis-padded signature must not verify.
- Spaces and tabs are rejected; `\r` and `\n` are not, because `StdEncoding` skips those two and only
  those two. That asymmetry looks arbitrary until you need it: `sumdb/note` decodes a signature line
  whose server name must not contain a space, and `atob`'s blanket whitespace-stripping would have
  turned a malformed signature line into a valid-looking signature.
- `splitN` is O(n·m) with a naive substring search. Both call sites split on a single byte over a
  checkpoint of a few hundred bytes. Not worth anything cleverer.
- The rejection offsets are now Go's exact offsets, and the golden fixtures assert them. They were
  approximate under the first implementation; anything that relied on the approximate value would
  have been wrong.

## Alternatives considered

- **Leave `fromBase64` lenient and validate inside `internal/parse`.** Rejected: the leniency would
  stay lying in wait for `note` and `formats/log`, whose correctness depends on the same strictness,
  and the check belongs with the decoder, not with each caller.
- **Validate and then delegate to `atob`.** This is what this work package originally did, on the
  reasoning that `atob` is in every target runtime and is the fast path, so once the input is
  validated the two agree. That reasoning was wrong in both directions: a length-and-alphabet check
  cannot reproduce Go's `\r`/`\n` acceptance, and it cannot reproduce Go's rejection offsets. The
  transcription in the tree now is the correct answer.
- **Put `splitN` in `internal/parse` as a local helper.** Rejected: it is a `bytes` function, other
  packages (`formats/log`'s checkpoint parser, `note`) will want it, and `gostd/` exists precisely so
  a reviewer can see at a glance which code stands in for the Go standard library.

## Review

- **Reviewer:** Layout Reviewer (2026-08-19)
- **Verdict:** approved (scoped — see notes)
- **Notes:** Reviewed as the layout/parse reviewer; the full `gostd/` audit is a separate reviewer's
  package, so I checked only what this ADR touches for `internal/parse`. Confirmed the ADR is honest
  about the current tree: `bytes.ts`'s `fromBase64` is now a transcription of Go's
  `Encoding.Decode`/`decodeQuantum` (bytes.ts:321–428), NOT the atob-with-validation approach the ADR
  originally landed — the "Implementation history" and "Alternatives" sections say exactly this, so it
  does not describe a version that no longer exists. `splitN` (bytes.ts:81) mirrors `bytes.SplitN`:
  `n===0 → []`, empty separator throws, subslices are `subarray` views; traced the checkpoint path
  and it yields the 4-part split the `!== 4` check depends on. Verified the strictness the ADR exists
  for: `"thisisnotright"` (parse_test.go "Bad hash") is rejected by the ported decoder, matching Go.
  Deferring to the gostd reviewer: the exhaustive fidelity of `decodeQuantum`'s rejection *offsets*
  and `\r`/`\n` handling against Go 1.25.5 (that is ADR-0020's territory, which this ADR now defers
  to for the mechanism).

- **Reviewer:** gostd Reviewer (agent) — taking the deferral above
- **Verdict:** approved
- **Notes:** Diffed `fromBase64`/`decodeQuantum` (bytes.ts:321–428) against
  `/usr/local/go/src/encoding/base64/base64.go` (Go 1.25.5) branch by branch. Faithful
  transcription of `Encoding.decodeQuantum`: the short-final-quantum `CorruptInputError(si - j)`
  (StdEncoding's `padChar != NoPadding` case always fires for `j >= 1`), the `'\n'`/`'\r'` skip
  (`j--; continue`), the `j == 0 || j == 1` incorrect-padding branch, the `j == 2` second-`=`
  handling with `CorruptInputError(len(src))` and `CorruptInputError(si-1)`, the trailing-newline
  skip and trailing-garbage `CorruptInputError(si)`, and the final `dbuf`→`dst` write for `dlen`
  2/3/4. Independently hand-traced the offsets the fixtures pin: the base64url `-` in the 37-char
  vector lands at byte 25, and `"Zg"`/`"Z==="`/`"Zm9v=YmFy"`/`"Zm9vYg==x"` give 0/1/4/8 — all
  match Go. `\r`/`\n` acceptance verified on `"Zm9v\r\nYmFy\n"` and a leading `"\nZm9v"`. Go's
  `assemble32`/`assemble64` fast paths are omitted with no behavioural effect: they only fire when
  every byte is in-alphabet and yield exactly what `decodeQuantum` would. Non-`strict` mode is the
  correct match for `StdEncoding.DecodeString`. One non-blocking subtlety I could not make diverge
  but note anyway: `fromBase64` indexes `decodeMap` by `charCodeAt` (a UTF-16 unit), so for
  hypothetical non-ASCII input the rejection offset would count UTF-16 units rather than Go's UTF-8
  bytes; base64 input is ASCII by construction. `splitN` re-confirmed against `bytes.SplitN` for
  `n<0`/`n==0`/cap/remainder/empty-input. The `hex.DecodeString` error *text* diverges from Go
  (`fromHex` reports `invalid byte at offset N` and appends the count to the odd-length message,
  where Go says `invalid byte: U+00XX 'x'` and uses a bare `ErrLength`); out of this ADR's scope,
  no fixture asserts on it, flagged in the review report.
