# ADR-0042: `cryptobyte` errors throw, and `String` reads return the value instead of a bool plus out-parameter

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** ct contributor
- **Upstream reference:** `golang.org/x/crypto@v0.46.0/cryptobyte/{builder,string}.go`; consumers are `ctonly/ct.go` and `ct_only.go`

## Context

`cryptobyte` uses three Go-specific signalling conventions, and all three appear in the CT files
that consume it.

**1. Two ways to get the bytes out.** `Bytes() ([]byte, error)` and `BytesOrPanic() []byte`. Tessera
uses both, sometimes within the same call chain — `extensions.Marshal` returns `b.Bytes()`, and its
caller `addExtensions` feeds the error back in with `b.SetError(err)`, while `Entry.LeafData` ends
with `b.BytesOrPanic()`.

**2. Panic as a control-flow channel.** A `BuilderContinuation` that panics with a `BuildError` has
its inner error captured and reported from `Bytes`; any other panic is re-raised. That is how an
error inside a nested continuation reaches the outermost builder.

**3. Bool return plus pointer out-parameter for every read.**

```go
func (s *String) ReadUint16(out *uint16) bool
func (s *String) ReadUint24LengthPrefixed(out *String) bool
```

which `ct_only.go` uses as the spine of its parser loop:

```go
var entryType uint16
if !b.ReadUint16(&entryType) {
	return nil, fmt.Errorf("failed to read entry type of entry index %d of bundle", i)
}
```

PORTING.md §3.6 settles (1) and (2): `error` returns become thrown `Error`s. It says nothing about
out-parameters, because no other file in the port has them.

There is also a naming collision: `cryptobyte.String` shadows the JavaScript global `String`.

## Decision

**Errors throw, and `bytes`/`bytesOrPanic` are both kept.** In TypeScript there is exactly one
failure channel, so the two methods have identical bodies: throw `err` if set, otherwise return the
bytes. They are both kept anyway, so that `b.BytesOrPanic()` in `ct.go` ports to `b.bytesOrPanic()`
and `return b.Bytes()` ports to `return b.bytes()`, and a reviewer diffing the two files sees the
same word in the same place. A `// Port note:` on `bytes` says why the pair is redundant.

`SetError` keeps its name and its semantics unchanged: writes after it are ignored, and the error
surfaces at `bytes()`.

**`BuildError` extends `Error`.** Upstream's is a bare struct used only as a panic payload. Throwing
a non-`Error` in JavaScript loses the stack trace in every runtime and trips `instanceof Error`
checks in test frameworks and error reporters. It extends `Error`, keeps its inner error in an `err`
field (Go's exported `Err`, camelCased per PORTING.md §3.2), and also sets it as `cause` so
`errorIs`/`errorAs` from `gostd/errors.ts` can walk it. `callContinuation` catches, tests
`instanceof BuildError`, assigns `this.err = r.err`, and rethrows anything else — Go's `recover` and
type assertion, one for one. The `try`/`finally` also clears the shared `inContinuation` flag before
the rethrow, matching the order of Go's deferred function.

The programming-error panics keep their exact messages and become thrown `Error`s:
`"cryptobyte: attempted write while child is pending"`,
`"cryptobyte: attempted unwrite while child is pending"`,
`"cryptobyte: attempted to unwrite negative number of bytes"`,
`"cryptobyte: attempted to unwrite more than was written"`,
`"cryptobyte: internal error"`.

**`String` read methods return `T | undefined`, where `undefined` means Go's `false`.**

```ts
readUint16(): number | undefined
readUint24LengthPrefixed(): String | undefined
```

and the parser loop becomes

```ts
const entryType = b.readUint16();
if (entryType === undefined) {
	throw new Error(`failed to read entry type of entry index ${i} of bundle`);
}
```

`skip(n): boolean` and `empty(): boolean` keep their `boolean` returns — they have no out-parameter.
The failure semantics are preserved exactly: a short read consumes nothing and leaves the cursor
where it was, which `cryptobyte_test.ts` asserts directly.

Crucially, this does **not** propagate into `ct_only.ts`. `copyBytes`, `copyUint16LengthPrefixed` and
`copyUint24LengthPrefixed` still return `boolean`, because that is what the calling loop in
`ctMerkleLeafHasher` is structured around; only their three-line bodies change shape.

**Two additions with no upstream counterpart**, both standing in for Go syntax rather than adding
behaviour:

- `String.length` (a getter) for Go's `len(s)`. `ct_only.go` needs it for
  `"unexpected %d bytes of trailing data in entry bundle"`.
- `String.bytes()` for Go's implicit `String` → `[]byte` conversion, used where `ct_only.go` passes
  a `cryptobyte.String` to `identityHash` or `AddBytes`. Like the Go conversion it aliases rather
  than copies.

**`String` keeps its name.** Consumers import the module as a namespace —
`import * as cryptobyte from "./internal/gostd/cryptobyte"` — and write `new cryptobyte.String(...)`
and `new cryptobyte.Builder()`, which is character-for-character what `ct_only.go` writes. The
global `String` is shadowed only inside `cryptobyte.ts` itself, which never needs it.

## Consequences

- `bytes` and `bytesOrPanic` are duplicates. That is deliberate and commented; a reviewer who
  collapses them will break the correspondence with `ct.go`.
- A caller who ignores a `String` read's result gets no warning, where Go's `if !ok` idiom is at
  least visible. TypeScript's `T | undefined` under `strictNullChecks` catches the far more likely
  mistake — using the value without checking — which the bool-plus-out-parameter form cannot.
- Anyone porting more `cryptobyte` callers later must follow this shape rather than reintroducing
  out-parameter boxes.

## Alternatives considered

- **Out-parameter boxes: `readUint16(out: { value: number }): boolean`.** Maximally faithful, and
  preserves `if (!s.readUint16(out))` verbatim. Rejected: every read site needs a pre-declared box,
  the box is mutable and reusable in ways that invite aliasing bugs, and the result reads as a bad
  transliteration in a codebase headed for donation. PORTING.md §3.2 makes the same call for
  PascalCase function names.
- **Tuple returns `[value, ok]`.** Rejected: destructuring at every call site is noisier than the
  `undefined` check, and it leaves two ways to be wrong (ignoring `ok`, or reading `value` when `ok`
  is false) where `undefined` leaves one that the compiler catches.
- **Throwing on short reads instead of returning `undefined`.** Rejected outright: `cryptobyte`'s
  reads are *expected* to fail on untrusted input. `ctBundleIDHasher` turns each failure into a
  distinct, position-bearing message, and exceptions would flatten those into one catch site.
- **Renaming `String` to `CryptobyteString` to avoid shadowing the global.** Rejected: the namespace
  import removes the hazard entirely and makes the TypeScript read like the Go it came from.

## Review

- **Reviewer:** gostd Reviewer
- **Verdict:** approved
- **Notes:** Checked the three signalling conventions against `builder.go`/`string.go`.
  `bytes`/`bytesOrPanic` are intentional duplicates that both throw a set `err` — correct given TS
  has one failure channel — and keep the call-site correspondence with `ct.go`. `BuildError extends
  Error`, carries the inner error as both `err` and `cause`; `callContinuation` sets `inContinuation`
  true only at the outermost level, wraps in `try`/`catch`, assigns `this.err = r.err` on a
  `BuildError` and rethrows anything else, clearing the shared flag in `finally` before the rethrow —
  a faithful rendering of Go's `defer`/`recover`/type-assert, verified against `TestContinuationError`,
  `TestContinuationNonError` and `TestGeneratedPanic`. The programming-error messages match Go
  verbatim. `String` reads return `T | undefined` (undefined == Go's false) and leave the cursor
  untouched on a short read — confirmed `read()` returns undefined and does not advance when
  `len < n || n < 0`. `readUint32` uses `v[0]*0x1000000 + (...)` and `beUint` uses bigint, so no
  value with the high bit set comes out negative. The `length` getter and `bytes()` aliasing addition
  are the documented Go-syntax stand-ins. The `String`-shadows-global concern is handled by the
  namespace-import convention. No out-parameter shape leaked into the port.
