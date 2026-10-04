# ADR-0225: Make receipts C2SP tlog-proofs, verified offline by composing the ported checks

- **Status:** accepted
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

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Spec: fetched https://c2sp.org/tlog-proof (rendered "main (2026-10-01)", "versions: main" only) and the main-branch markdown, whose SHA-256 is 847b9026c740da56ec261b61dbf71fb4aeec35ea1136109364cbc38aa5febf42, the value the ADR records, so the text is unchanged. The four verification steps are quoted verbatim, including the spec's own "the the". The `.tlog-proof` SHOULD, the "MUST NOT implicitly trust the extra data" warning and the use of timestamps paragraph are as the ADR describes. The "unversioned" Consequence is accurate.
  - Read `src/safe/receipt.ts` against the Decision and the four steps. Step 1: `hashLeaf` of the data or a 32-byte `leafHash`, exactly one. Steps 2 and 3: `parseCheckpoint(checkpoint, origin, logVerifier, ...witnessVerifiers)`, which throws "no log signature found on note" when the log's signature is absent and fails on any known cosignature that does not verify, then `policy.satisfied(...)`. Step 4: `verifyInclusion(DefaultHasher, ...)`. `cosignedBy`, the `WitnessPolicy` shape (witnesses built with an empty URL), the `ReceiptError` reasons and the self-verification before a log returns a receipt are as described (ADR-0226 `#receipt`).
  - `receipt_test.ts` has one group per step with a passing receipt and the failing ones (wrong key with the same name, other origin, altered text, forged cosignature by a policy witness, wrong data, wrong index, tampered proof), and runs in the unit suite (3439 pass).
  - Interop claim: proofs marshalled by the port (the extra-data sizes of the Update, the max-uint64 index vector) are read by Go's `TLogProof.Unmarshal` v0.1.1, and Go's `Marshal` and the port's `marshal` agree byte for byte on all 13,362 proofs of my 36,000-proof run that both accept.

## Update (2026-10-04): extra data a verifier can rely on

The notary example had to rebuild each receipt with `TLogProof` to put its record on the `extra` line, and
its verifier had to parse the proof, take `extraData` and pass it back as `data`. Both are now the API:

- **Writing.** `append(data, { extraData })` and `prove(index, { extraData })` (ADR-0226's update) put
  `extraData` on the receipt's `extra` line. It is at most `MaxExtraDataBytes` (49,146) bytes: the most
  that, as `extra ` and base64, makes a line shorter than the 64 KiB `bufio.Scanner` limit under which this
  port's `TLogProof.unmarshal` and transparency-dev/formats' `Unmarshal` read a proof, so every receipt the
  log hands out can be read back. More is refused before the entry is appended.
- **Verifying.** `VerifyReceiptOptions.dataInExtra: true` says the extra line carries the entry. Alone, it
  takes the entry from the extra line; with `data` or `leafHash`, it checks that the extra line holds that
  entry (exactly one of the two may be given). Either way the leaf hash is the extra data's, so step 4 binds
  the extra data to the signed checkpoint, and `VerifiedReceipt.data` returns it; `data` is undefined
  without `dataInExtra`, and `extraData` is still returned unauthenticated. A TypeScript overload types
  `data` as present when `dataInExtra: true` is passed.

This follows the spec rather than relaxing it. "Applications MUST NOT implicitly trust the extra data" is
kept: trust is explicit (the verifier opts in) and earned (the inclusion proof checks the bytes, as for any
`data`); and the spec names this use: "additional data necessary to reconstruct the record hash", with the
verifier computing the leaf hash in step 1 "based on application-specific data provided out-of-band, and the
`extra` line". The spec text is unchanged since this ADR was written (same sha256).

**A fifth `ReceiptError` reason, `extra`**: the extra line is missing, or does not hold the entry or leaf
hash it was checked against. It is the one reason that is not a step of the spec's procedure; the others
keep their meaning (extra data altered in transit fails `inclusion`, as an altered entry does). Not added: a
check of the extra line against expected bytes that are *not* the entry. Such a check verifies nothing,
since anyone can rewrite an unauthenticated line, and an option for it would read as a guarantee;
applications that use the line for context compare `extraData` themselves.

Tests: `receipt_test.ts` (taking the entry from the extra line, as text, bytes and `TLogProof`; checking it
against `data` and `leafHash`; a missing extra line, another entry's, one bit changed, a forged checkpoint,
and invalid options); `server_test.ts` (receipts from `append` and `prove` with extra data, the encoding of
empty extra data, the largest extra data read back, and the refusals).

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. `MaxExtraDataBytes` is `floor((65536 - 1 - 6) / 4) * 3` = 49,146, and that is exactly the limit of Go v0.1.1's reader: with the port's `marshal`, extra data of 49,145 and 49,146 bytes is read by Go's `Unmarshal` and by the port, 49,147 to 49,150 bytes fail in both. `dataInExtra` behaves as written (entry from the extra line alone; checked against `data` or `leafHash`, at most one; the leaf hash is the extra data's, so step 4 binds it; `data` is undefined without it; `extra` as a fifth reason; the TypeScript overload). The spec sentence the update quotes ("additional data necessary to reconstruct the record hash" and the extra line as input to step 1) is in the current text. Tests named in the update exist in `receipt_test.ts` and `server_test.ts` and pass.
