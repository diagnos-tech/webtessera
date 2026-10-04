# ADR-0205: Never publish an unparsable checkpoint, and never start a new tree over a published one

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** hardening agent
- **Upstream reference:** `storage/posix/files.go` (`appender.publishCheckpoint`, `appender.initialise`, `appender.publishedSize`)

## Context

Two paths in the POSIX driver, which `src/storage/objectstore/driver.ts` ports, can leave a log unable to
continue or in conflict with what it has already published.

**Publishing.** `publishCheckpoint` writes whatever the checkpoint publisher returns:

```go
cpRaw, err := a.newCP(ctx, size, root)
...
if err := a.s.createOverwrite(layout.CheckpointPath, cpRaw); err != nil {
```

If the publisher ever returns an empty or malformed checkpoint without an error, it replaces the published one.
Every later `publishCheckpoint` then calls `publishedSize`, which cannot parse it and returns an error, so the
log never publishes again until an operator repairs the file by hand. Such a return is possible upstream (it is
reported privately), and a port of a publisher has the same exposure.

**Initialising.** `initialise` reads `.state/treeState`; if it is missing it starts a fresh tree, regardless
of what is already published:

```go
curSize, _, err := a.s.readTreeState(ctx)
if err != nil {
	if !errors.Is(err, os.ErrNotExist) { ... }
	// Create the directory structure and write out an empty checkpoint
	klog.Infof("Initializing directory for POSIX log at %q (this should only happen ONCE per log!)", ...)
	if err := a.s.writeTreeState(ctx, 0, rfc6962.DefaultHasher.EmptyRoot()); err != nil { ... }
	if a.newCP != nil {
		if err := a.publishCheckpoint(ctx, 0, 0); err != nil { ... }
	}
```

The log message says it should happen once. But the private state can go missing while the public files
survive — a backup or copy of the tlog-tiles files without `.state/`, a custom `ObjectStore` that lost a key,
an operator clearing what looks like a cache. The driver then signs a new checkpoint for a tree that starts
again from size 0 and re-sequences new entries at indices the log has already published under different
contents. The log key ends up signing two inconsistent trees, which is the one thing a log must never do and
cannot be undone.

## Decision

In `appender.publishCheckpoint`, the bytes returned by `newCP` are checked before they are written: they must
parse (with `checkpointUnsafe`, the parser `publishedSize` reads them back with) and commit to exactly the size
and root `newCP` was asked to sign. Otherwise `publishCheckpoint` throws and the published checkpoint is left
as it was:

- `newCP returned a checkpoint that does not parse, refusing to publish it: <parse error>`
- `newCP returned a checkpoint for a different tree (size …, root …; want size …, root …), refusing to publish it`

In `appender.initialise`, when `.state/treeState` does not exist, the driver checks whether a checkpoint is
published (`stat("checkpoint")`). If one is, it throws instead of starting a new tree, and writes nothing:

```
refusing to initialise a new tree: .state/treeState does not exist but a checkpoint is already published at
"checkpoint"; starting over would fork the published log (restore .state/treeState, or start the new log in an
empty store)
```

No automatic recovery is offered. Rebuilding `.state/treeState` from the published files would mean trusting
whatever is in the store, checking it against the checkpoint's signature and recomputing the root — an fsck and
a migration in one, which is the operator's decision, not something to do implicitly at start-up. The two
documented ways out are to restore the state file from the same backup as the public files, or to start the
new log in an empty store. (`MigrationStorage.initialise`, which builds a tree from a source log, is unchanged:
a migration target has no checkpoint of its own.)

## Consequences

- A misbehaving publisher costs one failed publish attempt, logged by the caller, instead of a log that can no
  longer publish. The next attempt republishes normally.
- A store with public files but no tree state no longer starts silently; it fails with an actionable message.
  This is a divergence from upstream's POSIX driver, whose behaviour is reported privately.
- Upstream's `TestPublishTree` installs a fake publisher that writes the root as hex (`%x`), which is not a
  parsable checkpoint for the tree; the ported test writes base64 instead, with a port note, and still observes
  updates through the same timestamp extension line.
- Publishing costs one extra parse of a few hundred bytes.

## Alternatives considered

- **Check only that the checkpoint is non-empty.** Rejected: garbage is as fatal as emptiness.
- **Check that it parses but not its size and root.** Rejected: a well-formed checkpoint for a different tree
  is worse than a malformed one, and the comparison is free.
- **Verify the signature too.** Rejected: the driver has no verifier (the signer is all it is given), and the
  bytes came from the log's own signer in the same process.
- **Rebuild the tree state from the published files on start-up.** Rejected as above; possible later as an
  explicit recovery tool built on fsck.
- **Refuse only if entry bundles exist.** Rejected: a published checkpoint alone is a commitment; a size-0
  checkpoint signed over a size-N one already contradicts it.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Code matches the described checks: `driver.ts` `checkPublishable` parses `newCP`'s output with `checkpointUnsafe` and requires the asked size and root, throwing the two messages quoted, before `createOverwrite`; `initialise` stats `checkpoint` when `.state/treeState` is missing and throws the quoted refusal. `MigrationStorage.initialise` is unchanged, as stated. Compared with Go's `publishCheckpoint` (`files.go:605-666`) and `initialise` (487-530). The ported `TestPublishTree` writes base64 with a port note, and the new tests ('refuses to start a new tree over a published checkpoint...', 'still initialises a store that has neither...') exist and pass.
  - Required change 1 (factual): the Decision says that on refusal the driver 'writes nothing'. `ensureVersion` runs first (as in Go) and creates `.state/version`. In the scenario the ADR itself describes (public files without `.state/`), a probe on the memory driver shows the store ends as `['.state/version', 'checkpoint']` after the refusal. The existing test hides this because it deletes only `treeState`. Either say 'writes nothing but the `.state/version` marker' or reorder the check, and make the test cover the no-`.state/` case.
  - Required change 2 (unsupported claim): the Context says an empty or malformed checkpoint from the publisher 'is possible upstream (it is reported privately)', and the Consequences repeat that upstream's behaviour 'is reported privately'. I could find no such path in Go's own components: `newCP` always returns a signed note or an error, and the only nil return in `CheckpointPublisher` comes from `Witness`'s two early returns, which ADR-0183's 2026-10-04 Update shows are unreachable with Go's components. State the actual path or reword to what is reachable (a custom publisher or policy), and reconcile with ADR-0183.
  - Wording: describes the fork hazard and accidental causes; no construction. Unverifiable disclosure claims are the issue above.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.

## Update (2026-10-04): the refusal writes nothing, and the publisher claim is narrowed

This answers the Review above. The decision is unchanged.

- **"Writes nothing" is now true.** Go's `initialise` (`files.go:487-530`) runs in this order:
  - it creates `.state/` and takes the tree-state lock;
  - it calls `ensureVersion`, which creates `.state/version` if the file is absent;
  - it calls `readTreeState` and, on `ErrNotExist`, writes a size-0 tree state and publishes.
  The port refused after `ensureVersion`, so in the ADR's own scenario (public files with no `.state/`) the refused
  store gained `.state/version`. `appender.initialise` (`src/storage/objectstore/driver.ts`) now makes the refusal
  decision first, from `stat` calls alone: no `.state/treeState` and a published `checkpoint`. A version file that
  already exists is checked before refusing, which only reads it, so a version error still comes first, as in Go.
  Everything after that runs in Go's order. A store that is not refused sees exactly Go's sequence of reads and
  writes, plus a `stat` of `.state/treeState`, and of `checkpoint` when the tree state is missing.
  A probe of the real POSIX driver at the pinned commit (Go 1.25.5) shows what the refusal prevents. A one-entry
  log, reopened after `.state/` was deleted, recreated `.state/version` and `.state/treeState`. It then replaced the
  size-1 checkpoint with a newly signed size-0 checkpoint.
- **Tests.** `driver_test.ts` covers this in three tests:
  - "refuses, and writes nothing, over published files with no .state/ at all" runs the ADR's scenario: a published
    log whose whole `.state/` is deleted. It asserts that every key and value is unchanged after the refusal.
  - "reports a bad version before refusing to start a new tree" pins Go's error order.
  - The earlier test, which deletes only `treeState`, still passes.
- **The publisher claim.** The Context said that an empty or malformed checkpoint from the publisher "is possible
  upstream (it is reported privately)", and the Consequences said the same of the initialise path. Both claims are
  withdrawn.
  - In Go, `newCP` returns a signed note or an error. `CheckpointPublisher`'s only `nil` return comes from
    `Witness`'s two early returns. ADR-0183's 2026-10-04 update shows that Go's own components never reach them.
  - In the port, a caller-built witness policy whose `satisfied` throws under `failOpen` once reached them. Since
    ADR-0183 it publishes the log-signed checkpoint instead.
  - So no publisher built from either codebase's components is known to return such bytes. The check in
    `publishCheckpoint` guards the driver's own invariant: whatever the publisher returns, a published checkpoint
    is one that `publishedSize` can read back.
  - It costs one parse. Without it, a misbehaving publisher would leave the log unable to publish again. Such a
    publisher could be a later change on either side, or a component outside these guarantees.
- **The initialise path.** It is reachable in Go as the Context describes. The probe above reproduces it. The
  Consequences sentence should read "This is a divergence from upstream's POSIX driver, which starts a new tree
  there".

*Review of this update: approved, ADR review agent (independent), 2026-10-04. See the Re-review below.*

## Re-review (2026-10-04)

- **Re-review:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Both required changes of the earlier Review are answered.
  - 1, "writes nothing". Go's order checked at `files.go:487-530`: create `.state/`, take the lock, `ensureVersion` (creates `.state/version` when absent), `readTreeState`. `appender.initialise` now decides the refusal first, from `stat`s alone: `.state/treeState` absent and `checkpoint` present. If `.state/version` already exists it still runs `ensureVersion` first, which only reads it, so a version error comes first as in Go; then it throws. Otherwise the sequence is Go's plus the stats. The tests are "refuses, and writes nothing, over published files with no .state/ at all" (the ADR's own scenario: `.state/` deleted entirely, every key and value compared after the refusal) and "reports a bad version before refusing to start a new tree"; the earlier test still passes. `src/storage/objectstore`: 154 tests pass. I also ran the real POSIX driver (probe `fixprobe/p3`, Go 1.25.5): a one-entry log reopened after `.state/` was deleted recreated `.state/version` and `.state/treeState` and replaced the size-1 checkpoint with a freshly signed size-0 one, which is the fork this refusal prevents.
  - 2, the publisher claim. Withdrawn in both places. Checked: in Go, `newCP` returns a signed note or an error, and `CheckpointPublisher`'s only `nil` return comes from `Witness`'s two early returns; the sentence about a caller-built policy whose `satisfied` throws agrees with ADR-0183's narrowed update (verified in this re-review), and since ADR-0183 the port publishes the log-signed checkpoint there. The only other "reported privately" wording in docs or src is in ADR-0202, which has its own review.
  - Non-blocking: the refusal now uses a `stat` of `.state/treeState` where the old code used the `ErrNotExist` branch of `readTreeState`. Under the held lock I see no way for the two to disagree.
