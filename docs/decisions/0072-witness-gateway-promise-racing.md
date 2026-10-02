# ADR-0072: `WitnessGateway.witness` uses promise racing, not a channel, to fan in results

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate contributor
- **Upstream reference:** `internal/witness/witness.go`'s `(*WitnessGateway).Witness`

## Context

Go's `Witness` method sends a checkpoint to every configured witness concurrently, consuming
responses **in arrival order** so it can return the moment the policy is satisfied, without waiting
for slower witnesses:

```go
results := make(chan sigOrErr)
for _, w := range wg.witnesses {
    waitGroup.Add(1)
    go func() {
        defer waitGroup.Done()
        sig, err := w.update(ctx, cp, size, pf.ConsistencyProof)
        results <- sigOrErr{sig: sig, err: err}
    }()
}
go func() {
    waitGroup.Wait()
    close(results)
}()

for r := range results {
    ...
    if newCp := sigBlock.Bytes(); wg.group.Satisfied(newCp) {
        return newCp, nil
    }
}
```

If `Witness` returns early — because the policy is already satisfied — any goroutine still running
at that point eventually calls `results <- sigOrErr{...}` on an **unbuffered** channel that nobody
is receiving from any more (the `for r := range results` loop already returned). That send blocks
forever: the goroutine is genuinely leaked, reachable and running but never able to finish, for the
lifetime of the process. `defer cancel()` on the method's `context.WithCancel` derivative does cancel
the HTTP request the goroutine is doing, which speeds up reaching that blocked send, but does not
prevent it. This is a real, if narrow and probably intentional (log traffic to a slow witness after
quorum is reached is genuinely uninteresting), characteristic of Go's channel-based fan-in.

## Decision

`src/internal/witness/witness.ts`'s `WitnessGateway.witness` uses `Promise`s instead of a channel:

- Each witness's `update(...)` call is wrapped so it **never rejects** — success and failure both
  resolve to a `{ sig, err }` object, mirroring Go's `sigOrErr`.
- A `raceWithIndex` helper (`Promise.race` over the still-pending array, tagged with each promise's
  position) lets the method consume results in arrival order exactly as the Go `for r := range
  results` loop does, removing each settled entry from the pending list as it resolves.
- On early return (the policy becomes satisfied), the method's `finally` block aborts an internal
  `AbortController` — the same `defer cancel()` Go already does — but takes no further action on the
  still-pending promises. Since nothing in this port ever `await`s them again, they simply run to
  completion (or fail, once their `AbortSignal` fires) and are garbage collected once nothing
  references them. **No leak is possible**, because a `Promise` with no listener has nowhere to
  "block" the way a channel send does — JavaScript's event loop never stalls waiting for someone to
  read a resolved value nobody asked for.

This is a case where the language's semantics resolve a hazard the Go source structurally has,
without needing an equivalent workaround.

## Consequences

- Observable behaviour is identical: results are still consumed in arrival order, `Witness`/`witness`
  still returns the instant the policy is satisfied, and `errorIs`-style checks against
  `ErrPolicyNotSatisfied` still work (see ADR-0075 for that error's own shape).
- `TestWitnessReusesProofs` (`internal/witness/witness_test.ts`) exercises real concurrent racing —
  two witnesses, one `sharedConsistencyProofFetcher` — and passes, which is the strongest evidence
  available that the racing logic does not introduce ordering bugs the channel-based original does
  not have.
- A future reviewer comparing this file to `internal/witness/witness.go` line by line will find no
  direct counterpart for the `results` channel, the `waitGroup`, or the `close`-on-`Wait` goroutine —
  this ADR is that structural gap's explanation.

## Alternatives considered

- **A hand-rolled bounded channel type** (`push`/`shift` plus waiter promises) to keep the code
  structurally close to Go's channel. Rejected: it would still need the same "stop consuming after
  the policy is satisfied, but don't block whoever is still pushing" logic `raceWithIndex` already
  gives for free, at the cost of a whole new synchronization primitive with its own tests to write —
  more machinery for a worse fidelity story (JavaScript's `Promise` genuinely is not a channel, and
  pretending otherwise invites bugs).
- **`Promise.allSettled` after all witnesses respond**, dropping the early-return-on-satisfaction
  behaviour entirely. Rejected: it changes observable behaviour (an already-satisfied policy would
  wait for the slowest witness every time) and the whole point of `Witness`'s design, per its own doc
  comment, is returning as soon as the policy is met.

## Review

- **Reviewer:** Witness/Migrate Reviewer
- **Verdict:** approved
- **Notes:** Checked `WitnessGateway.witness` against Go's `(*WitnessGateway).Witness` fan-in.
  The characterisation is accurate: Go's early `return newCp, nil` on satisfaction leaves any
  still-running goroutine blocked forever on `results <- ...` into an unbuffered channel nobody
  drains — a real, benign leak. The port's `raceWithIndex` + `pending.filter(i !== index)` consumes
  settlements in arrival order exactly as `for r := range results` does, and each per-witness
  `update` is wrapped `.then(sig=>({sig}), err=>({err}))` so it never rejects — the direct analogue
  of `sigOrErr`. Observable results are identical: same accumulation of signature lines into
  `sigBlock`, same "return the instant `group.satisfied` is true", same `PolicyNotSatisfiedError`
  (ADR-0075) when exhausted. The "resolves differently under a race" worry does not apply — signature
  *order* in the accumulated block can differ run-to-run, but so can Go's (channel arrival order is
  scheduler-dependent), and `group.satisfied`/`note.Open` are order-independent, so the winning value
  and the surfaced error are the same for every input the tests cover. `finally { controller.abort() }`
  mirrors `defer cancel()`. No leak is structurally possible in the port. `TestWitnessReusesProofs`
  exercises the real 2-witness race and passes.
