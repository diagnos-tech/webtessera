# ADR-0013: Go slice aliasing in the merkle port becomes copies and explicit offsets

- **Status:** proposed
- **Date:** 2026-08-19
- **Author:** merkle agent
- **Upstream reference:** `merkle/compact/nodes.go` (`RangeNodes`), `merkle/proof/proof.go` (`nodes`, `reverse`, `Rehash`, `skipFirst`), `merkle/compact/range.go` (`appendImpl`, `GetRootHash`)

## Context

A Go slice is a view: `s[a:b]` shares the backing array, `append` may or may not write through to it,
and a method with a value receiver copies only the header. The merkle package leans on all three.

```go
// nodes.go — appends to the caller's slice and returns the new one
func RangeNodes(begin, end uint64, ids []NodeID) []NodeID

// proof.go — reverses a sub-slice in place
reverse(nodes[len(nodes)-right:])

// proof.go — rewrites h in place and returns a prefix of it
func (n Nodes) Rehash(h [][]byte, hc ...) ([][]byte, error) { ...; return h[:cursor], nil }

// proof.go — value receiver, so this mutates a copy
func (n Nodes) skipFirst() Nodes { n.IDs = n.IDs[1:]; ...; return n }

// range.go — truncate, append, extend, all through one backing array
r.hashes = append(append(r.hashes[:idx1], seed), hashes[idx2:]...)
```

A TypeScript array has none of this: `slice` always copies, there are no views, and there is no
value/reference distinction for objects.

There is also a nil/empty distinction. Go's `cmp.Diff` treats a `nil` slice and an empty non-nil
slice as different, and upstream's tests use both deliberately — `nodes()` (variadic, no args)
yields `nil`, while `Nodes{IDs: []compact.NodeID{}}` is written out explicitly for the cases where
`Inclusion` returns a non-nil empty slice.

## Decision

**`rangeNodes` always returns a fresh array.** Go's `append` is free to reallocate, and upstream's
own `TestRangeNodesAppend` asserts the caller's prefix is intact afterwards — so allocating is the
behaviour callers already rely on. Mutating the argument in place would make that test tautological
(the prefix and the result would be the same array).

**`reverse` takes an explicit offset:** `reverse(ids, from)` reverses `ids[from:]` in place, matching
`reverse(nodes[len(nodes)-right:])`. Reversing a copy and splicing it back would be the same
behaviour with more allocation and less resemblance to the original.

**`Rehash` keeps its in-place contract.** It writes the rehashed list over `h[0..cursor)` exactly as
upstream does — the doc comment's "Warning: The passed-in slice of hashes can be modified in-place"
is ported verbatim and is still true — and returns `h.slice(0, cursor)`. The return value is a copy
of the *array* holding the same `Uint8Array` references, where Go returns a view; no caller writes
through the result.

**`skipFirst` returns a new `Nodes`** rather than mutating the receiver, which is what Go's value
receiver already does.

**`appendImpl` rebuilds the hash array** as `[...this._hashes.slice(0, idx1), seed, ...hashes.slice(idx2)]`,
which is observably what the nested `append` produces.

**`nil` and empty slices both become `[]`.** Every `[][]byte`, `[]NodeID` and `[]byte` parameter or
return that can be nil in Go is a possibly-empty array here. The single exception is
`Range.GetRootHash`, which is documented to return `nil` for an empty range and whose emptiness is
load-bearing (`TestGoldenRanges` asserts it, and `compact_range.json` records
`emptyRangeRootIsNil: true`); it returns `Uint8Array | null`.

**`Uint8Array` slicing uses `subarray` only where Go aliases.** `shorten(hash)` in `range_test.ts`
returns a view, as `hash[:4]` does. Everywhere the port needs a copy it says `Uint8Array.from` or
allocates.

> **Update (2026-10-02):** "`appendImpl` rebuilds the hash array …, which is observably what the nested
> `append` produces" overstates it. Go's nested `append(append(r.hashes[:idx1], seed), hashes[idx2:]...)`
> writes into `r.hashes`' backing array when it has capacity, and that array can be shared with the slice a
> caller passed to `NewRange` or obtained from `Hashes()`; in Go such a caller can see its slice change after an
> `Append`. The port always builds a fresh array, so a caller's array is never modified. The *resulting range*
> is the same; the aliasing side effect on the caller's slice is not reproduced, and nothing upstream relies
> on it. The same holds for `newRange` (the port stores the caller's array, as Go stores the slice, but never
> writes into it).

## Consequences

- The nil-vs-empty distinction is lost, so a handful of upstream table cases that differ only in
  that respect collapse into one. Concretely: `TestRangeNodesAndSize`'s empty ranges, and the
  `Nodes{IDs: []compact.NodeID{}}` cases in `TestInclusion`/`TestConsistency`, no longer distinguish
  "returned nil" from "returned empty". Nothing in Tessera or in the tlog-tiles wire format depends
  on that difference — it is a Go representation detail, and JSON, `Uint8Array` and IndexedDB all
  erase it too.
- `rangeNodes` allocates one array per call. It is called once per proof and once per tile
  integration, not per hash, so this is not on a hot path. `TestGenRangeNodes` calls it 131k times
  and runs in ~12s, dominated by the reference implementation rather than the allocation.
- `Rehash`'s hybrid contract (mutates the input, returns a copy) is the one place a reader must be
  careful: mutating the returned array does not affect the input, but calling `rehash` does mutate
  the input. That is upstream's contract, stated in upstream's own warning.
- A future reader who "cleans up" `rangeNodes` to push onto its argument will make
  `TestRangeNodesAppend` pass vacuously. The test comment and this ADR are the guard.

## Alternatives considered

- **Model Go slices with an explicit `Slice<T>` view type** (`{array, offset, length}`). Faithful to
  aliasing, and would preserve nil-vs-empty. Rejected: every expression becomes a method call, which
  destroys the line-by-line correspondence that is this port's main asset — the same reason ADR-0003
  rejected a `Uint64` wrapper class.
- **Use `null` for Go's nil slices throughout.** Preserves the distinction. Rejected: it puts a
  `?? []` or a null check at every use site of every slice-typed value in the package, to preserve a
  difference no behaviour depends on.
- **Make `rangeNodes` mutate its argument** (closer to what Go's `append` usually does in practice).
  Rejected: see Decision — it would silently void an upstream test.
- **Make `Rehash` pure (never touch `h`).** Cleaner, and tempting. Rejected: it would make the ported
  doc comment false, and upstream callers — `testonly.Tree.InclusionProof` and
  `ConsistencyProof` — pass a freshly built array precisely because the contract allows the write.
  Changing it would hide a constraint the port's own consumers must respect.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
