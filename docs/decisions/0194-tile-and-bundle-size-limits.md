# ADR-0194: Tiles and entry bundles are held to their tlog-tiles sizes

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity agent
- **Upstream reference:** `api/state.go` (`HashTile.UnmarshalText`, `EntryBundle.UnmarshalText`), `client/client.go` (`GetEntryBundle`, `nodeCache.GetNode`), `client/stream.go` (`Entries`), `fsck/fsck.go` (`fsckTree.AppendBundle`)

## Context

The tlog-tiles specification bounds a tile at 256 hashes and an entry bundle at 256 entries, and a
partial resource at its partial width. Upstream parses whatever it is given: `UnmarshalText`
accepts any multiple of 32 bytes as a tile and any number of entries as a bundle, and callers that
know the expected width use only part of what was parsed. Where a resource holds fewer elements
than the caller needs, `Entries` yields however many there are, and `fsckTree.AppendBundle`
panics on `hs[i]`.

## Decision

As hardening:

- `HashTile.unmarshalText` throws for more than 256 hashes; `EntryBundle.unmarshalText` stops with
  an error at a 257th entry.
- Where the caller knows the partial width `p` it asked for — `getEntryBundle`, `nodeCache.getNode`,
  `fsckTree.appendBundle` — a resource with more than `p` elements is rejected, unless it has
  exactly 256: the full resource the fetcher contract allows as a fallback for a partial one.
- On the "at least" side the check sits where elements are consumed: `entries()` throws when a
  bundle holds fewer entries than its range needs, and `fsckTree.appendBundle` throws for fewer
  hashes than its range needs. `getEntryBundle` and `nodeCache.getNode` still accept fewer, as
  upstream does — upstream's own `TestGetEntryBundleAddressing` serves an empty bundle and
  `TestNodeCacheHandlesInvalidRequest` a one-leaf tile for a tree of ten — and `getNode`'s existing
  range check still reports a node that is then missing.

## Consequences

- Malformed or oversized resources fail with an error naming the resource and the counts, instead
  of being partly used, panicking, or silently shortening a stream.
- A well-formed log is unaffected: every check admits exactly what the specification allows,
  including the full-resource fallback.

## Alternatives considered

- **Exact width everywhere.** Rejected: it breaks the two upstream tests above, which pin that a
  short resource reaches the caller.
- **Keep upstream's behaviour.** Rejected as hardening: the bounds cost nothing on valid data.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `HashTile.UnmarshalText` and `EntryBundle.UnmarshalText` (`api/state.go`) accept any multiple of 32 bytes and any entry count; `GetEntryBundle`, `nodeCache.GetNode` and `fsckTree.AppendBundle` (`hs[i]`) use only what they need; `Entries` yields however many entries exist. The two upstream tests the ADR cites (`TestGetEntryBundleAddressing` serves an empty bundle, `TestNodeCacheHandlesInvalidRequest` a one-leaf tile for tree size 10) do depend on short resources reaching the caller.
  - TS: `HashTile.unmarshalText` rejects > 256 hashes, `EntryBundle.unmarshalText` stops at a 257th entry; `getEntryBundle`, `nodeCache.getNode` and `fsckTree.appendBundle` reject more than `p` elements unless exactly 256 (`p === 0` meaning a full resource); `entries()` and `appendBundle` throw for too few after upstream's own checks. Tests exist in `state_test.ts`, `client_test.ts`, `stream_test.ts` and `fsck_test.ts`; the differential allow-list row `tile-bundle-size-limit` names it.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.

## Update (2026-10-04): `fetchLeafHashes` with an absurd `N`

`client.FetchLeafHashes` preallocates its result, `make([][]byte, 0, N)`, before fetching anything, so an `N` it cannot
allocate aborts a Go process (`fatal error: runtime: out of memory` at `N = 2^40`, `panic: makeslice: cap out of
range` above). `fetchLeafHashes` grows its array as hashes arrive, so the same call fetches node by node and fails at
the first leaf the log does not have, `failed to fetch node {0 <i>}: require leaf nodes [<i>, <i+1>) but only got <i>
leaves`, with Go's text for that error. Like the size limits above, it turns an input that would take a process down
into an ordinary error; for every `N` Go can allocate the result is Go's.

**Review of this update** — Reviewer: ADR review agent (independent), 2026-10-04. Verdict: approved.

- Checked against Go: `FetchLeafHashes` does `make([][]byte, 0, N)` first. Running the real function with `N = 2^40` gives `fatal error: runtime: out of memory`, and with `N = 2^50` `panic: runtime error: makeslice: cap out of range`. The port grows its array, and for `N = 2^40`, `2^50` and `2^64-1` on a log of size 10 fails at `failed to fetch node {0 10}: require leaf nodes [10, 11) but only got 10 leaves`; Go's text for the same failure (checked with `N = 5`, size 3) is identical in form. Non-blocking: no test pins this Update (the existing `fetchLeafHashes` test covers only the `first+N` wrap).
