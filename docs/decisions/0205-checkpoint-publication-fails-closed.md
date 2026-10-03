# ADR-0205: Never publish an unparsable checkpoint, and never start a new tree over a published one

- **Status:** proposed
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

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
