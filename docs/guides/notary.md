# A notary

**Example:** [`examples/notary`](../../examples/notary)

A notary proves that a document existed, and that someone vouched for it, at a point in a log's
history. The document never leaves its owner: the submitter sends its SHA-256 digest and an Ed25519
signature over it, the notary checks the signature and appends a record of the two to its log, and
answers with a receipt that anyone can verify **offline**, with the document and the notary's vkey.

## The entry

Choose an encoding the verifier can rebuild exactly, since the receipt proves the entry's exact
bytes. Fixed-length fields need no parser that could disagree with another implementation's; the
example's record is 137 bytes:

```text
version (1) ‖ notarizedAt (8, ms, big-endian) ‖ sha256 (32) ‖ public key (32) ‖ signature (64)
```

The submitter signs a domain-separated statement (`webtessera-example-notary/v1\n` ‖ digest), so a
signature made for the notary cannot be passed off as one over anything else. The notary appends
only records whose signature verifies: a record is evidence against its key, and nobody else must
be able to make it.

## The receipt

`log.append(record)` from `webtessera/server` resolves to a verified receipt, a C2SP tlog-proof. The
example puts the record in the proof's `extra` line, so one `.tlog-proof` file carries everything a
verifier needs besides the document. The format does not authenticate extra data, so the verifier
proves it first:

```ts
const proof = parseReceipt(receiptText);
verifyReceipt(proof, { vkey: notaryVkey, data: proof.extraData });  // exactly these bytes are in the log
const record = decodeRecord(proof.extraData);                          // only now read its fields
// then: record.digest === sha256(document), and the signature verifies with record.publicKey
```

The safe API's receipts carry no extra data, so the example re-encodes the receipt with `TLogProof`
from `webtessera/formats/proof`. A verifier that keeps the record elsewhere can pass `data` (or the
leaf hash, `leafHash`) as usual.

## What fails, and how

The example's CLI (`scripts/verify.ts`) and tests show each failure with its reason: another
document (`document`), an altered record, proof, index or checkpoint (`receipt: inclusion`), a
receipt from a notary with another key (`receipt: signature`), and an unexpected signer (`signer`).

## Trust

The notary's key signs the log, so `NOTARY_VKEY` is all a verifier needs. The time is the notary's
claim; witnesses and monitors are what make a notary's history, and its timing, hard to dispute.
Because the log is public and append-only (the server serves the tlog-tiles read API next to
`/notarize`), a notary cannot quietly withdraw a notarization: a [monitor](monitor.md) would see the
rewritten history.
