# ADR-0225: Make receipts C2SP tlog-proofs, verified offline by composing the ported checks

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** DX guardrails contributor
- **Upstream reference:** C2SP `tlog-proof.md` @ C2SP/C2SP `625d8db` ("main", rendered at
  https://c2sp.org/tlog-proof on 2026-10-01; sha256 of the markdown
  `847b9026c740da56ec261b61dbf71fb4aeec35ea1136109364cbc38aa5febf42`); transparency-dev/formats `log/note.go`
  (`ParseCheckpoint`); tessera `witness.go` (`WitnessGroup.Satisfied`); transparency-dev/merkle `proof/verify.go`
  (`VerifyInclusion`)

## Context

The safe API's `append` must hand back something that proves, offline and to anyone, that the entry is in the
log: for a notary that stores a digest and a signature, for a browser that logs what a server did on the user's
behalf, for any receipt. The spec for exactly that exists: C2SP tlog-proof ("spicy signatures"), fetched on
2026-10-03 from both https://c2sp.org/tlog-proof and the C2SP repository; it is ported as
`webtessera/formats/proof` (ADR-0224). Its verification procedure is four steps:

> 1. Compute the leaf hash. This step is application specific.
> 2. Check that the checkpoint origin line is acceptable, and that the checkpoint is signed by a log public key
>    configured for that origin line.
> 3. Verify all cosignatures for witnesses known to the verifier. Which subsets of witnesses are considered strong
>    enough, is determined by application policy. …
> 4. Check that the inclusion proof is valid, to bind the leaf hash computed in step 1 to the the root hash of
>    the signed checkpoint.

Every step is already ported and tested against Go.

## Decision

`src/safe/receipt.ts`:

- **`Receipt`** is what a log hands back: `index`, the verified `checkpoint` (origin, size, root hash, and the
  signed note), the decoded `proof` (`TLogProof`), and `text`, its tlog-proof encoding (always valid UTF-8, since
  a checkpoint is a note), which the spec suggests storing as `.tlog-proof`.
- **`parseReceipt(text | bytes)`** decodes without verifying.
- **`verifyReceipt(receipt, { vkey, origin?, data | leafHash, witnesses? })`** is synchronous and needs nothing but
  its arguments. It performs the spec's steps by calling the ported code and nothing else:
  1. `DefaultHasher.hashLeaf(data)` (RFC 6962, as tlog-tiles logs hash entries), or a given 32-byte `leafHash`;
     exactly one must be given.
  2. and 3. `parseCheckpoint(checkpoint, origin, logVerifier, ...witnessVerifiers)` from `formats/log`: it opens
     the note with the log's key and every policy witness's cosignature/v1 key, so a signature by any of them
     that does not verify fails (step 3's "verify all cosignatures for witnesses known to the verifier"), checks
     the origin (defaulting to the key's name, which is every webtessera log's origin) and the 32-byte root.
     Then the policy's `satisfied(checkpoint)`, from Tessera's `WitnessGroup`.
  4. `verifyInclusion(DefaultHasher, index, size, leafHash, proof, root)` from `merkle/proof`.
- **Witness policies** come in two shapes: a ported `WitnessGroup` (from `newWitnessGroup` or
  `newWitnessGroupFromPolicy`, so a log's own policy file verifies its receipts), or the minimal
  `{ threshold, witnesses: vkey[] }`, built into a `WitnessGroup` of ported `Witness`es (given an empty URL,
  since checking cosignatures sends nothing anywhere). The witnesses' verifiers are collected by walking the
  group's components.
- **Failures are `ReceiptError`s** with a `reason` (`malformed`, `signature`, `witnesses`, `inclusion`), the
  ported error as `cause`, and a message that says what it usually means ("check that you are verifying with the
  log's own vkey", "…against the exact bytes that were logged").
- **What it returns** (`VerifiedReceipt`): the index, the checkpoint, the names of the policy witnesses whose
  cosignatures verified, and the extra data, documented with the spec's warning that it is not authenticated.
- **The log verifies its own receipts before returning them** (ADR-0226), so a receipt from `append` or `prove`
  has passed `verifyReceipt` once already.

## Consequences

- Receipts interoperate with any tlog-proof implementation, Go's included: `TLogProof.Unmarshal` in
  transparency-dev/formats v0.1.1 reads them.
- **The spec is unversioned.** It is an editor's copy whose only version is "main"; its header line
  (`c2sp.org/tlog-proof@v1`) is what gives receipts a version. If C2SP tags a version that changes the format,
  this ADR and ADR-0224 are superseded, and receipts already issued keep their `@v1` header.
- Timestamps in cosignatures are ignored after verification, as the spec's "Use of timestamps" says; an
  application that wants freshness constraints applies them to the returned checkpoint.
- An entry is the bytes the application chose to log. For a notary, that is an encoding of its digest and
  signature, which the verifier must reproduce exactly: the guide shows one, and `leafHash` serves verifiers that
  only hold the hash.

## Alternatives considered

- **A receipt format of our own,** modelled on C2SP conventions. Rejected: the spec exists, and was reachable.
- **Verify by hand** (open the note, compare the origin, run the inclusion check inline). Rejected: the ported
  functions are the reviewed, Go-equivalent implementations of each step; composing them is the only way not to
  re-implement verification.
- **Require a witness policy.** Rejected: a client-only log has no witnesses, and its receipts still prove
  inclusion against the device's key; a verifier that needs witnesses says so with `witnesses`.
- **Treat extra data as part of the receipt's meaning.** Rejected by the spec ("Applications MUST NOT implicitly
  trust the extra data").

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
