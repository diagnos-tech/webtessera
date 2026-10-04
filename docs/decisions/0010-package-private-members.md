# ADR-0010: Render Go package-private struct fields and functions as `_`-prefixed `@internal` members

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** merkle contributor
- **Upstream reference:** `merkle/compact/range.go`, `merkle/compact/range_internal_test.go`, `merkle/proof/proof.go`, `merkle/proof/proof_test.go`, `merkle/testonly/tree.go`, `merkle/testonly/tree_test.go`

## Context

Three of the types in this work package pair an unexported field with an exported method of the
same name. Go allows it because case *is* the visibility mechanism:

```go
type Range struct {
	f      *RangeFactory
	begin  uint64
	end    uint64
	hashes [][]byte
}

func (r *Range) Begin() uint64    { return r.begin }
func (r *Range) End() uint64      { return r.end }
func (r *Range) Hashes() [][]byte { return r.hashes }
```

`proof.Nodes` does the same (`ephem` field, `Ephem()` method) and `testonly.Tree` does the same
(`size` field, `Size()` method). ADR-0002 maps exported methods to camelCase, which collapses
`Begin()` onto `begin` — a hard collision in TypeScript, where a class cannot have a property and a
method with the same name.

The second half of the problem is that upstream's *in-package* tests read and write those fields.
This is not incidental; it is where several of the assertions live:

```go
// range_internal_test.go
corrupt := func(rng *Range, dBegin, dEnd int64) *Range {
	rng.begin = uint64(int64(rng.begin) + dBegin)
	rng.end = uint64(int64(rng.end) + dEnd)
	return rng
}
lhs: &Range{f: factory, begin: 17, end: 23, hashes: [][]byte{...}}

// proof_test.go
proof.ephem = compact.NodeID{}   // Ignore the ephemeral node, it is tested separately.

// tree_test.go
want := refRootHash(entries[:size], mt.hasher)
cmp.Diff(mt1, mt2, cmp.AllowUnexported(Tree{}))
```

TypeScript's `private` is checked at compile time and would reject every one of those lines from a
sibling `*_test.ts` file. ECMAScript `#private` would reject them at runtime too, and would
additionally break `cmp.AllowUnexported`'s TypeScript equivalent: `expect(mt1).toEqual(mt2)` compares
own enumerable properties, so a `Tree` whose entire state is `#private` compares equal to *any*
other `Tree`, turning `TestTreeAppend` into a test that cannot fail.

TypeScript has no package-private visibility, and no file-pair visibility either. The unit of
encapsulation available to us is the **module**.

## Decision

A Go struct field or function that is unexported, and that upstream's own tests touch, becomes a
**public TypeScript member prefixed with `_` and marked `/** @internal */`**:

| Go | TypeScript |
| --- | --- |
| `Range.f`, `.begin`, `.end`, `.hashes` | `Range._f`, `._begin`, `._end`, `._hashes` |
| `Nodes.begin`, `.end`, `.ephem` | `Nodes._begin`, `._end`, `._ephem` |
| `Tree.hasher`, `.size`, `.hashes` | `Tree._hasher`, `._size`, `._hashes` |
| `&Range{...}` composite literal | `new Range(f, begin, end, hashes)`, marked `@internal` |
| `getMergePath` | exported from `range.ts`, marked `@internal` |
| `Nodes.skipFirst` | public method, marked `@internal` |

The `_` prefix exists only to break the collision with the exported accessor; it is not a general
renaming rule and does not apply to fields that have no same-named method.

**The visibility boundary is the package barrel.** `compact/index.ts` and `proof/index.ts` re-export
exactly what Go exports. `package.json`'s `exports` map points at those barrels, so a consumer of
`webtessera/merkle/compact` sees the Go-exported surface and nothing else. Reaching `_begin`
requires importing the module path directly, which is what the ported `*_test.ts` files do and what
a reviewer can grep for in one command:

```
grep -rn 'from "\.\./compact/range"' src --include='*.ts' | grep -v _test.ts
```

Unexported helpers that upstream's tests do *not* touch stay genuinely private: `Range.#appendImpl`,
`Tree.#appendImpl`/`#getNodes`, and `proof/verify.ts`'s `verifyMatch`, `decompInclProof`,
`innerProofSize`, `chainInner`, `chainInnerRight`, `chainBorderRight` are module-local or `#private`.

### Test helpers shared between test files

The same missing package scope bites once more, in the other direction. `reference_test.go` defines
`refRootHash`, `refInclusionProof`, `refConsistencyProof` and `downToPowerOfTwo` and *also* tests
them; `tree_test.go`, in the same package, uses them as its oracle. TypeScript can express the
sharing — `tree_test.ts` can import from `reference_test.ts` — but Vitest registers a suite when the
module is evaluated, so importing one test file from another runs its 12 tests twice and reports
every failure twice.

So the file is split: `testonly/reference.ts` holds the four reference implementations, and
`testonly/reference_test.ts` holds the three test functions that cover them. Both carry a header
saying which half of `reference_test.go` they are. This is the only file in the work package that
does not map 1:1 onto an upstream file.

`compact/range_test.ts` and `compact/range_internal_test.ts` need no such treatment: they mirror
Go's `compact_test` and `compact` packages respectively and share nothing.

> **Update (2026-10-02):**
>
> - The table above omits one row: Go's `Nodes{...}` composite literal (package-private, because `Nodes` has
>   unexported fields) is `new Nodes(ids, begin, end, ephem)`, marked `@internal`, just like `&Range{...}`.
> - The grep recipe above never matches, because the port's relative imports carry an explicit `.ts`
>   extension (PORTING.md §3.8). The working form is:
>
>   ```
>   grep -rnE 'from "(\.\./)+(compact|proof)/[a-z0-9_]+\.ts"' src --include='*.ts' | grep -v _test.ts
>   ```
>
> - The barrels now export `Range` and `Nodes` as **types** only. No code outside their modules constructs
>   either (only `RangeFactory` and `inclusion`/`consistency` do, as in Go, where the literals are
>   package-private), so exporting the classes as values exposed their unvalidated constructors for no user.
>   Tests import the modules directly, as before. `NodeID`'s fields are exported in Go, so its class stays a
>   value export. See ADR-0208.

*Review of this update: the three corrections are accurate (the missing `Nodes` row, the type-only barrel exports, the
`.ts` extension in the recipe); the replacement recipe is not sufficient, see item 2 of the Review below. ADR reviewer
(independent), 2026-10-04.*

## Consequences

- **The encapsulation is weaker than Go's.** Nothing stops application code from writing
  `range._end = 0n` and corrupting a compact range. In Go that is a compile error. This is a real
  loss and the reason the `@internal` tag and the barrel exist: the tag is what an API-extractor or
  a reviewer keys on, and the barrel is what the published entry points expose.
- **Reviewability is preserved, which is the point.** Every upstream in-package test survives with
  its assertions intact — including `TestEqual`'s six hand-built `Range` values, `corrupt()`, and
  `TestTreeAppend`'s whole-struct comparison. Weakening any of those to satisfy TypeScript's
  visibility model would have been a silent reduction in coverage, which PORTING.md §4 forbids.
- **The `_` prefix is visible in the donated code.** A transparency-dev reviewer will see
  `this._begin` where Go has `r.begin` and needs this ADR to know why. It is the smallest diff that
  makes the accessor methods portable at all.
- **`testonly/` has one more file than upstream.** `ls src/vendor/merkle/testonly` no longer diffs
  clean against `ls merkle/testonly`, which ADR-0002 lists as the port's main reviewability asset.
  The alternative was a test file that reports 12 phantom passes and duplicates every failure, which
  is a worse thing to hand a reviewer.
- If TypeScript ever gains package-level visibility, this becomes a mechanical rename.

## Alternatives considered

- **ECMAScript `#private` fields throughout.** True encapsulation, matching Go's intent most
  closely. Rejected: it makes `range_internal_test.ts` unwritable, and it silently guts
  `TestTreeAppend` and `TestTreeAppendAssociativity`, because `toEqual` cannot see `#` fields and
  would report two arbitrary trees as equal. A test that cannot fail is worse than weak
  encapsulation.
- **TypeScript `private` fields.** Visible to `toEqual`, so the Tree tests would still work, but
  still a compile error from a sibling test file, so `range_internal_test.ts` and `proof_test.ts`
  remain unwritable without `as any` or `@ts-expect-error` — both banned.
- **Keep the fields private and export a test-only construction/mutation API** (e.g.
  `newRangeInternal`, `setBounds`). Rejected: it is *more* invented surface than the `_` prefix, not
  less, and it is API that upstream does not have (which itself needs an ADR under PORTING.md §6).
- **Rename the accessors instead** (`getBegin()`, `getEnd()`). Rejected: it breaks ADR-0002's
  mechanical mapping at the *exported* surface, which is the surface that matters most for donation.
  Better to bend an unexported name than an exported one.
- **Drop the accessors and expose the fields directly** (`range.begin` as a property). Rejected: it
  changes the exported API shape — `r.Begin()` is a call in Go — and would diverge from every other
  ported method.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - What I checked and found right. Against `merkle@v0.0.2`: `Range{f, begin, end, hashes}` with `Begin()`,
    `End()`, `Hashes()`; `proof.Nodes{IDs, begin, end, ephem}` with `Ephem()` and `skipFirst()`; `testonly.Tree{hasher,
    size, hashes}` with `Size()`. The in-package tests do touch what the ADR says: `range_internal_test.go`
    writes `rng.begin`/`rng.end` and builds `&Range{f, begin, end, hashes}` in `TestEqual` (six cases, six in
    `range_internal_test.ts`), calls `getMergePath`; `proof_test.go` sets `proof.ephem` and compares with
    `cmp.AllowUnexported(Nodes{})`; `tree_test.go` reads `mt.hasher` and compares trees with
    `cmp.AllowUnexported(Tree{})`. The TypeScript has the table's members (`Range._f/_begin/_end/_hashes`,
    `Nodes._begin/_end/_ephem`, `Tree._hasher/_size/_hashes`), each `@internal`; `getMergePath` and `skipFirst` are
    exported/public and marked `@internal`; `Range.#appendImpl`, `Tree.#appendImpl`/`#getNodes` are `#private`; the
    six `verify.ts` helpers are module-local. The ported tests use the `_` members (`proof._ephem = ...`,
    `rng._begin = ...`, `mt._hasher`). No file outside `src/vendor/merkle` and the tests mentions `_begin`, `_end`,
    `_ephem`, `_hashes`, `_f`, `_hasher`, `_size`, `getMergePath` or `skipFirst`.
  - The two arguments that carry the decision are true, and I ran both. (1) `#private` makes `toEqual` blind: a probe
    with two instances that differ only in a `#field` passes `expect(a).toEqual(b)`, so `TestTreeAppend` and
    `TestTreeAppendAssociativity` (which use `toEqual` on whole trees, lines 161 and 176 of `tree_test.ts`) could not
    fail. (2) Importing one `*_test.ts` from another registers its suites twice: a probe shows `A > a1` reported
    under both files. The `reference.ts` / `reference_test.ts` split (three `describe`s, the 12 cases of
    PORTING-MAP) is therefore justified. `bunx vitest run src/vendor/merkle` passes (12 files, 770 tests).
  - The 2026-10-02 Update's other claims hold: `Nodes` is built with `new Nodes(ids, begin, end, ephem)` at
    `proof.ts:120, 155, 232`; the barrels export `Range` and `Nodes` as types only and `NodeID` as a value;
    nothing outside the two modules constructs a `Range` or a `Nodes` (the `new Range(` in `fsck/status.ts` is
    fsck's own class); ADR-0208 exists.
  - Changes requested. (1) **The Decision contradicts itself, and PORTING.md, on the scope of the `_` prefix.**
    The first sentence says an unexported "struct field *or function*" that upstream's tests touch "becomes a public
    member prefixed with `_`". The table directly under it prefixes no function (`getMergePath` and `skipFirst`
    keep their names). Later the ADR says the prefix "exists only to break the collision with the exported
    accessor; it is not a general renaming rule and does not apply to fields that have no same-named method".
    The table prefixes five such fields (`Range._f`, `Nodes._begin`, `Nodes._end`, `Tree._hasher`, `Tree._hashes`:
    Go has no `F()`, `Begin()`/`End()` on `Nodes`, `Hasher()` or `Hashes()` on `Tree`), and so does the code.
    PORTING.md section 3.8, which cites this ADR, states the broad rule: "A Go identifier that is unexported but used
    across files or by the ported tests becomes a `_`-prefixed member marked `@internal` (ADR-0010)". A contributor
    who reads the ADR is told the opposite of what the code and PORTING.md do. Add an Update (do not rewrite the
    history) that states the rule actually applied: unexported struct *fields* that the in-package tests read or
    write become `_`-prefixed public members marked `@internal`, whether or not an accessor of the same name
    exists (the collision is one reason, `toEqual` visibility is the other); unexported *functions and methods*
    keep their camelCase name and are exported or made public with `@internal`. (2) **The grep recipe in the
    Update still cannot do what the Decision promises** ("a reviewer can grep for in one command" who reaches
    `_begin`). `(\.\./)+(compact|proof)/...` only matches sibling-directory imports, and its four hits are all inside
    `src/vendor/merkle`; an import such as `../vendor/merkle/compact/range.ts` from `client/`, `fsck/` or `safe/` does
    not match, and several exist (`client/client.ts` imports `proof/proof.ts` and `proof/verify.ts` directly; they
    only take exported names, but the recipe cannot tell). Replace it with one that finds the thing itself, for
    example `grep -rnE '\._(begin|end|ephem|hashes|f|hasher|size)\b|getMergePath|skipFirst' src --include='*.ts' |
    grep -v -e _test.ts -e '^src/vendor/merkle'`, which I ran and which prints nothing today.
  - Status stays `proposed` until those two corrections are recorded; nothing in the code needs to change.

## Update (2026-10-04): the rule as applied, and a recipe that finds the members

This answers the two points of the Review above. The decision is unchanged.

1. **The rule actually applied.** The Decision's opening sentence and its later remark on scope disagree with
   each other and with the table. The table, PORTING.md §3.8 and the code all follow this rule:
   - An unexported struct field that upstream's in-package tests read or write becomes a public member prefixed
     with `_` and marked `@internal`, whether or not it has a same-named exported accessor. So it applies to
     `Range._f`, `Nodes._begin`/`_end` and `Tree._hasher`/`_hashes`, which have no accessor, as much as to
     `Range._begin`/`_end`/`_hashes`, `Nodes._ephem` and `Tree._size`, which do.
   - An unexported function or method that the in-package tests use keeps its Go name and is exported (or left
     public) and marked `@internal`. That covers `getMergePath` and `skipFirst`, which upstream's tests use. It
     also covers `minImpliedTreeSize`, which a port-added test uses since 2026-10-04 (ADR-0014).
   - A stand-in for a package-private composite literal is marked `@internal` in the same way: `new Range(...)`,
     and `nodesLiteral` for the in-package `Nodes{IDs, begin, end, ephem}`.
   - Since ADR-0208's 2026-10-04 update, `Nodes`'s constructor is Go's exported literal `Nodes{IDs: ids}`. So the
     2026-10-02 update's row `new Nodes(ids, begin, end, ephem)` now reads `nodesLiteral(ids, begin, end, ephem)`.
   - Unexported members that the tests do not touch stay module-local or `#private`.

   The sentence "it is not a general renaming rule and does not apply to fields that have no same-named method"
   should be read as superseded by this rule.
2. **A recipe that finds the members themselves.** The 2026-10-02 recipe matched only imports from sibling
   directories, so it could not catch a reach-in from `client/`, `fsck/` or `safe/`. This one greps for the members
   wherever they are used outside the merkle port and its tests:

   ```
   grep -rnE '\._(begin|end|ephem|hashes|f|hasher|size)\b|getMergePath|skipFirst' src --include='*.ts' | grep -v -e _test.ts -e '^src/vendor/merkle'
   ```

   It prints nothing today.
