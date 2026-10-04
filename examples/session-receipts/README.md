# Session receipts: a record neither side can rewrite

The browser records every exchange it has with your server in a transparency log of its own, kept
on the device and signed by a key no script can export. The server is that log's **witness**: it
cosigns each checkpoint, after checking that it extends the last one it cosigned, so the browser
cannot rewrite or wipe the record unseen. The server is also its **committer**: it copies the log,
as witnessed and verified, to S3-compatible storage (AWS S3, Cloudflare R2, MinIO, …), or to its
own database when no bucket is configured.

The result is an auditable record of everything the server did in the user's space, signed by the
user's device and cosigned by the server, which an auditor can check from the bucket with two
public keys, and which **neither side can rewrite alone**.

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser (client/)
    participant S as Server (server/)
    participant K as Bucket (S3, R2, MinIO, or the server's DB)
    B->>S: POST /session {origin, vkey}  (device key from openDeviceKey)
    S-->>B: token, witness vkey (pinned by the browser)
    B->>S: PUT /api/notes/todo  (the application under audit)
    S-->>B: 200 "saved"
    Note over B: append {method, path, status, sha256(bodies)} to its IndexedDB log
    B->>S: POST /witness/add-checkpoint {old size, consistency proof, checkpoint}
    Note over S: proof checks out: the new tree contains the one it cosigned last
    S-->>B: cosignature
    Note over B: checkpoint published; receipt = device signature + server cosignature
    B->>S: PUT /sessions/<hash>/tile/…, then …/checkpoint  (webtessera/mirror)
    S->>K: verified mirror of the log, as of the checkpoint the server cosigned
    S-->>B: committed N
```

Anyone holding the session log's vkey and the server's witness vkey can then audit the bucket
(`scripts/audit.ts`): both signatures on the checkpoint, every tile and entry bundle re-derived
(`webtessera/fsck`), and the interactions listed.

## Run it

Build the library once at the repository root (`bun run build`). Then, in this
directory, generate the witness's key and start the server on any of the three runtimes:

```sh
node scripts/keygen.ts witness.localhost > .env       # WITNESS_SKEY, the one secret; prints the vkey

node --env-file=.env server/main.ts                   # Node.js 22.18+ (node:sqlite)
bun server/main.ts                                    # Bun (bun:sqlite; reads .env itself)
deno run --env-file --allow-net --allow-read --allow-write --allow-env server/main.ts   # Deno 2
```

`WITNESS_SKEY` is the server's only key setting: the witness's public key, which browsers pin and
auditors check with, is derived from it with `cosignerVkey` from `webtessera/witness`, and printed
when the server starts. The server listens on `127.0.0.1:8787` (`PORT`, `HOST`) and keeps its state in
`session-receipts.db` (`SERVER_DB`). It commits to a bucket when `S3_ENDPOINT`, `S3_BUCKET`,
`S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are all set (`S3_PREFIX` defaults to
`session-receipts/`), and to its own database otherwise. For MinIO:

```sh
S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=receipts S3_REGION=us-east-1 \
S3_ACCESS_KEY_ID=minioadmin S3_SECRET_ACCESS_KEY=minioadmin node --env-file=.env server/main.ts
```

Then serve the page, which proxies the server's routes so that both share one origin:

```sh
bun x vite        # or: npx vite — then open http://localhost:5173
```

Save, load and delete notes. Each exchange appears with its receipt's verdict ("✓ in a tree of 2,
cosigned by witness.localhost"), and the page uploads the log after each one ("The server has
committed the first 2 interactions to its bucket"). Reload: the session, its key and its log are
still there, and every receipt is proven again. Then audit the session as a third party, with the
log origin and key the page shows (and the witness vkey the server printed as a third argument, or,
beside the server, the one `WITNESS_SKEY` derives):

```console
$ node --env-file=.env scripts/audit.ts localhost:5173/session/8fa812b9… "localhost:5173/session/8fa812b9…+f0fb3c5b+AWYj…"
OK: 2 interactions in the server's own database (set the S3_* variables to use a bucket), signed by the session's device key and cosigned by the server:
  0  2026-10-03T22:51:46.401Z  PUT /api/notes/todo -> 200
  1  2026-10-03T22:51:47.734Z  GET /api/notes/todo -> 200
```

## Trust model

Two keys sign the record, and each side holds one:

| | holds | can | cannot |
| --- | --- | --- | --- |
| **Browser** | the device key, non-extractable, in IndexedDB | add records; sign any history it likes | get a rewritten, truncated or wiped history cosigned: the witness only cosigns a tree that contains the last one it cosigned, and the bucket holds what it committed |
| **Server** | the witness key (`WITNESS_SKEY`) | refuse to cosign (the browser then cannot publish, and knows it); see every record when it commits | forge or alter a record: checkpoints need the device's signature, which it cannot produce |
| **Auditor** | the two public keys | verify the bucket's copy entry by entry, offline | be fooled by a copy that either side altered: the checkpoint needs both signatures, and fsck re-derives the tree |

What the record does and does not say:

- **It records what the browser saw.** Each entry is the browser's account of one exchange: method,
  path, status, and the SHA-256 of both bodies (bodies stay private; whoever holds one can prove it
  is the one recorded). The server's cosignature attests to the *history*, that it is append-only
  and the one it witnessed, not to the truth of each entry. The server sees every entry when it
  commits, so it can object to a false one at once; to bind its own answers too, have it sign them
  (in a header the browser logs) or keep a log of its own.
- **A session is one log.** A browser can always abandon a session and start another, but the
  abandoned one stays committed, cosigned up to its last checkpoint.
- **Pin the witness key.** The page takes the witness key from the registration answer and keeps it
  for the session. A real deployment ships it in the page, so that a compromised server cannot hand
  out a different one.
- **Registration is first come, first served** per origin, and the origin is random, so nobody can
  claim another browser's log or replace its key. The session token authenticates uploads and the
  application; the checkpoints authenticate themselves.
- **Uploads are untrusted.** The server stages them and commits nothing it cannot verify against the
  checkpoint it cosigned itself, which must also extend what it committed before.

## Going further

What a production deployment adds, deliberately left out to keep the example small:

- **Pin the witness key in the page bundle** instead of taking it from the registration answer.
- **Bind the server's answers too**, by having the server sign each response (a header the browser
  logs with the interaction), or keep a log of its own, so that the record holds both accounts.
- **Cache `lookupLog`**: the witness asks the registry on every request; a small in-memory cache of
  recent answers takes that load off the database.
- **Prune staged uploads** once committed, reading tiles a later commit needs from the committed copy.
- **Serve the bucket**: a committed session is a static tlog-tiles log, which any CDN or public
  bucket can serve for auditors to verify with `webtessera/client`, or Tessera's Go client.

## Test

```sh
npm run ci     # tsc --noEmit, the Node suite, the Chromium suite, and a production build of the page
```

- [`test/session_test.ts`](test/session_test.ts), on Node, with the server in-process and the
  browser's own session code (an in-memory log stands in for IndexedDB): receipts cosigned by the
  server; a **wiped and restarted browser log refused** by the witness; a **rewritten history**
  (same key, different entries) refused with 422 and kept as evidence; commits that match what was
  witnessed and pass an audit; a **tampered upload committed nowhere**; a bucket copy **altered or
  re-signed by the server caught by the auditor**; and requests without the session's token refused.
- [`test/session_browser_test.ts`](test/session_browser_test.ts), in headless Chromium against the
  real server: device key and log in IndexedDB, the page's own `fetch`, and a resumed session.
- [`test/s3_test.ts`](test/s3_test.ts) commits to a real bucket and audits it there, when the `S3_*`
  variables are set (skipped otherwise; the same names as the library's own S3 tests).
- `scripts/smoke.ts` starts the real server on Node, Bun or Deno and drives it over HTTP.

## Files to read first

1. [`client/src/session.ts`](client/src/session.ts) and [`client/src/recorder.ts`](client/src/recorder.ts):
   the browser's log, witnessed by the server, and how each exchange is recorded.
2. [`server/witness.ts`](server/witness.ts): the server as witness.
3. [`server/committer.ts`](server/committer.ts) and [`client/src/push.ts`](client/src/push.ts): the
   upload, and the verified commit to the bucket.
4. [`audit/audit.ts`](audit/audit.ts): what an auditor checks.
5. [`server/app.ts`](server/app.ts) and [`server/sink.ts`](server/sink.ts): how it fits together, and
   where it commits.
