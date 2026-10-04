# A notary with offline-verifiable receipts

A service that accepts the SHA-256 digest of a document with the submitter's Ed25519 signature
over it, checks the signature, and appends a record of the two to a transparency log on SQLite.
It answers with a receipt, a [C2SP tlog-proof](https://c2sp.org/tlog-proof), that anyone can
check later **with no network**: given the document, the receipt and the notary's public key, a
small CLI says whether the notary logged that document, signed by whom, and when.

The document never leaves the submitter's machine; only its digest does. And because the record
is in a public, append-only log, the notary cannot quietly back-date, withdraw or rewrite a
notarization it has handed out: every receipt is a proof against a signed checkpoint, and the log
can be monitored ([`../monitor`](../monitor)).

## How it works

```text
 submitter                         notary (Node | Bun | Deno)                      anyone, later
 ─────────                         ──────────────────────────                      ─────────────
 sha256(document) ─┐
 sign(statement)  ─┴─ POST /notarize ─▶ verify Ed25519 signature (WebCrypto)
                     { sha256,          record = v1 ‖ time ‖ digest ‖ key ‖ sig  (137 bytes)
                       publicKey,       log.append(record)  → receipt (webtessera/server)
                       signature }      receipt + record in its extra data
        document.tlog-proof ◀───────────────┘
                                                                  verify.ts, offline:
                                                                   1. record is in the log  ✓
                                                                   2. digest = sha256(doc)  ✓
                                                                   3. signature by the key  ✓
```

## Run it

Build the library once at the repository root (`bun run build`), then:

```sh
node scripts/keygen.ts notary.localhost/v1 > .env    # NOTARY_SKEY (secret), NOTARY_VKEY (publish)

node --env-file=.env src/main.ts                     # Node.js 22.18+, on 127.0.0.1:8081
bun src/main.ts                                      # Bun
deno run --env-file --allow-net --allow-read --allow-write --allow-env src/main.ts   # Deno 2
```

Notarize a document, as a submitter (the key is generated into `submitter.key` on first use):

```console
$ echo "Lease agreement, signed 3 October 2026" > lease.txt
$ node scripts/notarize.ts http://127.0.0.1:8081/ lease.txt
notarized lease.txt; receipt saved to lease.txt.tlog-proof
signed by o0XDtFRrWhzzDUneXtfGhcSCWcbJEZwfetWhbHqYPhs=
```

The receipt is a tlog-proof whose `extra` line carries the record (see below):

```text
c2sp.org/tlog-proof@v1
extra AQAAAaED/umvzVNFoy3dQV50EBF/OgU0uVH3khrKBIHk0S6jjZAjniqjRcO0VGtaHPMNSd5e18aFxIJZxskRnB961aFsepg+G0/MSZZRxbug1P8SXKPvkp1vj9eGDRoNOQsk+jnkalJ+AE8Gik0ZDLq18LSz16gmZUnlgfuWfWmoU4Vtd1/aSA8=
index 0

notary.localhost/v1
1
fMNWfhyVvH8wOyJ8NNBuNWFEQJ0+HT+pZ0LM7vM1Yig=

— notary.localhost/v1 IGZQ4bQjzyS96NSUBNeCCbV1NZnJwVZTpnMBSp31caUPU84wenl0s+op5UWLSHrp76P3wmxyHOZcx7YGaSY0udcbkQY=
```

Verify it, offline, with the notary's public key (`NOTARY_VKEY` from `.env`):

```console
$ node scripts/verify.ts lease.txt.tlog-proof lease.txt "$NOTARY_VKEY"
OK: lease.txt is entry 0 of the notary's log, notarized at 2026-10-03T23:00:00.047Z
    signed by o0XDtFRrWhzzDUneXtfGhcSCWcbJEZwfetWhbHqYPhs=, proven against a checkpoint of 1 entries
```

### What failure looks like

Every way to forge or alter a receipt fails, and says which check caught it:

```console
$ echo "Lease agreement, signed 4 October 2026" > lease.txt          # another document
$ node scripts/verify.ts lease.txt.tlog-proof lease.txt "$NOTARY_VKEY"
FAIL (document): the document's SHA-256 is not the digest this receipt notarized

$ sed 's/^index 0$/index 1/' lease.txt.tlog-proof > altered.tlog-proof   # an altered receipt
$ node scripts/verify.ts altered.tlog-proof lease.txt "$NOTARY_VKEY"
FAIL (receipt): inclusion: receipt: the entry is not at index 1 of the log at size 1 (index is beyond size: 1 >= 1); check that you are verifying the receipt against the exact bytes that were logged

$ node scripts/verify.ts forged.tlog-proof lease.txt "$NOTARY_VKEY"   # from a notary with another key
FAIL (receipt): signature: receipt: the checkpoint is not a checkpoint of notary.localhost/v1 signed by notary.localhost/v1+206650e1 (failed to verify signatures on checkpoint: note has no verifiable signatures); check that you are verifying with the log's own vkey
```

Pass the submitter's public key as a fourth argument to also require that *they* notarized it
(`FAIL (signer): the document was notarized by o0XD…=, not …` otherwise). The exit code is 0 for
a receipt that holds and 1 otherwise. Editing the record in the `extra` line fails like the index
does: the record is the entry, and a changed entry is not the one in the log.

## The record

The receipt's `extra` line carries the 137-byte record
([`src/record.ts`](src/record.ts)): version, time, digest, public key, signature, all fixed-length,
so any implementation rebuilds the exact entry. The notary puts it there with
`log.append(record, { extraData: record })`. The tlog-proof format does not authenticate extra
data, and the verifier does not trust it: `verifyReceipt(receipt, { vkey, dataInExtra: true })`
first proves that *exactly these bytes* are an entry of the notary's log, and only then hands them
back for the verifier to read a field.

## Trust model

- **The notary's key** signs the log's checkpoints; `NOTARY_VKEY` is all a verifier needs. A receipt
  made with any other key fails, as does any change to the record, the proof or the checkpoint.
- **The submitter's key** is what makes a record theirs: the notary logs only signatures that
  verify, over a domain-separated statement (`webtessera-example-notary/v1\n` ‖ digest) that cannot
  be replayed as a signature over anything else.
- **The time** is the notary's claim, covered by the log's signature. A notary that lies about time
  is caught only by comparison with when its checkpoints were first seen, which is what witnesses
  and monitors record.
- **The notary cannot withdraw a notarization**: the receipt proves it against a signed checkpoint,
  and the log is append-only and publicly readable (the server serves the tlog-tiles API next to
  `/notarize`), so a monitor sees a log that rewrites its history.

## Test

```sh
npm run ci        # tsc --noEmit && vitest run
```

[`src/notary_test.ts`](src/notary_test.ts), on an in-memory `node:sqlite` database: a receipt that
verifies offline; a submission with someone else's signature refused, with nothing logged; malformed
submissions refused; and a receipt that fails for another document, an altered record, proof, index
or checkpoint, a forging notary, missing extra data, and an unexpected signer; plus the CLI's output
and exit codes. `scripts/smoke.ts` runs the real server on Node, Bun or Deno.

## Files to read first

1. [`src/notary.ts`](src/notary.ts): the `POST /notarize` handler.
2. [`src/verify_notarization.ts`](src/verify_notarization.ts): offline verification, in order.
3. [`src/record.ts`](src/record.ts) and [`src/submission.ts`](src/submission.ts): the entry and the request.
4. [`scripts/verify.ts`](scripts/verify.ts): the CLI.
