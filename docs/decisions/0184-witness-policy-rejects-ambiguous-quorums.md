# ADR-0184: Witness policies reject repeated group children, shared verifier keys and a zero threshold

- **Status:** accepted
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Go side: `NewWitnessGroupFromPolicy` (`witness.go:52-168`). Confirmed that upstream accepts a repeated child, two witnesses with one key, and a numeric threshold of 0, and that `witness_policy_test.go` itself declares `w3` with `w2`'s key in the GroupN and 'negative threshold' policies.
  - TS side (`witness.ts`): `repeated component "<n>" in group definition`, `witness "<new>" has the same verifier key as witness "<old>"` and `invalid threshold "0" for group "<n>": must be at least 1` are thrown after upstream's own checks for that line (the key check runs after `newWitnessFromRoot`, so it never pre-empts an upstream error). `verifierKeyID` keys on the 32 public-key bytes, so a different key name or algorithm byte (0x01 vs 0x04) is still caught: probed, and `newVerifierForCosignatureV1` (Go and port) accepts both algorithm bytes. `quorum none`, `all`, `any` and `newWitnessGroup` are unchanged. A threshold written `00` is also refused; `+0` is refused as a syntax error, as in Go.
  - Tests: the ported GroupN cases and 'negative threshold' use the `Wit3` key from `witness_test.go` with a port note, and 'rejects a second witness name for the same key' keeps upstream's shape as a rejected policy; each of the three rejections has an exact-message test. Upstream's 'duplicate component name' case still gets upstream's message (name check precedes the key check).
  - Pushback, non-blocking: `group g all` with no children yields n = 0 and `satisfied` is true for empty input (probe), which is the same degenerate class this ADR rejects for `group g 0 w1`. Consequences lists nested overlap as not rejected but not this; please list it, or reject it.
  - Full `bun run test:unit` (Vitest on Node 22.22.0), run twice during the review: 122 files, 3439 tests, all passed.
