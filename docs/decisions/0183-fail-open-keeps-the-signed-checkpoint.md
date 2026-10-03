# ADR-0183: When failing open, publish the log-signed checkpoint for errors other than a policy failure

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** root-package fidelity agent
- **Upstream reference:** `append_lifecycle.go:614-667` (`CheckpointPublisher`), `internal/witness/witness.go` (`WitnessGateway.Witness`)

## Context

`CheckpointPublisher` signs a checkpoint and has it witnessed:

```go
cp, err = wg.Witness(ctx, cp)
if err != nil {
	if !o.witnessOpts.FailOpen {
		...
		return nil, err
	}
	klog.Warningf("WitnessGateway: failing-open despite error: %v", err)
	...
}
...
return cp, nil
```

With `FailOpen` set, whatever `Witness` returned is published. For a policy failure that is the
checkpoint with the cosignatures that did arrive. For an error before witnessing starts (a
checkpoint it cannot parse, a proof builder it cannot create, a cancelled context) `Witness`
returns `nil`, and `CheckpointPublisher` returns an empty checkpoint with no error. A storage
driver then publishes that empty checkpoint, after which the log has no readable checkpoint until
the next successful publication. ADR-0082 recorded this as upstream behaviour and the port
reproduced it.

## Decision

As hardening, when `failOpen` is set and the witness gateway throws anything other than
`PolicyNotSatisfiedError`, `checkpointPublisher` returns the checkpoint it signed before
witnessing, never an empty one. A `PolicyNotSatisfiedError` still yields the partially cosigned
checkpoint it carries, exactly as before and as in Go. With `failOpen` unset, every error is
still thrown.

## Consequences

- Failing open now always publishes a checkpoint that at least carries the log's own signature,
  which is the most that "fail open" can mean when no witness has responded. The witness policy
  is not satisfied by it, as it is not by the partial checkpoint either.
- This supersedes the "empty checkpoint on early failure" part of ADR-0082's decision; ADR-0082
  carries an update note saying so.
- Upstream Go publishes `nil` in this case; this is a deliberate divergence. A port addition test
  pins it (an already-aborted signal makes the gateway throw before witnessing).

## Alternatives considered

- **Keep Go's behaviour.** Rejected: publishing an empty checkpoint leaves the log without a
  checkpoint clients can read, which is worse than either failing or publishing the signed one.
- **Throw instead, as if `failOpen` were unset.** Rejected: `failOpen` exists so that witnessing
  problems do not stop publication; throwing would turn a fail-open configuration into a
  fail-closed one for exactly the errors least related to the witnesses' answers.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
