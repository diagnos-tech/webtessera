# ADR-0090: `container/list` port — generics instead of `any`, `New` → `newList`, `_`-prefixed package-private fields

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** fsck agent
- **Upstream reference:** `container/list/list.go`, `container/list/list_test.go` (Go standard library, not part of Tessera itself)

## Context

`fsck/status.go`'s `rangeTracker` is backed by Go's `container/list` (a doubly linked list),
which has no TypeScript standard-library equivalent and no prior port anywhere in this
codebase. It needed to be added to `src/internal/gostd/` before `status.ts` could be
written, per the mission brief's instruction to "port it with its own `list_test.ts` before
you need it."

Three mechanical decisions came up while porting it, none covered by an existing ADR:

1. `container/list` predates Go generics. `Element.Value` is typed `any` (an alias for
   `interface{}`), and every `List` method that takes or returns a value is typed against
   that same `any`. AGENTS.md §7's "no `any`" rule for donatable code is about TypeScript's
   `any` escape hatch specifically, but the naive mechanical translation of Go's `any` here
   would be exactly that: `class Element { value: any }`.
2. `list.go` exports a bare package-level constructor, `func New() *List`. ADR-0002's
   mechanical camelCase mapping turns `New` into `new`, which is a reserved word in
   JavaScript/TypeScript and cannot be used as a function or variable identifier.
3. `Element`'s `next`/`prev` fields and `List`'s `root`/`len` fields are all unexported in
   Go, and `list_test.go` (an in-package test, ported here as `list_test.ts`) reads several
   of them directly (`e.prev`, `e.next`, `&l.root`, `l.root.next`, `l.root.prev`). Every
   method on `List` also needs to read and write `Element`'s `list`/`next`/`prev` fields
   from a *different* class — something Go's same-package field access allows for free but
   which ECMAScript `#private` fields cannot do across class boundaries.

## Decision

1. **`List<T>`/`Element<T>` are generic**, parameterised over the value type, instead of
   using TypeScript's `any`. Go's pre-generics `any` here plays exactly the role a type
   parameter plays in a modern generic container — it is the "hold a caller-chosen type"
   signal, not "opt out of the type system" — so a type parameter is the faithful rendering
   of the same intent, not an invented API. `Element<T>.value: T` is Go's exported `Value`
   field, camelCased per ADR-0002 (unchanged beyond that).

2. **`New` is renamed `newList`**, matching this codebase's established `new<Type>` factory
   convention (`newNodeID`, `newVerifier`, `newRangeTracker`, `newProofBuilder`, …) rather
   than colliding with the reserved word. This is the same kind of rename ADR-0010 already
   makes for field/method collisions, applied here to a reserved-word collision instead.

3. **Fields `List._root`, `Element._next`, `Element._prev`, `Element._list` are `_`-prefixed
   public members marked `@internal`**, following
   `docs/decisions/0010-package-private-members.md`'s established pattern exactly: they are
   Go-unexported, and are needed either by the ported `list_test.ts` directly (`_root`,
   `_next`, `_prev`) or by a sibling class within the same module (`List`'s methods reading
   and writing `Element._list`/`_next`/`_prev`, which no `#private` field can support across
   the class boundary). `List`'s `len` field, by contrast, is touched only by `List`'s own
   methods (no cross-class or test access), so it stays genuinely `#private` (`#len`) —
   applying ADR-0010's actual scope precisely rather than blanket-prefixing every unexported
   field regardless of who needs to reach it. The unexported *methods* `insert`, `remove`
   (Go's, distinct from the exported `Remove`), `move` and `lazyInit` are likewise
   untouched by any test and stay `#private`; only `Remove`/`remove`'s name collision
   forced `#remove` (a private method) to sit alongside the public `remove`, which the `#`
   sigil resolves for free since `#remove` and `remove` are different identifiers in
   JavaScript.

4. **A freshly constructed `Element<T>` self-loops** (`_next = _prev = this`) instead of
   using Go's `nil` zero value, so the fields can stay non-nullable (`Element<T>`, not
   `Element<T> | null`). `#insert` unconditionally overwrites both before the element is
   reachable from any list, so the initial value is never otherwise observed — this mirrors
   how `List`'s own sentinel ring already works (`&l.root` is a self-referencing node when
   empty), just applied one construction earlier.

5. **`List<T>`'s constructor always performs the work `Init()` does.** TypeScript classes
   have no zero-value equivalent to Go's `var l List` / `new(List)` (a struct with nil
   fields, lazily initialised on first use via `lazyInit()`); `new List<T>()` always runs
   the constructor, so the list is always ready to use immediately, identically to calling
   `New()`. `#lazyInit` is kept as a private, permanently-no-op method, called from the
   exact same call sites Go calls it from, purely so a reviewer diffing the two files sees
   the same shape — not because it does anything in this port.

## Consequences

- The only place `Element<T>`'s value is genuinely fabricated rather than caller-supplied
  is the list's root sentinel, constructed once per `List` as
  `new Element<T>(undefined as unknown as T)`. This value is never read: `front()`,
  `back()`, `Element.next()`/`.prev()` all explicitly compare against `_root` and return
  `null` rather than ever exposing it. The single narrowly-scoped cast is documented at its
  one call site in `list.ts`.
- `list_test.ts`'s `TestList` mixes value types in one list (`l.PushFront(2)` then
  `l.PushBack("banana")`), matching Go's untyped `any` list exactly; the port types that
  one list `List<number | string>` rather than `List<number>`, which is the direct
  translation of "this specific list holds either kind of value in this specific test."
  Every other test uses a single value type and is typed accordingly.
- `TestZeroList`'s `new(List)` (Go's explicit zero-value construction, as opposed to
  `New()`) becomes `new List<number>()` here — see point 5 above for why the two produce
  identical observable behaviour in this port.
- Donation: `container/list` is BSD-3-Clause (Go's own standard library licence), not
  Apache-2.0. `list.ts` carries the full BSD-3-Clause text reproduced inline, following the
  precedent `src/internal/gostd/cryptobyte.ts` already set for
  `golang.org/x/crypto/cryptobyte` (ADR-0040) — the same open item flagged there (a
  `LICENSE` file and a repository-level mixed-licence note are needed before publication)
  applies here too.

## Alternatives considered

- **`List<unknown>`/`Element<unknown>`, non-generic.** Closer to Go's "value of any type,
  caller's responsibility to assert it back" contract (`p.Value.(*Range)` in Go always
  needs an assertion too). Rejected: `status.ts`'s `rangeTracker` is the only real caller
  in this codebase and always stores `Range`, so `List<Range>` gives it that type back
  without a cast at every `.value` read, and `unknown` would force one. `list_test.ts`
  still exercises the untyped-feeling case directly via `List<number | string>`, so nothing
  about Go's actual flexibility goes untested.
- **Keep `New` and use bracket-property-style access (`list["new"]` or similar) to dodge
  the reserved word.** Rejected outright: unreadable, and no other reserved-word collision
  anywhere else in this codebase is handled that way.
- **Blanket-apply the `_`-prefix to every unexported field regardless of whether it is
  cross-class or test-reached** (as `compact/range.ts`'s `_f`, which has no colliding
  accessor, arguably does). Considered for consistency with that precedent, but rejected
  here: `List.len`/`Len()` *do* collide (the reason `_len` would be tempting), yet nothing
  outside `List`'s own methods ever needs to reach `len`, so genuine `#private` encapsulates
  it strictly better with no reviewability cost — ADR-0010's own text says the prefix "is
  not a general renaming rule," and this is the case that tests that claim directly.

## Review

- **Reviewer:** Fsck Reviewer
- **Verdict:** approved
- **Notes:** Diffed `list.ts` line-by-line against the real Go source at
  `/usr/local/go/src/container/list/list.go` (Go 1.25.5). Every method is a faithful
  translation: `insert`/`remove`/`move` pointer surgery is identical; `remove(e)` guards on
  `e._list === this` exactly as Go guards `e.list == l`; `insertBefore`/`insertAfter` return
  `null` when `mark._list !== this` (Go returns `nil`); `moveToFront`/`moveToBack`/`moveBefore`/
  `moveAfter` reproduce Go's early-return guards verbatim. The four semantics `status.ts`'s
  `rangeTracker` actually relies on — `remove`, `insertBefore`, `insertAfter`, `moveToFront` —
  are exact. Verified the self-loop-instead-of-nil decision (point 4) is observationally
  equivalent: `next()`/`prev()` gate on `_list !== null` *before* dereferencing, so a removed
  element's self-looped pointers are never observed, matching Go's nil-guarded `Next`/`Prev`
  (confirmed directly by the ported `TestIssue6349`). One benign, non-behavioural divergence:
  `pushBackList`/`pushFrontList` add `&& e !== null` to the loop condition where Go relies on
  `Len()` being exact and would nil-panic instead; identical behaviour for all valid inputs,
  and neither method is reached by `rangeTracker`. `list_test.ts` ports all 10 `list_test.go`
  cases (`TestList`, `TestExtending`, `TestRemove`, `TestIssue4103`, `TestIssue6349`, `TestMove`,
  `TestZeroList`, `TestInsertBeforeUnknownMark`, `TestInsertAfterUnknownMark`, `TestMoveUnknownMark`)
  with the same values; all green. Generics-over-`any`, `New`→`newList`, and the `_`-prefixed
  package-private fields are all consistent with ADR-0002/ADR-0010 precedent. Open licence item
  (BSD-3-Clause inline header, repo-level mixed-licence note) is correctly flagged, same as ADR-0040.
