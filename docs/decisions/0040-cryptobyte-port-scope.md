# ADR-0040: Port only the length-prefix core of `golang.org/x/crypto/cryptobyte`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** ct contributor
- **Upstream reference:** `golang.org/x/crypto@v0.46.0/cryptobyte/{builder,string,asn1}.go`; consumers are `ctonly/ct.go` and `ct_only.go`

## Context

`ctonly/ct.go` and `ct_only.go` are written entirely against `cryptobyte`, Go's TLS-style
length-prefixed encoder/decoder. TypeScript has no equivalent, so it has to be ported before either
CT file can be. The upstream package is larger than what Tessera touches: `builder.go` and
`string.go` are 351 and 184 lines, and `asn1.go` adds another 780.

Grepping every use in Tessera @ `4a6d9f9` gives the complete list of what the port has to provide:

```
cryptobyte.NewBuilder, cryptobyte.Builder{}, cryptobyte.String(...), cryptobyte.String{}
Builder:  AddUint8, AddUint16, AddUint24, AddUint64, AddBytes,
          AddUint16LengthPrefixed, AddUint24LengthPrefixed,
          SetError, Bytes, BytesOrPanic
String:   Skip, ReadUint16, ReadBytes, ReadUint16LengthPrefixed,
          ReadUint24LengthPrefixed, Empty
```

Not one ASN.1 symbol appears. Tessera's CT layer speaks the RFC 6962 / `c2sp.org/static-ct-api`
wire format, which is TLS presentation language, not DER; the certificates it handles are opaque
byte strings that it only length-prefixes. `asn1.go` exists in `cryptobyte` for callers that parse
DER, and Tessera is not one of them.

The version matters: Tessera's `go.mod` pins `golang.org/x/crypto v0.46.0`, so that is the tree the
port follows.

## Decision

Port `builder.go` and `string.go` into `src/internal/gostd/cryptobyte.ts`, covering the full
fixed-width and length-prefixed surface so the API is coherent rather than a keyhole:

- `Builder`: `addUint8`, `addUint16`, `addUint24`, `addUint32`, `addUint48`, `addUint64`,
  `addBytes`, `addUint8LengthPrefixed`, `addUint16LengthPrefixed`, `addUint24LengthPrefixed`,
  `addUint32LengthPrefixed`, `setError`, `bytes`, `bytesOrPanic`, `unwrite`, plus `newBuilder`,
  `BuildError` and `BuilderContinuation`.
- `String`: `skip`, `readUint8`, `readUint16`, `readUint24`, `readUint32`, `readUint48`,
  `readUint64`, `readUint8LengthPrefixed`, `readUint16LengthPrefixed`, `readUint24LengthPrefixed`,
  `readBytes`, `empty`, plus `length` and `bytes` (see ADR-0042).

Deliberately **not** ported:

| Upstream symbol | Why not |
| --- | --- |
| The whole `asn1` subpackage and `asn1.go` (`AddASN1*`, `ReadASN1*`, `ASN1Tag`, …) | Tessera parses no DER. Porting 780 lines of unused, security-sensitive parser would add attack surface and review burden with no caller. |
| `addLengthPrefixed`'s `isASN1` branch, `Builder.pendingIsASN1` | Reachable only from `AddASN1`. With ASN.1 gone the parameter has one possible value, so it is dropped and `addLengthPrefixed(lenLen, f)` takes two arguments. This is the only structural edit inside a ported function. |
| `NewFixedBuilder`, `Builder.fixedSize`, and the two errors it raises | It exists to write into a caller's slice without reallocating, which depends on Go's `len`/`cap` distinction. A `Uint8Array` has no spare capacity, so the concept does not survive translation (see ADR-0041). No Tessera caller uses it. |
| `Builder.AddValue`, `MarshalingValue` | A one-method interface with no Tessera implementor. Adding it would mean inventing an exported TypeScript interface that nothing satisfies. |
| `String.CopyBytes` | Copies into a caller-provided buffer, an allocation trick with no purpose here. `ct_only.go`'s own `copyBytes` helper uses `ReadBytes`, not this. |
| `String.readUnsigned` | Unexported and called only by `ReadASN1*`. |
| `Builder.AddUint48` / `String.ReadUint48` — **ported despite being unused** | Kept because omitting one width from an otherwise complete 8/16/24/32/48/64 family is the kind of asymmetry that invites a future contributor to add it back inconsistently. It costs six lines and has an upstream test. |

The corresponding upstream tests are omitted with the code: `TestASN1Int64`, `TestASN1Uint64`,
`TestPreallocatedBuffer`, `TestFixedBuilderLengthPrefixed`, `TestFixedBuilderPanicReallocate`. Every
other test in `cryptobyte_test.go` is ported, and `cryptobyte_test.ts` adds cases for the
length-prefix edges upstream does not cover directly (nesting across widths, empty children, a child
that overflows its prefix, an overflow propagating from an inner child).

The file lives in `src/internal/gostd/` rather than `src/vendor/` because it stands in for a
language facility the way `bytes.ts` and `sync.ts` do, not because Tessera depends on it as a
library. `src/vendor/` holds ports of `transparency-dev/*` and `x/mod/sumdb/note`, which are
transparency-log domain code.

`cryptobyte` is BSD-3-Clause, not Apache-2.0 like the rest of this repository. The licence text is
reproduced verbatim in the file header, and the file carries the Go Authors' copyright line
alongside ours.

## Consequences

- A future need for DER parsing (for instance, extracting a TBS certificate on the client rather
  than receiving one) means porting `asn1.go` then. That is a bounded, well-tested job, and doing it
  on demand is cheaper than carrying it unused.
- `TODO(<owner>):` the BSD-3-Clause licence of `x/crypto` must appear in whatever third-party
  licence inventory this repository grows before donation. The per-file header is necessary but not
  by itself sufficient.
- A transparency-dev reviewer diffing against `x/crypto` will find whole functions missing. This
  table is the answer to that; it is why the omissions are enumerated by name rather than described
  in the aggregate.

## Alternatives considered

- **Port `cryptobyte` in full, ASN.1 included.** Rejected: ~1000 extra lines with no caller. A DER
  parser nobody exercises is a liability, not an asset, and its tests would be the only thing
  keeping it honest.
- **Port only the eleven methods Tessera calls.** Rejected: the result is not a usable `Builder`.
  `addUint32LengthPrefixed` without `addUint32`, or a `String` that can read a uint16 but not a
  uint8, reads as a half-finished transliteration and pushes the next caller into extending it
  inconsistently.
- **Skip `cryptobyte` and hand-roll the CT encoding inline.** Rejected outright. The deferred
  length-prefix mechanism is exactly where a hand-rolled encoder goes wrong, and `ct.go`'s structure
  — nested continuations that backfill their own lengths — would have to be flattened, destroying
  the line-by-line correspondence that makes the CT port reviewable.

## Review

- **Reviewer:** gostd Reviewer
- **Verdict:** approved
- **Notes:** Diffed `cryptobyte.ts` against `golang.org/x/crypto@v0.46.0/cryptobyte/
  {builder,string}.go`. Enumerated the exported surface both ways: every `Builder` and `String`
  symbol the ADR lists as ported is present under the ADR-0002 mapping, and every omission in the
  "not ported" table is genuinely unused in Tessera @ 4a6d9f9 — confirmed by grep that `CopyBytes`,
  `ReadUint32LengthPrefixed`, `readUnsigned`/`ReadUnsigned` have zero call sites upstream, and that
  `ct_only.ts`'s own `copyBytes` helper is a distinct function built on `readBytes`, not
  `String.CopyBytes`. The one structural edit the ADR claims — dropping `addLengthPrefixed`'s
  `isASN1` parameter so it takes `(lenLen, f)` — is exactly what the code does; no other ported
  function is altered. `AddUint48`/`ReadUint48` are present despite being unused, as stated. The
  omitted upstream tests (`TestASN1*`, the fixed-builder tests) correspond to omitted code. BSD-3
  header is reproduced verbatim with the Go Authors' copyright line intact. The `TODO(<owner>):`
  third-party-licence-inventory obligation (line 79) is real and remains open.

## Update (2026-10-02)

The third-party licence inventory this ADR called for now exists: `NOTICE` lists
`golang.org/x/crypto/cryptobyte` among the Go-derived sources and `LICENSES/BSD-3-Clause-Go.txt`
carries the licence text. None of the decisions above changed.

## Update (2026-10-02)

A fidelity audit found three statements above that no longer hold, or never did:

- **`example_test.go` was not accounted for.** "Every other test in `cryptobyte_test.go` is ported"
  spoke of that one file; upstream's other test file, `example_test.go`, was dropped without a word.
  Its four non-ASN.1 Examples (`ExampleString_lengthPrefixed`, `ExampleBuilder_lengthPrefixed`,
  `ExampleBuilder_lengthPrefixOverflow`, `ExampleBuilderContinuation_errorHandling`) are now ported as
  assertion tests in `cryptobyte_example_test.ts`, as ADR-0033 prescribes. `ExampleString_aSN1` and
  `ExampleBuilder_aSN1` stay unported with the ASN.1 code they demonstrate.
- **`TestPreallocatedBuffer` is ported after all.** It was listed above as omitted with the fixed-size
  builder, as if it depended on Go's slice capacity, which a `Uint8Array` lacks. It can be expressed
  anyway: see the update to ADR-0041. The omitted tests are now `TestASN1Int64`, `TestASN1Uint64`, `TestFixedBuilderLengthPrefixed`
  and `TestFixedBuilderPanicReallocate`, so 19 of the 23 tests in `cryptobyte_test.go` are ported.
- **The licence text is no longer reproduced in the file header.** "The licence text is reproduced
  verbatim in the file header" is superseded by PORTING.md section 9: `cryptobyte.ts` carries the Go
  Authors' copyright line, ours, and the short pointer to `LICENSES/BSD-3-Clause-Go.txt`, like the
  other ports of Go-licensed files. `cryptobyte_example_test.ts` is listed in `NOTICE` with the others.

Declaration order in `cryptobyte.ts` now follows `builder.go`: `Builder`, `NewBuilder`,
`BuilderContinuation`, `BuildError`, then `String`. A class body cannot be interleaved with the
declarations Go places between a type's methods, so `newBuilder` sits directly above the class and
`BuilderContinuation` and `BuildError` directly below it, in Go's order.

*Review of this update: pending.*
