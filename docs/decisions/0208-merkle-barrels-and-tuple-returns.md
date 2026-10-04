# ADR-0208: Merkle barrels export `Range` and `Nodes` as types, re-export `LogHasher`, and keep tuple returns

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** hardening contributor
- **Upstream reference:** `merkle/hasher.go`, `merkle/compact/{nodes,range}.go`, `merkle/proof/proof.go`; amends ADR-0010 and ADR-0031

## Context

Three findings of the 2026-10-02 merkle fidelity audit concern the shape of the merkle port's public surface.

- **F10.** `compact/index.ts` and `proof/index.ts` exported the classes `Range` and `Nodes` as values. Their
  constructors stand in for Go's composite literals `&Range{...}` and `Nodes{...}`, which are package-private
  because the types have unexported fields, and they perform no validation. Outside their modules, only
  `RangeFactory` constructs a `Range` and only `inclusion`/`consistency` construct a `Nodes`, exactly as in Go.
- **F8.** Go declares `LogHasher` in the root `merkle` package (`merkle/hasher.go`), which every verifier takes
  as its first argument. The port has `src/vendor/merkle/hasher.ts`, but no entry point exposes it, so a caller
  implementing a hasher could not name the interface it must implement.
- **F3.** ADR-0031 decided that Go multi-value returns become named objects, rejecting tuples because two
  same-typed positions can be swapped silently. The merkle port uses tuples: `decompose` → `[left, right]`,
  `NodeID.coverage()` → `[begin, end]`, `getMergePath` → `[low, high]`, `Nodes.ephem()` → `[node, begin, end]`.

## Decision

- **`Range` and `Nodes` are exported from the barrels as types only** (`export { type Range }`,
  `export { type Nodes }`), so `webtessera/merkle/compact` and `webtessera/merkle/proof` users can annotate
  values but not construct them. Tests keep importing the modules directly (ADR-0010). `NodeID` stays a value
  export: its fields are exported in Go, so `compact.NodeID{Level: l, Index: i}` is public there.
- **`LogHasher` is re-exported as a type from the `merkle/proof` barrel**, with a comment saying it is Go's root
  `merkle.LogHasher`. `proof` is the package whose functions take it. No runtime value is added.
- **The tuples stay.** Each pair is two halves of one thing (the left and right masks of one decomposition, the
  two ends of one leaf range), upstream's callers destructure them positionally under exactly those names
  (`left, right := Decompose(begin, end)`, `begin, end := fork.Coverage()`), and `Nodes.Ephem()`'s doc comment
  defines the order. A named object would rename upstream's results for no reviewer benefit, and the risk ADR-0031
  guards against — two unrelated values of one type in adjacent positions — does not arise. This is scoped to
  these four functions; ADR-0031 remains the rule elsewhere.

## Consequences

- The published surface no longer offers unvalidated constructors that Go keeps package-private.
- A transparency-dev reviewer comparing exported symbols sees one extra type in `merkle/proof` (`LogHasher`); it
  carries no behaviour.
- Swapping the two halves of a tuple still type-checks. The ported tests, the golden fixtures and the
  differential harness all exercise both halves of every tuple, which is the mitigation.

## Alternatives considered

- **A separate `webtessera/merkle` entry point for `LogHasher`.** Faithful to Go's package layout, but it needs a
  new `package.json` export (another work package's file) for a single interface.
- **Named objects for the merkle tuples.** Rejected as above.
- **Remove `Range`/`Nodes` from the barrels entirely.** Rejected: users of `RangeFactory` and `inclusion` need to
  name the types they return.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Code matches the Decision: `compact/index.ts` exports `Range` as a type and `NodeID` as a value, `proof/index.ts` exports `Nodes` as a type and re-exports `LogHasher` as a type; the tuple returns stay. Upstream's destructuring (`left, right := Decompose(...)`, `begin, end := fork.Coverage()`) and `Nodes.Ephem()`'s order are as the ADR says; I compared the exported symbols of the Go `compact` and `proof` packages with the two barrels and nothing else is missing.
  - Factual error in the Context and Consequences: they say Go's `Nodes{...}` literal is package-private 'because the types have unexported fields', that outside their modules only `inclusion`/`consistency` construct a `Nodes` 'exactly as in Go', and that the barrels no longer offer constructors 'Go keeps package-private'. In Go `proof.Nodes` has an exported field, `IDs []compact.NodeID` (`proof.go:28-31`), so `proof.Nodes{IDs: ids}` compiles outside the package and works with `Rehash`/`Ephem`; TypeScript's type-only export also leaves `ids` assignable. The decision to hide the constructor is defensible, but it narrows Go's surface for `Nodes` (and `&compact.Range{}` is a legal zero literal outside Go's package too).
  - Required change: correct those statements and list the narrowing for `Nodes` under Consequences.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
