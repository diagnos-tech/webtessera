# A monitor that catches forks and rollbacks

A transparency log is only as honest as the checks made against it. This monitor follows a remote
tlog-tiles log; on every check it fetches the checkpoint, verifies the log's signature, and proves,
with a consistency proof built from the log's own tiles, that the new tree contains the last one it
verified. It keeps that checkpoint on disk, so a log that forks while the monitor is down is caught
when it comes back. A fork (two signed histories that cannot both be true) or a rollback (an older
checkpoint after a newer one) is reported loudly, with the two signed checkpoints that prove it.

The proving is `LogStateTracker` from `webtessera/client`, a port of Tessera's. The monitor uses
nothing but `fetch` and `node:fs`, which Node, Bun and Deno all provide, so it needs no adapter.

## How it works

```text
           every N seconds                               .monitor/
 log ─── GET /checkpoint, /tile/… ──▶ LogStateTracker ──▶ checkpoint  (last verified, written
  │                                    │                               atomically: temp + fsync
  │                                    │ signature ✓                   + rename)
  │                                    │ consistency(old ⊆ new) ✓
  │                                    ▼
  │                         grew / unchanged ──▶ save the new checkpoint
  │                         older, consistent ──▶ ROLLBACK alarm, keep ours
  └────────────────────────  inconsistent  ───▶ FORK alarm, evidence/fork-….txt, exit 3
```

## Run it

Build the library once at the repository root (`bun run build`). Then point it at
any tlog-tiles log, for example [`../log-server`](../log-server) running on port 8080:

```console
$ node src/main.ts http://127.0.0.1:8080/ "$LOG_VKEY" --once
2026-10-03T23:00:56.915Z trusting on first use a checkpoint of 4
2026-10-03T23:00:56.921Z ok: still 4 entries
$ bun src/main.ts http://127.0.0.1:8081/ "$LOG_VKEY" --once
2026-10-03T23:00:57.220Z resumed from a checkpoint of 4
2026-10-03T23:00:57.245Z ok: grew from 4 to 5 entries, consistency proven
$ deno run --allow-net --allow-read --allow-write src/main.ts http://127.0.0.1:8082/ "$LOG_VKEY" --once
2026-10-03T23:00:57.327Z resumed from a checkpoint of 5
2026-10-03T23:00:57.342Z ok: still 5 entries
```

Those three runs share one state directory (`.monitor`, or `--state DIR`), on three runtimes and
against three servers of one log. Without `--once` it checks every 30 seconds (`--every SECONDS`).
With `--once` the exit code is the verdict, for cron jobs and CI: 0 consistent, 1 could not check,
2 rollback, 3 fork. A fork looks like this, on stderr (here, a log that served `a, b, c` and then
a history signed by the same key that replaced `c`):

```text
2026-10-03T23:02:27.888Z resumed from a checkpoint of 3

!!! 2026-10-03T23:02:27.947Z FORK: the log signed two histories that cannot both be true.
log consistency check failed: calculated root:
[197 98 221 163 212 229 36 208 4 59 158 154 253 10 114 172 223 7 44 149 177 12 138 94 206 227 46 252 157 222 59 139]
 does not match expected root:
[54 100 46 115 194 84 10 177 33 227 166 191 149 69 176 162 73 130 205 131 14 177 61 60 209 157 227 206 108 2 30 193]
evidence: .monitor/evidence/fork-2026-10-03T230227.945Z.txt
```

The evidence file holds both checkpoints, each signed by the log, and the proof the log served,
which joins neither: anyone with the log's vkey can check that the log signed two incompatible
histories.

```text
## checkpoint 1
log.example/demo
3
NmQuc8JUCrEh46a/lUWwokmCzYMOsT080Z3jzmwCHsE=

— log.example/demo EcX939DwsYLb9k2Khd4U0qgQkNB54YNDT6jH4r7iP0X0Gt/iL5KcnJBgLQ0S/LumfAtbesBhyHeCGYFr0ASi/7B0EQQ=

## checkpoint 2
log.example/demo
4
vaInVwbH8dw5ND3o2kJ6VaiWxaCmqNa1TORMDncob1o=

— log.example/demo EcX937tfZDxNltiqJyaUeXmirVV70f+aZhBN6U1yXKHj3t88nHNUNJOAR3Z9BaWnlfj8U9A1lh0h1pOLNhnX8u04Cwc=
```

## Trust model

- **Trust on first use.** The first checkpoint the monitor sees is the one it trusts, after checking
  the log's signature. Start it from a checkpoint you obtained independently (write it to
  `.monitor/checkpoint`) to remove even that.
- **What one monitor proves** is that the log never showed *it* two histories. A fork that diverges
  only after the last checkpoint the monitor verified is, to this monitor, just the log's next
  state. Catching a log that shows different histories to different people takes several parties
  comparing checkpoints: other monitors, clients that gossip, or witnesses that cosign every
  checkpoint (see [`../session-receipts`](../session-receipts)).
- **A rollback** to an older checkpoint is often a stale cache, and is reported rather than adopted:
  the monitor keeps the newer checkpoint, so every later check is against it. An older checkpoint
  the log cannot even prove consistent (it no longer has the tiles) is reported the same way.
- **The state file matters.** Losing it resets trust to first use, which is why it is written
  atomically and durably.

## Test

```sh
npm run ci        # tsc --noEmit && vitest run
```

[`src/monitor_test.ts`](src/monitor_test.ts) runs the monitor against a deliberately forking fake
log, [`src/testing/forking_log.ts`](src/testing/forking_log.ts): two histories signed by the same
key, which is what a dishonest operator can produce. It checks quiet growth and resumption, a fork
of the same size, a fork that grew past what was verified, a fork made while the monitor was down,
a log that shrank while it was down, a rollback, and a checkpoint signed by another key; and that
the file store survives reopening.
`scripts/smoke.ts` runs the same scenario on Node, Bun and Deno.

## Files to read first

1. [`src/monitor.ts`](src/monitor.ts): one check, and what it remembers and reports.
2. [`src/state.ts`](src/state.ts): durable state and evidence.
3. [`src/testing/forking_log.ts`](src/testing/forking_log.ts): how a log forks.
4. [`src/main.ts`](src/main.ts): the command line.
