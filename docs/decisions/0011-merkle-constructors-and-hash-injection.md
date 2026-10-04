# ADR-0011: Go `New` constructors become class constructors; `crypto.Hash` becomes a noble `CHash`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** merkle agent
- **Upstream reference:** `merkle/rfc6962/rfc6962.go`, `merkle/testonly/tree.go`, `merkle/hasher.go`

## Context

Two packages in this work package expose a constructor called exactly `New`:

```go
// rfc6962
func New(h crypto.Hash) *Hasher { return &Hasher{Hash: h} }
var DefaultHasher = New(crypto.SHA256)

// testonly
func New(hasher merkle.LogHasher) *Tree { return &Tree{hasher: hasher} }
```

ADR-0002 maps an exported func to camelCase, which gives `new` — a reserved word in TypeScript. It
cannot be a function name.

Separately, `rfc6962.Hasher` embeds `crypto.Hash`, which is not a hash *implementation* but an
integer index into Go's registry of them. `t.New()` looks the implementation up at call time, and
the blank import `_ "crypto/sha256"` is what registers SHA-256 into that table. `Hasher.Size()` is
also inherited from the embedded `crypto.Hash`. None of this machinery exists in TypeScript, and
ADR-0005 already fixes `@noble/hashes` as the hash source.

## Decision

**`New` maps to the class constructor.** `rfc6962.New(crypto.SHA256)` becomes `new Hasher(sha256)`;
`testonly.New(hasher)` becomes `new Tree(hasher)`. No `newHasher`/`newTree` function is added — the
`new` keyword is the TypeScript spelling of the same idea, and inventing a second spelling would put
two constructors in a donated API where upstream has one.

**`crypto.Hash` maps to `@noble/hashes`' `CHash`**, the type of `sha256` itself:

```ts
import { sha256 } from "@noble/hashes/sha2.js";
import type { CHash } from "@noble/hashes/utils.js";

export class Hasher implements LogHasher {
	readonly hash: CHash;
	constructor(hash: CHash) { this.hash = hash; }
	emptyRoot(): Uint8Array { return this.hash.create().digest(); }
	size(): number { return this.hash.outputLen; }
	// ...
}
export const DefaultHasher = new Hasher(sha256);
```

`t.New()` becomes `this.hash.create()`, `Sum(nil)` becomes `.digest()`, and `Size()` — inherited
from the embedded `crypto.Hash` upstream — becomes an explicit method returning `outputLen`. The
`Hasher` is still parameterised over the hash function, exactly as upstream is, so a caller can
build an RFC 6962 hasher over any noble hash.

**`Hasher` declares `implements LogHasher`.** Go's `rfc6962` does not import the root `merkle`
package and has no compile-time assertion that `*Hasher` satisfies `LogHasher`; the port adds a
type-only import to get that check. It has no runtime effect and creates no import cycle
(`hasher.ts` imports nothing).

**Method values need explicit binding.** Go's `rfc6962.DefaultHasher.HashChildren` is a method value
that carries its receiver. The TypeScript equivalent of that expression is
`DefaultHasher.hashChildren.bind(DefaultHasher)`, and every place upstream passes a bare method value
into a `HashFn`/`VisitFn` parameter is written that way.

## Consequences

- A reader diffing `rfc6962.go` against `rfc6962.ts` sees `New` on one side and a constructor on the
  other. This ADR is the record; the file also carries a `// Port note:`.
- `DefaultHasher` is a module-level singleton, as upstream's package-level `var` is. It is immutable
  in practice (`hash` is `readonly`), but TypeScript cannot stop a caller reassigning the binding's
  properties any more than Go can stop `rfc6962.DefaultHasher = ...`.
- Declaration order in `rfc6962.ts` moves `DefaultHasher` to the end of the file, because a `const`
  cannot reference a `class` declared below it. This is the one place in this work package where
  ADR-0002's "declaration order identical to upstream" rule is bent, and it is forced by TDZ, not
  chosen.
- `.bind(...)` at call sites is noise a Go reader will not recognise. The alternative — defining
  `hashChildren` as an arrow-function property on the instance — would move the methods off the
  prototype and break `expect(a).toEqual(b)` on `Tree` values, which ADR-0010 depends on.

> **Update (2026-10-02):** two statements above did not match the code or the rest of the record, and are
> corrected here.
>
> - "This is the one place in this work package where ADR-0002's 'declaration order identical to upstream'
>   rule is bent" — the rule is ADR-0002's (and AGENTS.md §3.3's), but it is not the only bend: the testonly
>   split (ADR-0010) also changes file layout. The `DefaultHasher` move is the only *declaration-order* change
>   in `rfc6962.ts`; `rfc6962.ts` now says so in a port note on `DefaultHasher`, and carries Go's doc comment
>   for `New` on the constructor and the blank import's "SHA256 is the default algorithm." as a port note.
> - "The file also carries a `// Port note:`" pointed at this ADR under a file name that does not exist
>   (`0011-merkle-port-divergences.md`); `rfc6962.ts` and `testonly/tree.ts` now link this file.
> - `RangeFactory`, whose Go form is the composite literal `&compact.RangeFactory{Hash: h}`, follows the same
>   pattern as `New`: it is built with `new RangeFactory(h)`, its exported field is the `readonly` property
>   `hash`, and factories compare by identity as Go's pointers do. `range.ts` documents this in a port note.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. (The update carried no review line.)
Each of its three corrections is checked in the Review below.*

## Alternatives considered

- **Export `newHasher` / `newTree` alongside the constructors.** Rejected: two ways to build one
  object in a donated library, for the sake of a name that does not survive translation anyway.
- **Name them `New` (PascalCase, unchanged).** Legal TypeScript. Rejected: it breaks ADR-0002 for
  every other function in the package, and `rfc6962.New(...)` in TypeScript reads as a class.
- **Port `crypto.Hash` as a registry** (a `Map<number, CHash>` plus a `crypto.SHA256` constant).
  Rejected as pure invention: the registry exists in Go to let a `crypto.Hash` value cross a package
  boundary as a plain integer, which nothing in Tessera needs.
- **Hard-code SHA-256 into `Hasher` and drop the parameter.** Rejected: it removes the
  parameterisation upstream deliberately has, and `rfc6962_test.go`'s structure assumes `DefaultHasher`
  is one instantiation among possible others ("TODO(pavelkalinnikov): Apply this test to all
  LogHasher implementations").

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Checked against `merkle@v0.0.2`. `rfc6962.New(h crypto.Hash) *Hasher { return &Hasher{Hash: h} }`,
    `DefaultHasher = New(crypto.SHA256)`, the blank import `_ "crypto/sha256" // SHA256 is the default algorithm.`,
    `EmptyRoot` as `t.New().Sum(nil)` and `Size()` inherited from the embedded `crypto.Hash` are as described;
    `testonly.New(hasher merkle.LogHasher) *Tree` likewise; `rfc6962` imports only `crypto`, so there is no upstream
    `LogHasher` assertion, and the TODO quoted in the last alternative is at `rfc6962_test.go:72`. In
    `src/vendor/merkle/rfc6962/rfc6962.ts`, `Hasher` is `readonly hash: CHash` with a constructor, `emptyRoot`
    is `hash.create().digest()`, `size()` is `outputLen`, `hashLeaf`/`hashChildren` build `0x00||leaf` and
    `0x01||l||r`, the class `implements LogHasher` (type-only import; `hasher.ts` imports nothing), and
    `DefaultHasher = new Hasher(sha256)` is the last declaration with a port note saying why. `new Tree(hasher)`
    has the same shape. `rfc6962`, `testonly` and the rest of `src/vendor/merkle/{rfc6962,testonly}`: 4 files,
    94 tests pass.
  - The 2026-10-02 Update's three corrections are accurate: `DefaultHasher` is the only declaration-order change in
    `rfc6962.ts`; the file carries Go's `New` doc comment on the constructor and the blank-import comment as a port
    note; both `rfc6962.ts` and `testonly/tree.ts` now link `0011-merkle-constructors-and-hash-injection.md`;
    `RangeFactory` is `new RangeFactory(h)` with a `readonly hash`, and `range.ts` compares factories with `!==`
    where Go compares the pointers (`other.f != r.f` in `AppendRange`, `r.f != other.f` in `Equal`).
  - The argument that `new` cannot be a function name and that a second spelling would give a donated API two
    constructors is sound, and "inject the hash function, do not re-create `crypto.Hash`'s registry" is the right
    reading of `Hasher`'s only parameter. I have no objection to the decision.
  - Change requested (one item; wording, no code change). **The ADR states a call-site convention the code does not
    follow.** The Decision says "every place upstream passes a bare method value into a `HashFn`/`VisitFn` parameter
    is written" as `DefaultHasher.hashChildren.bind(DefaultHasher)`, and the Consequences speak of "`.bind(...)` at
    call sites". The ported tests do follow it (`compact/range_test.ts:32`), but in `src/` outside tests
    `.bind(DefaultHasher)` occurs once, in the differential harness (`testonly/testing/differential/merkle.ts:173`). Every library site wraps the method in an arrow function instead:
    `new RangeFactory((l, r) => DefaultHasher.hashChildren(l, r))` in `storage/internal/integrate.ts` (lines 259, 680),
    `client/client.ts` (629), `fsck/fsck.ts` (521) and `mirror/verify.ts` (135, 429), and
    `nodes.rehash(hashes, (l, r) => hasher.hashChildren(l, r))` in `client/client.ts:308` and `testonly/tree.ts`. The two
    forms are equivalent and the arrow form keeps `this` just as well, so nothing is wrong with the code; the record
    is. Add an Update saying that a method value is bound either with `.bind` or with an arrow wrapper, and that the
    arrow wrapper is the usual form; the `range.ts` port note ("must be bound first (ADR-0011)") is correct as it stands.
  - Not blocking, for the record. The last Consequences bullet says an arrow-function property on `Hasher` "would
    break `expect(a).toEqual(b)` on `Tree` values". That is true when two trees hold different `Hasher` instances
    (functions compare by reference), but the ported `TestTreeAppend` and `TestTreeAppendAssociativity` build both trees
    on the shared `DefaultHasher`, where it would not. The reasoning is a caution about a design that was not
    adopted, not a claim about the tests, so I leave it.
  - Status stays `proposed` until the Update is added.

## Update (2026-10-04): a method value is bound with `.bind` or with an arrow

This answers the Review above. The Decision says that every place upstream passes a bare method value is written
`DefaultHasher.hashChildren.bind(DefaultHasher)`. The code uses two forms, which are equivalent: each calls
`hashChildren` with its receiver, as Go's method value does.
- **The ported tests use `.bind`**, for example `compact/range_test.ts`, where Go writes
  `rfc6962.DefaultHasher.HashChildren`. So does the merkle differential harness
  (`testonly/testing/differential/merkle.ts`).
- **The library uses an arrow wrapper**, `(l, r) => DefaultHasher.hashChildren(l, r)` or the same with the
  caller's hasher, and that is the usual form. The sites are:
  - `storage/internal/integrate.ts`, twice;
  - `client/client.ts`, twice;
  - `fsck/fsck.ts`;
  - `mirror/verify.ts`, twice;
  - the merkle port's `testonly/tree.ts`;
  - the driver conformance suite.

The Consequences bullet on "`.bind(...)` at call sites" applies to either form. The Port note on `RangeFactory`
("must be bound first (ADR-0011)") holds as written.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. See the Re-review below.*

## Re-review (2026-10-04)

- **Re-review:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - The single point of the earlier Review (the Decision and Consequences describe `.bind` as the call-site form, the library uses an arrow wrapper) is answered by the Update, and its lists are right. Checked by grep over `src/`: arrow wrappers at `storage/internal/integrate.ts` 259 and 683, `client/client.ts` 308 and 629, `fsck/fsck.ts` 521, `mirror/verify.ts` 135 and 429, `vendor/merkle/testonly/tree.ts` 118 and 127, and `storage/objectstore/testing/driver_conformance.ts` 499; `.bind(DefaultHasher)` at `testonly/testing/differential/merkle.ts:173` and in the ported and port tests (`compact/range_test.ts:32`, where Go writes `rfc6962.DefaultHasher.HashChildren` at `range_test.go:33`; also `range_fixtures_test.ts` and `proof_test.ts`). The two forms are equivalent (both keep `this`), so no code needed to change. The `range.ts` port note ("must be bound first (ADR-0011)") is present and accurate.
  - The non-blocking remark of the earlier Review (the arrow-property alternative is a caution about a design not adopted) stands as it was.
