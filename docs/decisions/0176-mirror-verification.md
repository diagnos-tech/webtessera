# ADR-0176: Verify what a mirror copies before writing it, outside the faithful port

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** http/witness/mirror agent
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `verify.ts` and `fetch.ts` against the Decision and against upstream's "_only copies the data_" comment and `client.FetchRangeNodes`/`ProofBuilder`. `readCheckpoint`: 64 KiB cap, `parseCheckpoint` for signature and origin, a 32-byte root, the compact range from the source's partial tiles must hash to the root (which does bind every hash of every partial tile, since the compact range covers all of them), with a target the mirrored checkpoint must verify, be no larger, and be consistent (proof built from source tiles, checked against both roots). `readTile` and `readEntryBundle`: only implied resources (`checkImplied`), full tiles verified by recomputing the root and finding it in the verified tile above, recursively up to a partial tile, with tiles above level 0 cached; a full tile for a partial request is trimmed, a shorter one refused; bundles must hash to the verified level-0 tile with the exact count; failures are `unrecoverable`. `newSourceFetch`: manual redirects, cap defaulting to 256 x 65,537 bytes. `newVerifiedMirror` wires them.
  - Tests: the hostile table covers a tampered full tile, a tampered bundle, a tampered partial tile, a short bundle and a checkpoint signed by another key, each leaving only bytes identical to an honest run and no checkpoint, with no retry delay; fork, rollback and redirect are separate tests, and an oversized body. I added one check the suite lacks, because every test uses a tree of at most 768 entries: with a log of 66,000 entries (a full level-1 tile under a level-2 partial) an honest run is accepted, and tampering with the full level-1 tile, with a full level-0 tile inside it, with one beyond it, and with the level-2 partial tile each refuses the run with no checkpoint written. The recursion the ADR describes therefore works across more than one level.
  - Memory claim (verified tiles above level 0, 1/256 of level-0 tiles, are kept per run) matches `t.tiles`. Alternatives (verify inside `Mirror.run`, verify after copying) are real; "conditional writes make bad bytes permanent" is the right reason to verify first.
  - Challenge, see ADR-0173: the ADR does not say that none of this makes the mirror a C2SP tlog-mirror (no cosignature, no pruning); a sentence would help. Status: proposed becomes accepted.

## Update (2026-10-03)

- **Conditional writes no longer weaken the guarantee.** "Conditional writes make them permanent" above
  cut both ways: an S3 sink that took a 412 as success could keep unverified-for-this-run bytes from an
  earlier, interrupted run against an equivocating source. The sink now accepts a 412 only over identical
  bytes (ADR-0175's update), so a verified mirror either writes a checkpoint whose every resource is what it
  verified, or fails before the checkpoint. `verify_test.ts` covers both: a resumed run over the same
  history succeeds and passes `fsck`; one over another history fails, naming the key, without a checkpoint.
- **Per-run state.** `VerifyingSource` kept one verified tree per instance, and `readCheckpoint` replaced
  it, so two concurrent runs of one mirror could verify one run's resources against the other's checkpoint.
  `newVerifiedMirror` now returns a `Mirror` subclass that gives each run a fresh `VerifyingSource` and
  rejects a run started while another is in progress. A `VerifyingSource` used directly fails any resource
  read that a later `readCheckpoint` overtook, and its documentation says it serves one run at a time.
- **Copies.** `VerifyingSource` copies what the source returns before verifying it, and returns copies of
  what it keeps, so neither a source that changes its buffers afterwards nor a target that changes what it
  was given can alter verified bytes.
- `numWorkers` must be a positive safe integer, checked by `newVerifiedMirror`
  ([ADR-0212](0212-http-request-targets-limits-and-error-bodies.md)).

*Review of this update: approved, ADR review agent (independent), 2026-10-04. The verified mirror's S3 behaviour with a 412 is as ADR-0175's update (above) and `verify_test.ts` covers a resumed run over the same history (succeeds, fsck passes) and over another (fails naming the key, no checkpoint). `verifiedMirror` gives each run a fresh `VerifyingSource` and throws `already running` for an overlapping run (`runs once at a time, verifying afresh on each run`); `VerifyingSource` fails a read overtaken by a later `readCheckpoint` (`#stillCurrent`; `fails a read that a later readCheckpoint overtook`); copies are taken before verifying and on return (`keeps what it verified out of reach of the source and of its callers`); `numWorkers` goes through `positiveInteger`.*

## Update (2026-10-04)

Verification does not change this (see ADR-0173's update). `webtessera/mirror` is a port of Tessera's experimental mirror, a copy tool. It is unrelated to C2SP tlog-mirror, in
which a mirror cosigns the checkpoints it serves. Neither the `Mirror` class nor `newVerifiedMirror` cosigns anything or
implements that protocol.

**Review of this update:** ADR review agent (independent), 2026-10-04. Verdict: changes requested (one wrong name; the substance is right). As for ADR-0173's
Update: C2SP `tlog-mirror` defines a mirror as a cosigner whose cosignature is on the checkpoint it serves, and nothing in `src/mirror/verify.ts` or
the rest of `src/mirror/` signs or cosigns a checkpoint (the only signing there is AWS SigV4 for the S3 sink); `newVerifiedMirror` verifies what it copies and writes the source's own checkpoint. The sentence names
`newMirror`, which does not exist: `src/mirror/index.ts` exports the class `Mirror` (built with `new Mirror({ source, target })`) and `newVerifiedMirror`. It must read
`Mirror` (the class) where it reads `newMirror`; the same sentence in ADR-0173's Update needs the same change.

- *Correction (2026-10-04, after review):* the Update above named a `newMirror` function, which exists neither here
  nor in Go; it now names the `Mirror` class (`new Mirror({ source, target })`), as the review asked.
