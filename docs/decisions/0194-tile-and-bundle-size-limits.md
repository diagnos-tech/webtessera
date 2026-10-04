# ADR-0194: Tiles and entry bundles are held to their tlog-tiles sizes

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** api/client/fsck/storage-internal fidelity contributor
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

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**

## Update (2026-10-04): `fetchLeafHashes` with an absurd `N`

`client.FetchLeafHashes` preallocates its result, `make([][]byte, 0, N)`, before fetching anything, so an `N` it cannot
allocate aborts a Go process (`fatal error: runtime: out of memory` at `N = 2^40`, `panic: makeslice: cap out of
range` above). `fetchLeafHashes` grows its array as hashes arrive, so the same call fetches node by node and fails at
the first leaf the log does not have, `failed to fetch node {0 <i>}: require leaf nodes [<i>, <i+1>) but only got <i>
leaves`, with Go's text for that error. Like the size limits above, it turns an input that would take a process down
into an ordinary error; for every `N` Go can allocate the result is Go's.
