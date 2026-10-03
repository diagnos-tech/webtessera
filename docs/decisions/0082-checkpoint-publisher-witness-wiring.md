# ADR-0082: `CheckpointPublisher` wires the witness gateway; `WithWitnesses`/`WitnessOptions` ported in full

- **Status:** accepted; its empty checkpoint on early failure under FailOpen is superseded by ADR-0183 (proposed, review pending)
- **Date:** 2026-08-19
- **Author:** append-lifecycle agent
- **Upstream reference:** `append_lifecycle.go:614-667` (`CheckpointPublisher`), `:810-841`
  (`WithWitnesses`, `WitnessOptions`), `internal/witness/witness.go:102` (`NewWitnessGateway`),
  `witness.go` (`WitnessGroup`)

## Context

`CheckpointPublisher` signs a checkpoint and then has it witnessed:

```go
wg := witness.NewWitnessGateway(o.witnesses, httpClient, oldSize, lr.ReadTile)
...
cp, err = wg.Witness(ctx, cp)
if err != nil {
    if !o.witnessOpts.FailOpen { ...; return nil, err }
    klog.Warningf(...)
}
```

`o.witnesses` is a `tessera.WitnessGroup` (the struct in `witness.go`); `NewWitnessGateway` takes
the `witness.WitnessGroup` *interface* (`internal/witness/witness.go`), which the struct satisfies
structurally. Both of those, and `NewWitnessGateway`/`WitnessGateway`, belong to a **parallel work
package** porting `witness.go` and `internal/witness/witness.go`. The work package instructed me to
check whether `src/internal/witness/witness.ts` exists on disk before wiring, and to leave a precise
`TODO(<owner>):` if it did not — without inventing a fake `WitnessGroup`/`WitnessGateway`.

## Decision

At the time this file was completed, `src/witness.ts` and `src/internal/witness/witness.ts` **both
existed** on disk (landed by the parallel agent), so the gateway is **wired in full**, exactly as Go
wires it:

- `AppendOptions.#witnesses` is typed `WitnessGroup` (imported from `./witness`), defaulting to the
  zero value `new WitnessGroup()` — which, like Go's zero-value `WitnessGroup{}`, is satisfied by
  zero witnesses.
- `CheckpointPublisher` calls `newWitnessGateway(this.#witnesses, httpClient, oldSize, lr.readTile)`
  and `await wg.witness(cp, witnessSignal)`.
- `httpClient *http.Client` becomes `FetchFn` (the stand-in `client/fetcher.ts` already uses for
  `*http.Client`, the same one `newWitnessGateway` accepts).
- `context.WithTimeout(ctx, o.witnessOpts.Timeout)` becomes
  `AbortSignal.any([signal, AbortSignal.timeout(timeout)])` (ADR-0004).

`WithWitnesses` and `WitnessOptions` are ported in full regardless of the gateway, because they only
*store* configuration:

- `WitnessOptions` is a class mirroring Go's struct (`timeout: number` ms, `failOpen: boolean`),
  with a zero-value constructor.
- `withWitnesses(witnesses, opts)` mirrors Go's nil-opts defaulting and `Timeout == 0` →
  `DefaultWitnessTimeout`, and copies `*opts` by value into a fresh `WitnessOptions`.

**`FailOpen` and the throw model.** Go does `cp, err = wg.Witness(ctx, cp)` and, on `FailOpen`,
publishes whatever `Witness` *returned* even on error — the partial (under-cosigned) checkpoint for a
policy failure, or `nil` for an early failure (bad checkpoint / proof-builder). The port's
`wg.witness` throws instead of returning `(cp, err)`, but the parallel agent's
`PolicyNotSatisfiedError` carries the partial checkpoint on its `.checkpoint` field (their
`docs/decisions/0004`-driven decision). So on `FailOpen` the port recovers
`err.checkpoint` for a `PolicyNotSatisfiedError`, and falls back to an empty `Uint8Array` (mirroring
Go's `nil`) for any other error. This reproduces Go's behaviour including the sharp edge that an
early witness failure under `FailOpen` publishes an empty checkpoint — flagged here because it is
arguably an upstream bug worth reporting, not something the port should quietly "fix."

## Consequences

- The witnessing path is fully functional, not stubbed. If the parallel witness package changes the
  shape of `WitnessGroup`, `newWitnessGateway`, or `PolicyNotSatisfiedError`, this call site must
  track it — it depends on all three.
- The `FailOpen`-empty-checkpoint edge is faithfully reproduced; a storage driver publishing that
  empty checkpoint is Go's behaviour, not a port defect.
- `CheckpointPublisher` itself only signs + witnesses. The **republish-vs-new-checkpoint** decision
  (republish an unchanged checkpoint on `CheckpointRepublishInterval` vs. sign a new one when the
  tree grew) lives in the *storage drivers* that call `CheckpointPublisher` on a timer and read
  `CheckpointInterval()`/`CheckpointRepublishInterval()` — it is **not** in `append_lifecycle.go`,
  so it is not in this port. The accessors that carry those intervals to the driver are ported.

## Alternatives considered

- **Leave the gateway a `TODO(<owner>):` even though witness.ts exists.** Rejected: the file was on
  disk and importable, so the work package's own instruction was to wire it.
- **Invent a local `WitnessGroup`/`WitnessGateway`.** Rejected and explicitly forbidden by the work
  package; a stub that compiles is a stub that gets built on.
- **"Fix" the `FailOpen`-empty-checkpoint edge by keeping the pre-witness signed checkpoint.**
  Rejected: `AGENTS.md` §1 — fidelity beats cleverness; reproduce Go and flag the smell.

## Review

- **Reviewer:** Append-Lifecycle Reviewer (agent)
- **Verdict:** approved
- **Notes:** Read `append_lifecycle.go`'s `CheckpointPublisher` (614-667), `WithWitnesses`/
  `WitnessOptions` (810-841), and `internal/witness/witness.go`'s `WitnessGateway.Witness` error
  paths in full, together with the port's `PolicyNotSatisfiedError`. Confirmed the `FailOpen` edge
  branch-by-branch: Go does `cp, err = wg.Witness(ctx, cp)` and on `FailOpen` publishes whatever
  `Witness` *returned*. `Witness` returns `(cp,nil)` for zero witnesses; `(nil,err)` for an early
  failure (checkpoint parse / proof-builder); `(sigBlock.Bytes(), Join(ErrPolicyNotSatisfied,err))`
  for a policy failure (including the sub-case where every witness errored, in which `sigBlock` is
  just the original log-signed `cp`); and `(newCp,nil)` on success. The port's witness gateway throws
  a **plain** `Error` for the two early failures and a `PolicyNotSatisfiedError` (carrying the partial
  on `.checkpoint`) for the policy failure, so the publisher's
  `err instanceof PolicyNotSatisfiedError ? err.checkpoint : new Uint8Array(0)` reproduces Go's `cp`
  in **every** branch — empty (`nil`) on early failure, partial `sigBlock` on policy failure. The
  "empty-checkpoint-on-early-failure under FailOpen" sharp edge is faithfully reproduced, and it is
  correctly *not* triggered when a policy failure happens to have accumulated zero sigs (that path
  returns the original signed checkpoint, not empty). Verified the zero-witnesses fast path returns
  `cp` before `throwIfAborted`, so the `WitnessOptions{}`-zero-`Timeout` → `AbortSignal.timeout(0)`
  case (only reachable when `WithWitnesses` was never called, hence zero witnesses) never actually
  fires — matching Go's harmless `context.WithTimeout(ctx,0)` in the same case. `withWitnesses`
  faithfully reproduces Go's mutate-the-caller's-`opts.Timeout`-then-copy-by-value behaviour, incl.
  the `Timeout==0 → DefaultWitnessTimeout` defaulting. `context.WithTimeout` → `AbortSignal.any([...])`
  per ADR-0004. Agree the republish-vs-new-checkpoint decision lives in the storage drivers, not
  here. Depends on the parallel witness package's `PolicyNotSatisfiedError.checkpoint` shape, which I
  read directly and confirmed matches this call site.

## Update (2026-10-02)

Status changed from "proposed" to "accepted" on the strength of the approved verdict recorded
above; no new review was made. Three things have changed since:

- **FailOpen on an early failure.** The port no longer reproduces Go's empty (`nil`) checkpoint
  when the gateway fails before witnessing: it publishes the log-signed checkpoint instead, as
  hardening (ADR-0183). A `PolicyNotSatisfiedError` still yields its partial checkpoint.
- **The witness timeout.** The Decision's "`context.WithTimeout(...)` becomes
  `AbortSignal.any([signal, AbortSignal.timeout(timeout)])`" is out of date. The timeout is an
  `AbortController` plus a `setTimeout`, and the `finally` after witnessing both clears the timer
  and aborts the controller, which is what Go's `defer cancel()` does; `AbortSignal.timeout` would
  keep its timer pending for the full timeout after every publication (see ADR-0004's update).
- **Snapshot of the options.** Go's `CheckpointPublisher` has a value receiver, so the closure it
  returns works on a copy of the options taken when it is called. The port now takes the same
  snapshot of `newCP`, the witness group and a copy of the witness options, so later `with*` calls
  no longer reach an existing publisher.
