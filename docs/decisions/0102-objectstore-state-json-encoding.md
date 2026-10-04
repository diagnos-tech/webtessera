# ADR-0102: Encode the driver's state files byte-for-byte as Go's encoding/json does, and decode them strictly

- **Status:** accepted
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Differential run against real Go 1.24.7 `encoding/json`: 1,156 raw inputs through `unmarshalTreeState` and
    `unmarshalGCState` against `json.Unmarshal` into the same structs (numbers in every form, `root` as strings, arrays
    and every other type, extra and nested fields, key case and order, duplicates, BOM, invalid UTF-8, control
    characters, truncations, 500 and 20,000 deep nesting), and 781 (size, root) pairs, 11 sizes up to MaxUint64 by root lengths 0 to 70, through the marshal side.
    Marshal output is byte-identical (1,562 lines). The codec never accepts an input Go rejects. Type-error texts, base64
    errors and `unexpected end of JSON input` equal Go's, and the ADR's disclaimed text differences (numeric-literal,
    literal, control-character, BOM, whole-document `treeState`, depth) are exactly the ones I saw. The table's five rows
    plus the `null` size row reproduce.
  - **The ADR says it lists every way the decoder differs from Go; two are missing, and one sentence is wrong.** The
    decision text and the Update must be corrected, or the code changed:
    1. "unknown keys are skipped, whatever their value ... as it would in Go" is false for an extra field holding a nested
       object with a repeated key: `{"size":1,"root":"AAAA","x":{"a":1,"a":2}}` (and the same inside an array) is rejected
       with `json: duplicate field "a"` (`object()` checks duplicates at every depth), where Go loads it with size 1.
    2. A key differing only in case when the exact key is also present: `{"size":1,"root":"AAAA","Size":3}` (or
       `"Size":3`) loads with size 1 here and size 3 in Go (last match wins). The table's "ignored, so the field is missing"
       covers only the case where the exact key is absent; here nothing is rejected and the value silently differs.
    3. The Update says the codec reports the first of Go's errors "and only then applies its own refusals". The
       duplicate-key refusal fires during parsing, so `{"size":5,"size":6,"root":"cm9vdCk"}` reports `duplicate field "size"`
       where Go reports `illegal base64 data at input byte 4`. Both reject; only the text differs, but the sentence is
       wrong as written.
    4. Nit: "under 400 lines" is stale, `json.ts` is 442.
  - Neither input in 1 or 2 can come from a file either driver writes, so the code is safe, but AGENTS.md section 6 asks
    for every divergence, however small, to be recorded.

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

**Review of this update:** ADR review agent (independent), 2026-10-04. Changes requested, as in the Review above. Checked
against real Go 1.24.7 (see the Review notes): arrays decoded as Go does (`[1,2,255]`, `null` elements, `256` giving
`... of type uint8`, other element types); type errors reported in document order (`{"root":5,"size":-1}` reports `root`);
the explicit `null` size or `fromSize` row; and every listed syntax-error wording difference, including the 10,000-deep
nesting case (Go reports `exceeded max depth`, the codec overflows its stack, both reject). Marshal is byte-identical across
781 inputs. Not covered by the update, so still missing from the ADR: nested duplicate keys and the exact-plus-case-variant
key (items 1 and 2 of the Review), and the "only then applies its own refusals" sentence (item 3).

## Update (2026-10-04): which member sets which field, and the order of refusals

This answers the four points of the Review above.

1. **Repeated keys inside a skipped member are skipped, as in Go.** The reader checked for duplicates at every
   depth, so `{"size":1,"root":"AAAA","x":{"a":1,"a":2}}` was rejected. The same held inside an array, or for a
   skipped key repeated at the top (`"x":1,"x":2`). Go loads all three. The reader now returns every member in
   document order and checks nothing about keys. The Decision's "unknown keys are skipped, whatever their value, as
   it would in Go" is now true.
2. **Members set fields by Go's rule.** For each key, `encoding/json` takes the field whose name equals the key.
   Failing that, it takes the field whose name equals it under `foldName`, and failing that, none. Each member is
   decoded in document order, so the last member that sets a field wins. Probes under Go 1.24.7 and 1.25.5 confirm
   this:
   - `{"size":1,"root":"AAAA","Size":3}` gives size 3, and `{"Size":3,"size":1,…}` gives size 1.
   - `{"SIZE":5,"ROOT":"AAAA"}` loads.
   - `ſize` (U+017F) folds with `size`, but `sıze` (the dotless i) does not.
   - U+017F and U+212A are the only non-ASCII runes whose fold class holds an ASCII letter. An enumeration of every
     rune under Go's `foldRune` confirms it.

   The codec now picks fields the same way (`fieldOf`, `foldName` in `json.ts`). So the table's third row ("a key
   differing only in case is ignored, so the field is missing") no longer applies: such a key sets the field, as
   in Go. When two members set the same field, the fourth row applies: the codec refuses
   (`json: duplicate field "Size"`) where Go keeps the last. Before, it silently took the exact key, so the value
   it read could differ from Go's. Now it refuses, consistently with an exact key repeated. Taking the last member
   instead would mean dropping the fourth row, which is an original decision of this ADR. That is left to the
   maintainers.
3. **The port's refusals now come after Go's errors, so the Update's sentence holds.** `fieldValues` checks
   every member's value against its field in document order, including repeated members. Only then does it refuse a
   field set twice, and after that a null or missing field. So `{"size":5,"size":6,"root":"cm9vdCk"}` now reports
   Go's `illegal base64 data at input byte 4`. `{"size":5,"Size":-1,…}` reports Go's type error for `-1`.
4. `json.ts` is 476 lines, no longer "under 400".

Tests in `json_test.ts`, each against the Go output above:
- accepted: repeated keys in a skipped object or array, a skipped key repeated, keys differing in case, and `ſize`;
- rejected only by the port: the dotless `ı` (Go leaves size 0), and the two orders of an exact key with a case
  variant;
- Go's error first: the two inputs in point 3;
- `gcState`: `FROMSIZE`, `fromſize`, a skipped object with a repeated key, and `fromsize` with `fromSize`.

A differential of 4,000 generated inputs ran through Go 1.25.5, whose output was identical to Go 1.24.7's. The
inputs mix the keys `size`, `Size`, `SIZE`, `ſize`, `sıze`, `root`, `Root`, `ROOT`, `x`, `X` and `fromSize` with
values of every kind. Results:
- 1,990 loaded with the same size and root.
- 13 were rejected with Go's own text.
- 1,997 were refused only by the port, each in one of its documented rows: missing field, null field, or field
  set twice.
- None loaded where Go failed, and none loaded with a different value.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. See the Re-review below.*

## Re-review (2026-10-04)

- **Re-review:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - The first 2026-10-04 update (the fidelity audit) was already reviewed. The second ("which member sets which field") answers the earlier Review's four points and had no review line; it is signed here.
  - Point 1, repeated keys in skipped members: the reader now returns every member and checks nothing about keys. I probed `{"size":1,"root":"AAAA","x":{"a":1,"a":2}}`, the same inside an array, and a skipped key repeated at the top: all load, as in Go. Point 2, the key rule: `fieldOf` and `foldName` implement `encoding/json`'s rule (exact name, else the case-folded name, else none; last member wins). `ſ` (U+017F) folds with `s`, the dotless `ı` does not; I enumerated every rune under Go's `unicode.SimpleFold` and U+017F and U+212A are the only non-ASCII runes whose fold orbit holds an ASCII letter. Point 3, order of refusals: `fieldValues` checks every member's value in document order, repeated members included, before refusing a field set twice, then a null or missing field; so `{"size":5,"size":6,"root":"cm9vdCk"}` reports `illegal base64 data at input byte 4` and `{"size":5,"Size":-1,...}` reports the type error, as Go does. Point 4: `json.ts` is 476 lines.
  - Differential against real Go, with fresh corpora of my own (two of 6,000 `treeState` inputs: case variants, `ſ` and `ı`, escapes in keys, whitespace, nulls, arrays, nested objects with repeated keys). Go 1.24.7 and 1.25.5 print identical output on the second corpus. An oracle that asks `encoding/json` itself which field each member sets shows: no input that Go rejects is accepted; no accepted input has a different size or root; every input that Go accepts and the port rejects has two members setting one field, a null size, or a missing size or root (1,222 and 1,771 inputs); every other rejection carries Go's own text, except the documented numeric-literal wording (`01`). The 4,000-input corpus the Update cites (`fixprobe/json`) reproduces as well. `json_test.ts`: 58 pass.
  - The refusal when two keys set the same field (Go keeps the last): the ADR records it as a divergence, with its reason, in three places. (a) The Decision's table row "a key repeated | last one wins | error", which the Update extends explicitly to case variants: "When two members set the same field, the fourth row applies: the codec refuses (`json: duplicate field "Size"`) where Go keeps the last". (b) The reason: the Decision says each stricter case "means the file was written by neither driver" (Go writes one `size`), and the Alternatives reject "Decode exactly as leniently as Go" because "leniency there can only ever turn corruption into a silently wrong tree size"; for the case-variant the Update adds that the earlier silent pick of the exact key could differ from Go's value, and refusing is consistent with a repeated exact key. (c) `json.ts`'s doc comment and the test comment both say that Go keeps the last. I judge this clear, and the reasoning sound for the one field that decides whether a log restarts at size 0. The Update's sentence "Taking the last member instead would mean dropping the fourth row ... That is left to the maintainers" reads as still open; the re-review brief says the lead decided to keep the refusal, and this Review records that.
  - Housekeeping, not blocking: the Decision's table row 3 ("a key differing only in case ... ignored") is superseded by the Update, which says so, and the "five cases" are now the original rows plus the null size and the extension of the repeated-key row. The current list of divergences (a top-level `null`, a missing field, a null size, a field set twice under any case, invalid UTF-8; plus syntax-error wording and the 10,000-deep nesting) has to be assembled from three blocks; one consolidated list in a later update would help.
