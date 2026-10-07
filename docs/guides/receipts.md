# Receipts

`append` and `prove` return a receipt: everything a verifier needs to check, offline, that an entry is in the
log. This guide covers its format, how to verify one, and the data it can carry. It follows
[the safe API](safe-api.md).

## The format

A receipt is a [C2SP tlog-proof](https://c2sp.org/tlog-proof) ([ADR-0225](../decisions/0225-receipts-are-tlog-proofs.md)):
the entry's index, its inclusion proof, and the log's signed checkpoint with any witness cosignatures. Store
`receipt.text` as is, conventionally in a `.tlog-proof` file:

```text
c2sp.org/tlog-proof@v1
index 0
rqPLszb01JTYtaFXrt/EgKRabefAlo4IVDOyFPm0Hvc=

example.com/log
2
JCMzOarc7fKH0mJBPwPAKOuNs5ft0yooeAkRUbmb8g8=

— example.com/log Jb1BsEv3/w9bI0H3Gl/pRDxTUJhhRdecWoVgxutGU/6cc46BXi6x0pcO78xtvdZoyfNtc3d3Dpx6I3c/L0c1DvqWQAo=
```

`verifyReceipt(receipt, options)` checks one offline, with nothing but its arguments, following the spec's
verification steps on the ported code: the RFC 6962 leaf hash of `data` (or a given `leafHash`); the log's
signature and origin; every cosignature by a policy witness, and the policy; and the inclusion proof.

```ts
const { index, checkpoint, cosignedBy } = verifyReceipt(text, {
  vkey: logVkey,                                    // the log's published vkey
  data: entry,                                      // the exact bytes that were logged
  witnesses: { threshold: 1, witnesses: [witnessVkey] }, // optional
});
```

`witnesses` may also be a `WitnessGroup` from `newWitnessGroupFromPolicy` (package `webtessera`), so a log's own
witness policy file verifies its receipts. A failure is a `ReceiptError` (a `WebtesseraError` with the code `INVALID_RECEIPT`) whose `reason` is
`malformed`, `signature`, `witnesses`, `inclusion` or `extra`, with a message that says what it usually means.
The options must name the entry (`data`, `leafHash` or `dataInExtra: true`); TypeScript refuses a call
without one.

## Extra data

A tlog-proof may carry application data on its `extra` line: `append(data, { extraData })` (or
`prove(index, { extraData })`) puts it there, up to `MaxExtraDataBytes`. The spec is explicit that "Applications
MUST NOT implicitly trust the extra data, as it is not authenticated", so `verifyReceipt` returns it as
`extraData`, unchecked, unless you ask for more. The common case is a receipt that carries its own entry, so that
one file holds everything a verifier needs:

```ts
const receipt = await log.append(entry, { extraData: entry });
// later, anywhere, with nothing but the receipt and the vkey:
const { data } = verifyReceipt(receipt.text, { vkey: logVkey, dataInExtra: true });
```

`dataInExtra: true` takes the entry from the extra line and returns it as `data` only once the inclusion proof
has bound it to the signed checkpoint: this is the extra line as the spec's "additional data necessary to
reconstruct the record hash". With `data` or `leafHash` as well, it also checks that the extra line holds that
entry. A missing or different extra line fails with reason `extra`; altered extra data fails with `inclusion`.

## JSON

`JSON.stringify(receipt)` is `{ "index": "7", "text": "…" }`, the index a decimal string since JSON has no
64-bit integers; checkpoints serialise with a decimal `size` and a base64 `hash`. `receipt.text` is the wire
format, and `verifyReceipt`, `parseReceipt` and `log.verify` take the JSON form back
([ADR-0246](../decisions/0246-log-fetch-appendmany-json-and-async-dispose.md)).
