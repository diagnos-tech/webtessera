# ADR-0184: Witness policies reject repeated group children, shared verifier keys and a zero threshold

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** root-package fidelity agent
- **Upstream reference:** `witness.go` (`NewWitnessGroupFromPolicy`, `WitnessGroup.Satisfied`), `witness_policy_test.go`

## Context

`NewWitnessGroupFromPolicy` builds a tree of witnesses and groups, and `WitnessGroup.Satisfied`
counts how many of a group's children are satisfied by a checkpoint's cosignatures. Three policy
shapes that upstream accepts let that count say more than the policy's author can have meant:

- a group that names the same child more than once (`group g 2 w1 w1`): the child is counted
  once per mention;
- two witness names declared with the same verifier key: a cosignature from that key satisfies
  both names;
- an explicit threshold of `0` (`group g 0 w1`): the group is satisfied by no cosignatures at all,
  which the policy format already expresses as `quorum none`.

In each case a group can report a threshold as met with fewer distinct witnesses than its
threshold. Upstream's own `witness_policy_test.go` contains the second shape: its GroupN and
"negative threshold" policies give `w3` the same key as `w2`.

## Decision

As hardening, `newWitnessGroupFromPolicy` rejects all three:

- a `group` line that names a child it has already named: `repeated component "<name>" in group definition`;
- a `witness` line whose Ed25519 public key was already declared under another witness name,
  whatever key name or algorithm byte (both accepted by `newVerifierForCosignatureV1`) it is
  published under: `witness "<new>" has the same verifier key as witness "<old>"`;
- a numeric group threshold of `0`: `invalid threshold "0" for group "<name>": must be at least 1`.

`quorum none`, `group <name> all` and `group <name> any` are unchanged, as is `newWitnessGroup`
itself, which applications and upstream's `witness_test.go` call with a threshold of 0 directly.

In `witness_policy_test.ts`, the ported GroupN and "negative threshold" cases give `w3` a key of
its own (the `Wit3` key from `witness_test.go`) so that they keep testing the thresholds they were
written for; a port addition keeps upstream's shared-key shape as a rejected policy.

## Consequences

- Policy files that use any of the three shapes are refused by this port and accepted by Go. That
  is a deliberate divergence. The likely real-world case is a copy-paste error, which the error
  now points at.
- Two upstream test policies are adapted rather than ported verbatim, with a port note at the
  test; their assertions (the parsed thresholds and the expected error) are unchanged.
- Overlap through nesting (a witness reachable both directly and through a subgroup of the same
  group) is not rejected by this change; only direct repetition and shared keys are.

## Alternatives considered

- **Keep Go's behaviour.** Rejected: a witness policy is a security boundary, and these shapes
  let it be met by fewer independent witnesses than it states.
- **Deduplicate silently** (count each child or key once). Rejected: it would quietly change the
  meaning of a policy file instead of telling its author.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
