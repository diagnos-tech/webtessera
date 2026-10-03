# ADR-0020: Add `strconv`, `unicode`, `strings` and `io` stand-ins to `gostd`, and decode base64 the way Go does

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** note contributor
- **Upstream reference:** `golang.org/x/mod/sumdb/note/note.go`, `github.com/transparency-dev/formats/log/checkpoint.go`

## Context

`sumdb/note` is not mostly cryptography. It is mostly *parsing*, and it is written directly against
five Go standard library packages whose TypeScript near-equivalents differ in ways that change which
notes are accepted:

```go
func isValidName(name string) bool {
	return name != "" && utf8.ValidString(name) &&
		strings.IndexFunc(name, unicode.IsSpace) < 0 && !strings.Contains(name, "+")
}

hash, err1 := strconv.ParseUint(hash16, 16, 32)
key, err2 := base64.StdEncoding.DecodeString(key64)
name, b64, _ := strings.Cut(string(line), " ")
pub, priv, err := ed25519.GenerateKey(rand)   // rand is an io.Reader
```

Four concrete mismatches, each of which is a real acceptance difference and not a style question:

1. **`unicode.IsSpace` is not `/\s/`.** Go implements Unicode's White_Space property. JavaScript's
   `\s` is a different set: it *excludes* U+0085 NEXT LINE, which Go treats as a space, and
   *includes* U+FEFF, which Go does not. So a regex-based `isValidName` would accept a server name
   Go rejects, and reject one Go accepts. Either direction breaks interoperability with every other
   tlog implementation, and the first one is the dangerous direction.

2. **`strconv.ParseUint` is not `Number.parseInt`.** `parseInt` accepts a leading sign, accepts a
   `0x` prefix even when a base is passed, stops silently at the first unusable character (`"12a"`
   parses as `12`), and loses precision above 2^53. Upstream relies on all four rejections:
   `checkpoint_test.go` feeds `"-34"` and `"3438945738945739845734895735"` and requires errors.

3. **`base64.StdEncoding.DecodeString` is not `atob`.** See below.

4. **`io.Reader`.** `GenerateKey(rand io.Reader, name string)` takes its randomness as a parameter,
   and both upstream's test and upstream's example depend on it: `note_test.go` passes a reader that
   fails after one byte and requires an error, `example_test.go` passes an all-zero reader to get a
   deterministic key. Dropping the parameter would delete both.

ADR-0035 already established that `gostd/bytes.fromBase64` must be as strict as Go's decoder, and
made it so by validating length and alphabet before delegating to `atob`. That got *acceptance*
right. It did not get the **error text** right, and the golden fixtures pin the error text:

```
invalid checkpoint - invalid hash: illegal base64 data at input byte 25
```

Go's offsets come from a left-to-right scan of the original input, so for
`"5dyaeacGWamtVZy3Ad7Zoqudu-Oq0klgz_Nw7"` it reports byte 25 — the base64url `-` — not byte 36,
where the input runs short. A length check cannot produce that number. Go's decoder also ignores
`\r` and `\n` anywhere in the input, which the length-check version rejected.

## Decision

Four new files under `src/internal/gostd/`, each a stand-in for the Go package it is named after,
each with its own `*_test.ts`:

| File | Provides | Stands in for |
| --- | --- | --- |
| `strconv.ts` | `parseUint`, `quote`, `ErrSyntax`, `ErrRange` | `strconv.ParseUint`, `strconv.Quote` |
| `unicode.ts` | `isSpace`, `validUTF8`, `validUTF8String` | `unicode.IsSpace`, `utf8.Valid`, `utf8.ValidString` |
| `strings.ts` | `cut` | `strings.Cut` |
| `io.ts` | `Reader`, `readFull`, `EOF`, `ErrUnexpectedEOF` | `io.Reader`, `io.ReadFull` |

`gostd/bytes.ts` additionally gains `indexByte`, `lastIndex`, `hasPrefix`, `readUint32BE` and
`appendUint32BE`, which are `bytes.IndexByte`, `bytes.LastIndex`, `bytes.HasPrefix`,
`binary.BigEndian.Uint32` and `binary.BigEndian.AppendUint32`.

**`fromBase64` is rewritten as a transcription of Go's `Encoding.Decode`/`decodeQuantum`**, refining
the second half of ADR-0035's decision. It is a quantum-at-a-time scanner with Go's exact offsets and
Go's exact `\r`/`\n` handling. Its rejection vectors — 20 inputs with their offsets, and 8 accepted
inputs including embedded newlines — are taken from `base64.StdEncoding.DecodeString` running under
Go 1.25.5, recorded in `bytes_test.ts`. ADR-0035's acceptance decision is unchanged and its test
cases still pass; only the implementation and the error offsets changed.

Deliberate limits, so that no untested parser branch ships:

- `parseUint` supports bases 2–36 only. Base 0, where Go infers the base from a `0x`/`0o`/`0b`
  prefix and permits `_` separators, throws. No call site in the port uses it.
- `quote` treats every non-ASCII rune as printable rather than reproducing Go's `unicode.IsPrint`
  tables. The two differ only for non-ASCII control, format and unassigned code points. Nothing
  asserts on `quote`'s output; it exists so `parseCheckpoint`'s `got Origin %q but expected %q`
  reads like Go's for realistic origins.
- `validUTF8` delegates to `TextDecoder` in fatal mode instead of transcribing Go's `acceptRanges`
  table. Both implement Unicode Table 3-7, so the accepted sets are identical, and a transparency
  log does not need a second hand-written UTF-8 decoder.
- `splitN` still rejects an empty separator, as ADR-0035 decided.

## Consequences

- `gostd` grows from two files to six. That is the honest size of "the Go standard library that
  `sumdb/note` is written against"; the alternative was the same code inlined into `note.ts` where
  it could not be tested against Go independently.
- `fromBase64` is now ~120 lines of scanner rather than a wrapper around a platform primitive, and
  it is slower than `atob` for large inputs. Nothing in this package decodes anything larger than a
  100-byte signature, and the entry-bundle path does not use it.
- A future contributor who needs base 0 parsing, or Go's exact `unicode.IsPrint`, has to add it and test
  it. That is the intended cost.
- Changing `fromBase64` touched a file another work package owns. Its existing tests were run and
  pass unchanged; the change is strictly in the direction of more fidelity.

## Alternatives considered

- **Keep ADR-0035's length-check `fromBase64` and assert only on the error message prefix in the
  fixture tests.** Rejected: the fixture is authoritative (PORTING.md §5) and weakening an assertion
  to fit the port is exactly the move that section forbids. The offset is also genuinely useful — it
  is the only thing that tells an operator *where* a hostile checkpoint is malformed.
- **Inline the helpers into `note.ts` as module-local functions.** Rejected: `parseUint` is needed
  by `formats/log/checkpoint.ts` too, and a copy in each place is how the two drift.
- **Use `/\s/u` for `isValidName` and accept the two-code-point difference.** Rejected: it is an
  interoperability break in the accept-what-Go-rejects direction, on the function that decides
  whether a signature line is well-formed.
- **Drop `GenerateKey`'s reader parameter and always use the platform CSPRNG.** Rejected: it deletes
  upstream's error test and its deterministic example, and the example's derived key is the
  `EnochRoot` key that `note_test.go` hardcodes — a free cross-check that would have been lost.

## Review

- **Reviewer:** note reviewer (independent)
- **Verdict:** approved
- **Notes:**
  - **`fromBase64`** checked line by line against Go's `encoding/base64` `decodeQuantum` and `Decode`
    (`/usr/local/go/src/encoding/base64/base64.go`). The quantum scanner is a faithful transcription:
    the `len(src)==si` branch (`j==0` → clean end, else `CorruptInputError(si-j)`), the `\n`/`\r`
    `j--` skip, the `si-1` offset for a stray non-pad byte, the `j==2` "==" handling with its
    `CorruptInputError(len(src))` and `CorruptInputError(si-1)` offsets, and the trailing-garbage
    `CorruptInputError(si)` all match. StdEncoding is non-strict and `padChar != NoPadding`, so the
    port correctly omits the strict and NoPadding branches (dead code for this encoding). The
    `val`/`dlen` byte writes match, and `>>>` keeps the 24-bit value unsigned. Confirmed embedded
    `\r`/`\n` are skipped as Go skips them.
    - One narrow, non-blocking gap: `fromBase64` takes a JS `string` and scans by `charCodeAt`, so a
      base64 field containing a code point > U+00FF would report a *character* offset where Go
      reports a *byte* offset. Both still **reject** (a non-alphabet unit maps to `undefined`/`0xff`);
      only the offset number in the error text could differ, and only for already-malformed
      non-ASCII input. The base64 alphabet is ASCII, so every accepted input and every fixture-pinned
      rejection is unaffected. Recorded, not fixed.
  - **`unicode.isSpace`** checked against `unicode.IsSpace` + the `_White_Space` `RangeTable`
    (`/usr/local/go/src/unicode/{graphic,tables,letter}.go`). The Latin-1 switch (`\t \n \v \f \r`
    space `0x85 0xa0`) is identical, and the `> 0xFF` set (`0x1680`, `0x2000–0x200a`, `0x2028`,
    `0x2029`, `0x202f`, `0x205f`, `0x3000`) exactly reproduces `isExcludingLatin(White_Space, r)`.
    U+0085 (space, so a name with it is rejected) and U+FEFF (not a space, so accepted) both match
    Go and both differ from `/\s/` — the ADR's justification holds.
  - **`parseUint`** rejects sign, `0x`, trailing non-digits, empty, and out-of-range; `bigint`
    result; base-0/underscore intentionally unimplemented. Matches the `strconv.ParseUint` behaviours
    the checkpoint tests rely on. **`cut`** matches `strings.Cut` not-found semantics. **`io.Reader`
    / `readFull`** match `io.ReadFull`'s EOF/ErrUnexpectedEOF contract.
  - `bytes.ts` additions (`indexByte`, `lastIndex`, `hasPrefix`, `readUint32BE`/`appendUint32BE`)
    checked against `bytes.IndexByte`/`LastIndex`/`HasPrefix` and `binary.BigEndian`; `readUint32BE`
    is correctly unsigned (`>>> 0`).

## Update (2026-10-02)

- **`io.readFull` and a read of zero bytes.** Go's `io.ReadFull` retries a `Read` that returns zero
  bytes and no error, since `io.Reader` documents that as "nothing happened"; a reader that keeps
  returning it makes the loop spin forever. `readFull` instead treats such a read as the end of the
  input: `EOF` if nothing had been read, `ErrUnexpectedEOF` otherwise. A synchronous `Reader` has
  nothing to wait for between calls, so a retry could not see different input, and failing is the safer
  reading. This differs from Go only for a Reader that returns 0 and later returns bytes, which none in
  the port does. It is noted on `readFull` and pinned in `io_test.ts`.
- **`unicode.ts` is a mixed-provenance file.** `isSpace`, with its Latin-1 switch and the ranges above
  it, is derived from Go's `unicode.IsSpace` and `White_Space` table; the rest of the file is ours. Its
  header now says so, as PORTING.md section 9 prescribes for mixed files: both copyright lines, the
  derived declaration named, the Apache-2.0 notice for the remainder, and the pointer to
  `LICENSES/BSD-3-Clause-Go.txt`. `NOTICE` lists it with the other Go-derived files.

*Review of this update: pending.*
