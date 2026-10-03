# ADR-0011: Go `New` constructors become class constructors; `crypto.Hash` becomes a noble `CHash`

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** merkle contributor
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
>   rule is bent" — the rule is ADR-0002's (and PORTING.md §3.3's), but it is not the only bend: the testonly
>   split (ADR-0010) also changes file layout. The `DefaultHasher` move is the only *declaration-order* change
>   in `rfc6962.ts`; `rfc6962.ts` now says so in a port note on `DefaultHasher`, and carries Go's doc comment
>   for `New` on the constructor and the blank import's "SHA256 is the default algorithm." as a port note.
> - "The file also carries a `// Port note:`" pointed at this ADR under a file name that does not exist
>   (`0011-merkle-port-divergences.md`); `rfc6962.ts` and `testonly/tree.ts` now link this file.
> - `RangeFactory`, whose Go form is the composite literal `&compact.RangeFactory{Hash: h}`, follows the same
>   pattern as `New`: it is built with `new RangeFactory(h)`, its exported field is the `readonly` property
>   `hash`, and factories compare by identity as Go's pointers do. `range.ts` documents this in a port note.

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

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
