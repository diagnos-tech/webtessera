# ADR-0081: `antispam.ts` ports the LRU subset it needs instead of adding `hashicorp/golang-lru`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** append-lifecycle agent
- **Upstream reference:** `antispam.go` (imports `github.com/hashicorp/golang-lru/v2`)

## Context

`antispam.go`'s `inMemoryDedup` uses a fixed-capacity cache from
`github.com/hashicorp/golang-lru/v2`:

```go
c, err := lru.New[string, func() IndexFuture](int(size))
...
if prev, ok, _ := d.cache.PeekOrAdd(id, f); ok { ... }
...
d.cache.Remove(id)
```

Exactly three operations are used: `New(size)` (which errors on `size <= 0` with
`"must provide a positive size"`), `PeekOrAdd(key, value)`, and `Remove(key)`. The full library is
a general-purpose LRU with `Get`/`Add`/`Contains`/`Keys`/eviction callbacks, none of which
`inMemoryDedup` touches. `AGENTS.md` §7 caps donatable dependencies at `@noble/*`, "and nothing
else," with the bar for more being "there is no other way."

Two properties of the actual usage matter for fidelity:

- `PeekOrAdd` on an **existing** key does not update recency (it is a *peek*).
- `inMemoryDedup` never calls a recency-bumping `Get`/`Add`; the only mutators are `PeekOrAdd`
  (adds new = most-recent) and `Remove`.

So for this usage, recency order is exactly insertion order minus removals, and eviction removes
the least-recently-inserted key when the cache is over capacity.

## Decision

Port the three-method subset as a module-private `LRUCache<V>` class inside `antispam.ts`, backed by
a JavaScript `Map` (which iterates in insertion order):

- `new LRUCache(size)` throws `"must provide a positive size"` for `size <= 0`, matching
  `hashicorp/golang-lru`'s `lru.New` error text (so `newInMemoryDedup`'s panic-message port
  `lru.New(%d): %v` stays byte-identical).
- `peekOrAdd(key, value)` returns `{previous, ok}`: on a present key, returns the value without
  touching order; on an absent key, inserts it and, if now over capacity, deletes the first
  (least-recently-inserted) map key.
- `remove(key)` deletes the key.

No general-purpose LRU is implemented — no `get`, no recency bump — because `inMemoryDedup` needs
none, and adding them would be inventing surface with no upstream call site. Because the only
mutators used are `peekOrAdd` and `remove`, insertion-order eviction is byte-for-byte identical to
`hashicorp/golang-lru`'s behaviour for every operation `inMemoryDedup` performs.

The cache key is `toHex(e.identity())` where Go uses `string(e.Identity())`; both are a
deterministic, collision-free string encoding of the 32-byte identity, which is all a map key needs.

## Consequences

- No new `package.json` dependency; the LRU lives and dies with `antispam.ts` and stays off the
  published API surface (module-private class).
- If a future antispam feature needs `Get`-with-recency-bump, this class must grow (and its
  insertion-order-only invariant re-examined). The `off-by-one` eviction risk the work package
  flagged is pinned by `antispam_test.ts`'s `TestDedup` (which primes three entries under a
  256-capacity cache) — but note that neither upstream test exercises eviction *at* capacity, so the
  boundary itself is asserted by construction/reading, not by a test that would fail on an
  off-by-one. Called out under "could not verify" for the reviewer.
- A transparency-dev reviewer sees a hand-rolled `LRUCache` where Go imports a well-known library,
  and needs this ADR to know it is a deliberate, minimal, dependency-avoiding subset.

## Alternatives considered

- **Add `hashicorp/golang-lru` (or a JS LRU package) to `package.json`.** Rejected: off the §7
  allow-list, and a 3-method usage does not clear the "there is no other way" bar.
- **Put the LRU in `src/internal/gostd/`.** Rejected: `gostd/` is for Go *standard-library*
  stand-ins (`AGENTS.md` §3.5.1); `hashicorp/golang-lru` is a third-party library, not stdlib.
- **A plain `Map` with manual size check inlined into `inMemoryDedup.add`.** Rejected: it buries the
  eviction invariant in the middle of the dedup logic, where the off-by-one the work package warned
  about would be hardest to see; a named class with the invariant documented is clearer.

## Review

- **Reviewer:** Append-Lifecycle Reviewer (agent)
- **Verdict:** approved
- **Notes:** Read `antispam.go` in full and cross-checked the three used operations against
  `hashicorp/golang-lru/v2`'s actual semantics. `New(size<=0)` → `"must provide a positive size"`
  matches the library's error text, so `newInMemoryDedup`'s `lru.New(%d): %v` panic-message port
  stays byte-identical (verified — the throw preserves it). `PeekOrAdd` on a present key returns the
  value **without** touching recency and without adding: the port's `peekOrAdd` returns
  `{previous, ok:true}` and mutates nothing — correct. On an absent key it inserts then evicts iff
  over capacity.

  I checked the eviction-at-capacity boundary explicitly, since the ADR flags it as untested by
  either upstream case. hashicorp evicts when `evictList.Len() > size` *after* the add; the port
  evicts when `#entries.size > #size` after `set`. Both hold up to `size` entries and evict exactly
  one on the `(size+1)`-th distinct insert, returning to `size`. No off-by-one: capacity is exactly
  `N`, not `N-1` or `N+1`. Because `inMemoryDedup` only ever calls `peekOrAdd` (no recency-bumping
  `Get`/`Add`) and `remove`, insertion order *is* recency order for this usage, so `Map`
  insertion-order eviction is byte-for-byte identical to the Go cache for every operation performed.
  The hex cache key (`toHex(e.identity())` vs Go's `string(e.Identity())`) is a sound substitution:
  both are deterministic, collision-free string encodings of the same 32-byte identity. `TestDedup`
  (×3) and `TestDedupDoesNotCacheError` pass and match Go's values. Agree `gostd/` is the wrong home
  (it is stdlib-only; hashicorp is third-party) and that a `package.json` dep does not clear
  AGENTS.md §7's "there is no other way" bar for a 3-method usage.

## Update (2026-10-02)

Status changed from "proposed" to "accepted" on the strength of the approved verdict recorded
above; no new review was made.
