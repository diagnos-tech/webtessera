# Session receipts

**Example:** [`examples/session-receipts`](../../examples/session-receipts)

The browser records every exchange with your server in its own log ([a client-only
log](client-only-log.md)), and your server acts as that log's **witness** and **committer**. The
record is then signed by the user's device and cosigned by your server, and neither can rewrite it
alone: an auditable record of everything the server did in the user's space.

## The three moving parts

**1. The browser's log, witnessed by the server.** The browser registers its log's vkey when the
session starts, and opens the log with the server as a witness that must cosign every checkpoint
before it is published (witnesses fail closed):

```ts
const log = await openBrowserLog({
  key: await openDeviceKey(origin),
  witnesses: newWitnessGroup(1, newWitness(serverWitnessVkey, new URL("/witness/", server))),
});
```

**2. The server as witness.** `newWitnessServer` from `webtessera/witness` cosigns a checkpoint only
when its consistency proof shows that it contains the last checkpoint cosigned for that log. Sessions
come and go, so it looks each log's key up in your session registry:

```ts
const witness = newWitnessServer({
  signer: newSignerForCosignatureV1(env.WITNESS_SKEY),
  store,                                       // any ObjectStore; its lock makes each check atomic
  lookupLog: async (origin) => {
    const session = await sessions.byOrigin(origin);   // registered when the session started
    return session === undefined ? undefined : { verifierKeys: [session.vkey] };
  },
  prefix: "/witness/",
});
const serverWitnessVkey = cosignerVkey(env.WITNESS_SKEY);  // what browsers pin: derived, not configured
```

The witness's key is the server's only key setting: `cosignerVkey` derives the vkey it publishes (the
cosignature/v1 form that witness policies name), which the example hands each browser when its session
registers.

A browser that wipes its log, or rewrites an entry it already got cosigned, can never be cosigned
again: the example's tests show both, one refused as the log opens ("this storage holds an older or
different log than its witnesses cosigned: the witness … has cosigned this log at size 2, and the
storage holds no entries"), the other with 422 and kept as evidence (`onInconsistency`).

**3. The server as committer.** The browser uploads its log's tiles and bundles with
`webtessera/mirror`'s `Mirror` (reading through `log.reader`) into a sink whose writes are HTTP
`PUT`s. The server then copies the log into S3-compatible storage with `newVerifiedMirror`, *as of
the checkpoint its own witness cosigned*, verifying every uploaded resource first:

```ts
const staged = newSinkTarget(stagingStore, { prefix: `staging/${hash}/` });   // the browser's uploads
await newVerifiedMirror({
  source: {
    readCheckpoint: async () => witnessed,         // await witness.latestCheckpoint(origin)
    readTile: (l, i, p, s) => staged.readTile(l, i, p, s),
    readEntryBundle: (i, p, s) => staged.readEntryBundle(i, p, s),
  },
  target: newSinkTarget(newS3Sink({ endpoint, bucket, region, accessKeyId, secretAccessKey }), { prefix }),
  origin,
  verifier: newVerifier(sessionVkey),
}).run();
```

Without S3 settings, any ObjectStore is a sink too (the example falls back to a namespace of the
server's SQLite database). An auditor checks the bucket with the two public keys: both signatures on
the checkpoint, and every tile and bundle re-derived with `webtessera/fsck`.

## The trust model, in one table

| | can | cannot |
| --- | --- | --- |
| Browser (device key) | add records; sign any history | get a rewritten or wiped history cosigned |
| Server (witness key) | refuse to cosign; read every record when it commits | forge or alter a record: it lacks the device key |
| Auditor (both vkeys) | verify the bucket entry by entry, offline | be fooled by a copy either side altered |

The record is the browser's account of each exchange (the example logs method, path, status and the
SHA-256 of both bodies); the cosignature attests to the history, not to the truth of each entry. The
server sees each entry when it commits, so it can object at once; to bind its own answers too, have
it sign them. Pin the witness key in your page, rather than taking it from the server at run time.
The example's README goes through each point.
