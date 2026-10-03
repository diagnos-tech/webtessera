# ADR-0202: Require every proof hash and root to be a node hash of the hasher's size

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** hardening agent
- **Upstream reference:** `merkle/proof/verify.go` (`RootFromInclusionProof`, `VerifyInclusion`, `VerifyConsistency`); `formats/log/note.go` (`ParseCheckpoint`); C2SP tlog-checkpoint; C2SP tlog-tiles; RFC 6962 §2.1

## Context

`RootFromInclusionProof` checks the leaf hash's length against `hasher.Size()` and the proof's *element
count* against the tree shape, but not the length of each proof element; `VerifyInclusion` and
`VerifyConsistency` compare roots byte for byte without checking their lengths:

```go
if got, want := len(leafHash), hasher.Size(); got != want {
	return nil, fmt.Errorf("leafHash has unexpected size %d, want %d", got, want)
}
inner, border := decompInclProof(index, size)
if got, want := len(proof), inner+border; got != want { ... }
res := chainInner(hasher, leafHash, proof[:inner], index)
```

`HashChildren` hashes the concatenation of its arguments, so a node "hash" is treated as opaque bytes of any
length. A proof whose elements are not node hashes is not a proof of the RFC 6962 tree the verifier believes
it is checking, and a verifier should not accept one; in a transparency log, accepting proof material whose
structure the verifier does not check weakens the guarantee that all parties are looking at the same tree.

The port is a faithful translation and inherited the same behaviour. The issue is reported upstream
privately; this repository records only the invariant.

Checkpoints are the other source of roots. The formats/log README describes the third line only as "base64
representation of the log root hash". C2SP tlog-checkpoint is normative: *"The third line is the root hash,
the base64 encoding of the root of the [RFC 6962] Merkle hash tree at the specified tree size."* RFC 6962
§2.1 fixes the hash algorithm as SHA-256, and C2SP tlog-tiles says of every Merkle operation: *"The hashing
algorithm is defined to be SHA-256."* A tlog-tiles checkpoint's root hash is therefore exactly 32 bytes.

## Decision

In `src/vendor/merkle/proof/verify.ts`:

- `rootFromInclusionProof` (and so `verifyInclusion`) rejects any proof element whose length is not
  `hasher.size()`: `proof[<i>] has unexpected size <n>, want <size>`.
- `verifyInclusion` rejects a `root` of the wrong length: `root has unexpected size <n>, want <size>`.
- `verifyConsistency` rejects a `root1`, a `root2` or a proof element of the wrong length
  (`root1 has unexpected size …`, `root2 …`, `proof[<i>] …`), on **every** path: the general case, and the
  `size1 == size2` and `size1 == 0` cases, where upstream never looks at the proof and, for `size1 == 0`,
  not at the roots either.

Each check runs **after all of upstream's own checks in its function**. So any input upstream rejects for
another reason is rejected with upstream's error text, and any input whose hashes all have the right length
behaves exactly as upstream (same result, same error text, same `RootMismatchError` contents).

In `src/vendor/formats/log/note.ts`, `parseCheckpoint` additionally rejects a checkpoint whose root hash is
not 32 bytes: `failed to unmarshal checkpoint: invalid checkpoint - root hash has unexpected size <n>, want
32`, after upstream's signature, unmarshal and origin checks, carrying the note as upstream's unmarshal errors
do. `Checkpoint.unmarshal` itself stays length-agnostic: it is formats/log's generic parser, upstream's own
tests (and its extension example) use 7- and 16-byte hashes, and the 32-byte rule belongs to the signed
tlog-checkpoint, which `parseCheckpoint` is the entry point for.

## Consequences

- Every in-domain input is unaffected. The merkle differential harness (Go generator, ~190k cases) reports
  zero mismatches for `verifyInclusion`, `rootFromInclusionProof` and `verifyConsistency` after the change;
  its cases all use correctly sized hashes.
- Two upstream tests had to be adapted, each with a port note:
  - `TestVerifyConsistency` uses the 12-byte roots `"don't care 1"`/`"don't care 2"` on the trivially
    consistent paths; the port hashes them to 32 bytes, and a separate test pins that the unhashed values
    are now rejected.
  - formats/log's `TestParseCheckpoint` signs a checkpoint whose hash is `[]byte("abcdef")`; the port pads it
    to 32 bytes. The test is about signature counting and every case keeps its verdict.
- Callers that passed an empty root for `size1 == 0` to `verifyConsistency` now fail; none in this repository
  do (every caller passes a checkpoint's root).
- A checkpoint with a non-32-byte root that Go's `ParseCheckpoint` accepts is rejected here. Such a checkpoint
  cannot be the root of a tlog-tiles log, so no conforming log produces one.
- Regression tests assert only the generic invariant ("a proof hash of the wrong length is rejected"), with
  mangled copies of upstream's own test vectors.

## Alternatives considered

- **Leave verification as upstream has it and rely on upstream fixing it.** Rejected: the port ships to users
  now, and the check is cheap and cannot change any correct result.
- **Check lengths first, before upstream's checks.** Rejected: it would change which error is reported for
  inputs upstream already rejects, for no security gain.
- **Reject non-32-byte roots in `Checkpoint.unmarshal`.** Rejected: it would break formats/log's generic
  `Checkpoint` (and upstream's tests of it) for a rule that belongs to the tlog-checkpoint profile.
- **Skip the root checks on the trivial `verifyConsistency` paths, as upstream skips the proof.** Rejected: a
  uniform rule ("every root is a node hash") is easier to state and audit, and a mis-sized root on the
  trivial path is still not a valid tree head.

## Review

- **Reviewer:** _pending_
- **Verdict:** _pending_
- **Notes:**
