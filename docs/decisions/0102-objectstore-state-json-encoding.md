# ADR-0102: Encode the driver's state files byte-for-byte as Go's encoding/json does, and decode them strictly

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go` (`treeState`, `writeTreeState`, `readTreeState`, `gcState`,
  `writeGCState`, `readGCState`)

## Context

The POSIX driver keeps two private JSON files under `.state/`:

```go
type treeState struct {
	Size uint64 `json:"size"`
	Root []byte `json:"root"`
}

type gcState struct {
	FromSize uint64 `json:"fromSize"`
}
```

`json.Marshal` writes them as `{"size":123,"root":"<standard base64>"}` and `{"fromSize":123}`: no whitespace,
fields in declaration order, a `uint64` as a bare JSON number, a `[]byte` as a padded standard-base64 string
(or `null` for a nil slice). `json.Unmarshal` reads them back.

JavaScript's built-ins cannot do either: `JSON.parse` turns every number into a float64, silently rounding any
tree size above 2^53, and `JSON.stringify` throws on a `bigint`. ADR-0003 makes `uint64` a `bigint` throughout,
and the upstream tests exercise sizes up to `math.MaxUint64`.

## Decision

`src/storage/objectstore/json.ts` provides `marshalTreeState`/`unmarshalTreeState` and
`marshalGCState`/`unmarshalGCState`.

**Encoding** writes exactly Go's bytes, built from the `bigint`'s decimal rendering and `toBase64`. The test
vectors in `json_test.ts` (including `MaxUint64`) were produced by running Go 1.24's `encoding/json` on the
same structs.

**Decoding** is a small recursive-descent JSON reader that keeps numbers as their source text, then reads the
fields the way `json.Unmarshal` does where that matters:

- the input must be one JSON object, with nothing after it;
- `size`/`fromSize` must be an integer literal in `[0, 2^64)`; a sign, fraction, exponent, string or overflow
  is rejected with Go's own `json: cannot unmarshal number -1 into Go struct field treeState.size of type
  uint64` message;
- `root` must be a standard-base64 string (decoded by `fromBase64`, which mirrors `base64.StdEncoding`,
  including its tolerance of `\r` and `\n`) or `null`;
- unknown keys are skipped, whatever their value, so a state file written by a newer driver with extra fields
  still loads, as it would in Go;
- the bytes must be valid UTF-8, and a byte-order mark is kept and therefore rejected as a syntax error.

It is deliberately **stricter** than `json.Unmarshal` in five cases, each of which means the file was written
by neither driver:

| input | Go | here |
| --- | --- | --- |
| `null` | leaves the struct zero, no error | error |
| a field missing | leaves it zero | error (`json: missing field treeState.size`) |
| a key differing only in case (`"SIZE"`) | matches the field | ignored, so the field is missing |
| a key repeated | last one wins | error |
| invalid UTF-8 inside a string | replaced with U+FFFD | error |

The driver wraps any decoding error as `files.go` does, `error in Unmarshal: <message>`.

## Consequences

- `.state/treeState` and `.state/gcState` are interchangeable between this driver and the Go POSIX driver in
  both directions, which is what lets a POSIX log directory be loaded into a store and resumed
  (`driver_fixtures_test.ts`), and a store be dumped to a directory the Go driver can resume.
- A corrupt or hand-edited state file stops the driver with an error instead of being read as a zero tree
  size. For `treeState` that matters: a zero size would make `initialise` treat an existing log as new and the
  next batch overwrite entry bundle 0.
- The codec is under 400 lines (most of it the JSON reader) that exist only for these two files. It is not a general `encoding/json`
  stand-in and is not exported from any barrel.

## Alternatives considered

- **`JSON.parse` with a reviver using the source-text access proposal** (`context.source`). Rejected: not
  available in every runtime this port targets.
- **A regular expression over the exact shape Go writes.** Rejected: it would reject valid JSON Go accepts
  (whitespace, reordered or extra fields), making the files less portable, not more.
- **Decode exactly as leniently as Go.** Rejected for the five cases above: leniency there can only ever turn
  corruption into a silently wrong tree size.
- **A different encoding (for example binary).** Rejected: it breaks interchange with POSIX logs for no gain;
  these files are tiny and rarely written.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending

## Update (2026-10-04)

The final fidelity audit ran 573 `treeState`, 18 `gcState` and 48 marshal inputs through Go and through this codec.
Marshal output was byte-identical. Decoding differed from Go in more ways than the table above lists:

- **A JSON array for `root`.** `encoding/json` decodes an array into a `[]byte` element by element (`[1,2,255]` is
  three bytes, a `null` element leaves its byte zero, an element that does not fit a `uint8` is
  `json: cannot unmarshal number 256 into Go struct field treeState.root of type uint8`, and likewise `string`, `bool`,
  `array` or `object`). The codec rejected every array. It now decodes arrays exactly as Go does, with Go's error
  texts; an array of bytes is as unambiguous as base64, so there is nothing to gain by refusing it.
- **The order of type errors.** Go keeps decoding after a type error and returns the earliest one in document order
  (`{"root":5,"size":-1}` reports `root`). The codec checked `size` before `root` whatever their order. It now checks
  the members in document order and reports the first of Go's errors, and only then applies its own refusals below.
- **An explicit `null` for `size` or `fromSize`.** Go leaves the field zero, as for a missing field. The codec rejects
  it, with `json: cannot unmarshal null into Go struct field treeState.size of type uint64`, for the reason it rejects a
  missing field: a zero tree size would make the driver treat an existing log as new. This is a sixth row of the table
  above, recorded now. Like the missing-field check, it runs after every check of Go's, so an input Go rejects gets
  Go's error.
- **Syntax-error texts.** Only the type-error texts (`json: cannot unmarshal ...`), the base64 errors, `unexpected end
  of JSON input` and the texts the tests pin are Go's. Other syntax errors are worded after `encoding/json`'s
  `SyntaxError` but are not its texts: `{"size":01}` gives `invalid character '1' in numeric literal` where Go says
  `invalid character '1' after object key:value pair`, and the exponent, literal (`tru`), control-character (`'\u0001'`
  for Go's `'\x01'`), byte-order-mark and non-ASCII messages differ similarly, as does a whole-document type error
  (`treeState` for Go's `posix.treeState`). Every one of them is a rejection where Go rejects too; reproducing the texts
  would mean porting `encoding/json`'s scanner for files that only a corrupt store can make malformed.
- A 10,000-deep nesting in an ignored field exhausts the recursive reader's stack (`Maximum call stack size
  exceeded`) where Go reports a type or depth error. Still an error.

`json_test.ts` pins the array decoding, the document order and the `null` precedence against Go's output.
