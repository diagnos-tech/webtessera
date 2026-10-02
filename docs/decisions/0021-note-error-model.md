# ADR-0021: `sumdb/note`'s error values — `keyName` instead of `name`, and `@internal` sentinels

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** note agent
- **Upstream reference:** `golang.org/x/mod/sumdb/note/note.go`

## Context

`sumdb/note` has five error values that callers are expected to distinguish between, because each
one means something different about whether a checkpoint may be trusted:

```go
type UnknownVerifierError struct { Name string; KeyHash uint32 }
type InvalidSignatureError struct { Name string; Hash uint32 }
type UnverifiedNoteError   struct { Note *Note }
type ambiguousVerifierError struct { name string; hash uint32 }

var (
	errMalformedNote      = errors.New("malformed note")
	errInvalidSigner      = errors.New("invalid signer")
	errMismatchedVerifier = errors.New("verifier name or hash doesn't match signature")
	errVerifierID, errVerifierAlg, errVerifierHash    = ...
	errSignerID,   errSignerAlg,   errSignerHash      = ...
)
```

Two problems in TypeScript.

**The field name `Name` collides with `Error.prototype.name`.** ADR-0002 maps an exported Go struct
field to the camelCase of the same name, which gives `err.name = "PeterNeumann"`. In JavaScript
`Error.prototype.name` is the *class* of the error: it is what `err.toString()` and every logger
prints before the message. An `UnknownVerifierError` whose `name` is `"PeterNeumann"` renders as
`PeterNeumann: unknown key PeterNeumann+c74f20a3`, which reads like a completely different error.

**The sentinels are unexported, and the ported tests are a separate module.** `note_test.go` asserts
`err != errMismatchedVerifier` by identity. In Go that works because the test is in the same package.
In TypeScript a `*_test.ts` file is a different module, so it can only see exports. ADR-0010 already
faced this for `merkle` and settled on: export it, mark it `/** @internal */`.

`errVerifierID` and `errSignerID` share the message text `"malformed verifier id"`, and
`errVerifierAlg`/`errSignerAlg` and `errVerifierHash`/`errSignerHash` likewise — upstream copy-paste
that is nonetheless observable, because upstream's tests assert on the text.

## Decision

**Error classes.** Go's four error structs become `Error` subclasses. The field Go calls `Name`
becomes **`keyName`**; every other field keeps ADR-0002's mapping:

| Go | TypeScript |
| --- | --- |
| `UnknownVerifierError{Name, KeyHash}` | `UnknownVerifierError{keyName, keyHash}` |
| `InvalidSignatureError{Name, Hash}` | `InvalidSignatureError{keyName, hash}` |
| `UnverifiedNoteError{Note}` | `UnverifiedNoteError{note}` |
| `ambiguousVerifierError{name, hash}` | `ambiguousVerifierError{keyName, hash}` |

Each constructor sets `this.name` to its own class name, so the JavaScript meaning of `name` is
preserved. Message text is byte-identical to Go's, including the `%08x` key hash rendering.

`UnverifiedNoteError` carries the parsed note, exactly as upstream does. This is load-bearing, not a
convenience: a client that receives a checkpoint signed only by keys it does not know still needs to
see *who* signed it, and upstream's `open` documents the note as fetchable from inside the error.

**Sentinels.** All nine become exported `SentinelError` singletons keeping their Go names, each
marked `/** @internal */` per ADR-0010. Message text is copied verbatim, duplication included:
`errSignerID` says `"malformed verifier id"` because that is what Go says.

`ambiguousVerifierError` is likewise exported and `@internal`, since `open` can propagate it to a
caller who may reasonably want to recognise it.

Unlike `merkle`, there is no barrel to hide these behind: `package.json` maps
`"./note"` straight at `note.ts`, because upstream's package is a single file and ADR-0002 requires
the filename to match. A reviewer checking that nothing outside the tests depends on them can run:

```
grep -rn "err\(MalformedNote\|InvalidSigner\|MismatchedVerifier\|Verifier\|Signer\)" src --include='*.ts' | grep -v _test.ts
```

**Throwing.** Per ADR-0004, every Go `error` return becomes a throw with the same message. The one
place this needs care is `Verifiers.verifier`, which upstream specifies in terms of *returning* an
`UnknownVerifierError` for an unknown key — a routine, expected outcome, not a failure. `open`
therefore wraps the call in `try`/`catch` and tests the caught value with `instanceof`, mirroring
Go's `if _, ok := err.(*UnknownVerifierError); ok`. A type assertion, not `errors.As`: upstream
checks the error *itself*, so a wrapped one must not match, and `instanceof` on the caught value has
that same shape.

## Consequences

- `err.keyName` diverges from ADR-0002's mechanical mapping. It is the only such rename in this work
  package, it is documented at each declaration, and the alternative was worse.
- Anyone donating this upstream will see a field name that is not in the Go source. The reason is a
  JavaScript language constraint and is written at the declaration, so it should survive review.
- Nine sentinels appear on the public surface of `webtessera/note` that are not on Go's. They
  are marked `@internal`; a documentation generator will hide them, a TypeScript compiler will not.
- Catching `UnknownVerifierError` by `instanceof` means a custom `Verifiers` implementation that
  wraps the error — say, with `wrapError` — will *not* be treated as "unknown key" and will abort
  `open` instead. That is Go's behaviour too, and it is the safe direction: an unrecognised failure
  from a verifier lookup should stop verification, not be silently downgraded to "unverified".

## Alternatives considered

- **Keep `name` and accept the shadowing.** Rejected: it corrupts every log line and stack trace
  that touches the error, and `errorAs(e, UnknownVerifierError)?.name` would read as the class name
  to every JavaScript reader while meaning the server name.
- **Expose the server name only through a getter called `signerName`.** Rejected: `keyName` is one
  token from Go's `Name` and sits next to `keyHash`, which upstream itself names that way.
- **Keep the sentinels module-private and assert on message text in the tests.** Rejected: ADR-0004
  exists specifically to stop `e.message.includes(...)` identity checks, and upstream's test asserts
  identity, not text.
- **Return a discriminated union from `open` instead of throwing.** Rejected: it diverges from
  ADR-0004 for one package, and it would make `open` the only function in the port whose failure a
  caller can ignore by forgetting to check — on the function that decides whether a signature is
  valid.

## Review

- **Reviewer:** note reviewer (independent)
- **Verdict:** approved
- **Notes:**
  - Checked every error value against `note.go`. All five structured errors and nine sentinels are
    present with byte-identical message text, including the deliberate upstream duplication
    (`errSignerID` = `"malformed verifier id"`, etc.) and the `%08x` key-hash rendering via `hex8`.
    The `keyName` rename is justified: Go's `Name` field would shadow `Error.prototype.name` and
    corrupt every logged rendering. It is the only deviation from ADR-0002's mechanical mapping and
    is documented at each declaration.
  - The `open` control flow for `UnknownVerifierError` uses `instanceof` on the caught value, which
    mirrors Go's `if _, ok := err.(*UnknownVerifierError); ok` (the un-wrapped type assertion, not
    `errors.As`) — a wrapped unknown-verifier error correctly aborts `open` instead of being
    downgraded to "unverified", the safe direction. `UnverifiedNoteError` carries the note as
    upstream requires; confirmed asserted by both `note_test.ts` and the golden-fixture test.
  - Sentinels exported `@internal` per ADR-0010 so the separate test module can assert identity
    (`toBe(errMismatchedVerifier)`); verified those identity assertions pass.
