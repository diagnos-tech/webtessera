# ADR-0176: Verify what a mirror copies before writing it, outside the faithful port

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** http/witness/mirror contributor
- **Upstream reference:** `cmd/experimental/mirror/internal/mirror.go` ("Note that this function _only copies the data_; no self-consistency or correctness checking of the copied tiles/entries/checkpoint is undertaken."), `client/client.go` (`FetchRangeNodes`, `ProofBuilder`), `internal/fetcher/fallback.go`

## Context

Mirroring a log one does not operate into a public bucket makes the bucket publish whatever the
source serves. With immutable caching and conditional writes, a bad tile written once can never be
corrected. The security review required verifying the source checkpoint's signature and every tile and
bundle against it before writing, refusing redirects, and bounding everything fetched.

## Decision

The port stays faithful (ADR-0173). Verification is a separate `Source` decorator and a convenience:

- `newVerifyingSource(source, { origin, verifier, target? })`:
  - `readCheckpoint`: size cap (64 KiB); `parseCheckpoint` (log signature and origin); 32-byte root;
    the compact range for the size (`fetchRangeNodes` over the source's partial tiles, which are exactly
    the tiles the range is computed from) must hash to the root, which verifies every hash of every
    partial tile; with `target`, the mirrored checkpoint must verify too, be no larger, and be consistent
    (proof built from source tiles, checked against both roots), so a forked or rolled-back source cannot
    graft another tree onto the copy.
  - `readTile`: only resources implied by that checkpoint; a full tile is verified by recomputing its
    root and finding it in the verified tile above (recursively, ending at a partial tile); tiles above
    level 0 are cached as verified parents; a full tile served for a partial request (the fetchers'
    fallback) is trimmed to the partial width, anything shorter refused.
  - `readEntryBundle`: entries must hash to the verified level-0 tile, exact count.
  - Verification failures are `unrecoverable`, so the mirror's retries (meant for transient errors)
    stop at once.
- `newSourceFetch({ fetch?, maxBytes? })`: `redirect: "manual"` with 3xx refused ("MUST NOT serve
  redirect responses"), and bodies capped (default: the largest possible bundle, 256 × 65537 bytes).
- `newVerifiedMirror({ source: URL | string | Source, target: Target | Sink, origin, verifier, ... })`
  wires these with the port; it is the documented way to mirror.

## Consequences

- A mirror built this way writes only bytes proven to belong to a signed tree that extends what it
  already holds, and the checkpoint last; tests show hostile sources (tampered full tile, bundle, partial
  tile, short bundle, forged checkpoint, fork, rollback, redirect, oversized body) leave no unverified
  object and no checkpoint.
- Memory: verified tiles above level 0 are kept for a run (1/256 of the level-0 tiles).
- Upstream's raw `Mirror` remains available for an operator copying their own log.

## Alternatives considered

- **Verify inside `Mirror.run`.** Rejected: changes a ported file's structure; the decorator keeps the
  port diffable against upstream.
- **Verify after copying with fsck.** Rejected: unverified bytes would already be published, and
  conditional writes make them permanent.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
