# A monitor

This guide shows how to follow a log you do not trust and detect forks and rollbacks; read it when
you depend on a log that someone else runs.

**Example:** [`examples/monitor`](../../examples/monitor)

A log's promises (append-only, one history for everyone) are only worth what is checked. A monitor
checks, at every new checkpoint, that the log's key signed it and that the new tree contains the last
one it verified. `LogStateTracker` from `webtessera/client` (a port of Tessera's) does the proving;
what a monitor adds is memory and alarms.

```ts
const log = newHTTPFetcher(new URL(logURL));
const verifier = newVerifier(logVkey);
const consensus = unilateralConsensus((s) => log.readCheckpoint(s));

const saved = await state.load();                                        // last verified checkpoint
const first = saved ?? (await consensus(verifier, verifier.name())).raw;  // trust on first use
const tracker = await newLogStateTracker((l, i, p, s) => log.readTile(l, i, p, s), first, verifier, verifier.name(), consensus);

try {
  const { old, newer } = await tracker.update();   // throws ErrInconsistency on a fork
  if (newer !== old && newer !== undefined) await state.save(newer);
} catch (err) {
  if (err instanceof ErrInconsistency) alarm(err.smallerRaw, err.largerRaw, err.proof); // the evidence
}
```

## What to get right

- **Keep the raw checkpoint, durably.** The tracker keeps it to itself; take it from `update()`'s
  result, and write it atomically (temporary file, flush, rename). A monitor that forgets its
  checkpoint trusts whatever the log shows next.
- **Keep the evidence.** `ErrInconsistency` carries both checkpoints, each signed by the log, and the
  proof that failed: anyone with the vkey can check that the log signed two histories.
- **Tell a rollback from a fork.** A smaller checkpoint consistent with the tracked one is an older
  view (often a stale cache); the tracker verifies it and keeps its own. Report it, do not adopt it.
- **Know the limit.** One monitor proves the log never showed *it* two histories. A fork that only
  diverges after the last checkpoint it verified is, to it, the log's next state; catching split
  views takes several parties comparing checkpoints, or witnesses.

The example's tests point the monitor at a deliberately forking fake log (two histories signed by
one key) and check a fork of the same size, a fork that grew past what was verified, a fork made
while the monitor was down, a rollback, and a checkpoint signed by someone else. The monitor needs
only `fetch` and `node:fs`, so it runs unchanged on Node, Bun and Deno.
