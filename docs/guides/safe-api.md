# The safe API: `webtessera/server` and `webtessera/browser`

webtessera is a faithful port of Tessera: its API is Go's, translated. That makes it reviewable against the
original, and powerful, but easy to misuse. The safe API is a small layer on top of it that makes the common
mistakes impossible. It has no upstream counterpart, lives in its own entry points, and never changes how the
ported API behaves ([ADR-0220](../decisions/0220-safe-api-entry-points.md)).

This guide covers the environment model, key custody, the log object, receipts, four complete use cases, and when
to drop down to the ported API.

## The environment model

Code that uses the safe API declares where it runs by what it imports:

| Import | Runs in | Can it hold a log's private key? |
| --- | --- | --- |
| `webtessera/server` | your server's private environment: Node.js 22+, Deno, Bun, Cloudflare Workers, Vercel Edge and other edge runtimes | yes: imported from your secret store, held by WebCrypto |
| `webtessera/browser` | the browser's public environment: windows, workers, service workers | only a device key generated in that browser, which cannot be exported |

Everything a page holds can be read by whoever loads it, so `webtessera/server` refuses to end up there, twice
([ADR-0221](../decisions/0221-guard-the-server-entry-point.md)):

- **At build time.** Under the `browser` (or `react-native`) export condition, which Vite, webpack, esbuild,
  Rollup, Parcel and Bun apply to browser builds, `webtessera/server` resolves to a module that exports nothing
  and throws "webtessera/server holds signing keys and must not be bundled for the browser; use
  webtessera/browser". A named import from it fails the build. Server toolchains resolve the real module,
  including the edge ones that also apply `browser`: wrangler (`workerd`) and Vercel (`edge-light`).
- **At run time.** If the real module is loaded in a browser window or worker anyway, it throws at import, and
  each function that takes a key checks again.

`webtessera/browser` holds no secrets and is safe to import anywhere, including on a server that only verifies
receipts.

A few toolchains need to know about this: test runners that resolve with the `browser` condition for DOM
environments, as Jest's jsdom environment does, give server code the guard (test it in a Node environment); a
server runtime whose bundler applies only `browser` must add `workerd` or another server condition to its
resolver; and a desktop app (Electron) ships its code to users, so its "server" is not private either, whatever
the detector says.

## Key custody

A log is identified by its key: every checkpoint is signed with it, and every client verifies with its public
half, the **vkey** (`example.com/log+1a2b3c4d+AQ…`). The safe API holds keys as `LogKey`s
([ADR-0222](../decisions/0222-key-custody.md)):

- **Non-extractable WebCrypto keys where the runtime supports Ed25519**: Node.js 22+, Deno, Bun, workerd, Chrome
  and Edge 137+, Firefox 129+, Safari 17+ (browsers only on HTTPS or `localhost`). Such a key can sign, but no
  code, this library included, can export it. `webCryptoEd25519()` says whether the runtime qualifies; it checks
  that WebCrypto signs RFC 8032's test vector exactly, since a WebCrypto signature must be byte-for-byte the one
  Go would make (it is: the Go fixtures are replayed through WebCrypto keys in every test runtime).
- **Elsewhere, @noble/curves**, reported on the key as `backend: "noble"`, `extractable: true`. Pass
  `fallback: "error"` to refuse instead.
- **Never shown**: a `LogKey`'s properties, `toString()`, `JSON.stringify` and Node's `inspect` show only the
  origin, vkey and custody, and no error message contains key material.

```ts
const key = await generateLogKey("example.com/log"); // an ephemeral key, for tests and demos
`${key}`; // "LogKey(example.com/log+1a2b3c4d+AQ…, webcrypto, non-extractable)"
```

**On a server**, generate the key once, offline, and keep the private key string in your secret store:

```ts
import { generateKey } from "webtessera/note";
const { skey, vkey } = generateKey(undefined, "example.com/log"); // store skey as a secret; publish vkey
```

At run time, `importLogKey(env.LOG_SKEY)` validates it exactly as Go's `note.NewSigner` does and imports it into a
non-extractable WebCrypto key, wiping the bytes it decoded. The string itself is immutable, so keep it out of
logs and source code; that, and the copy your environment holds, is beyond what any library can protect.

**In a browser**, a key is never a string. `openDeviceKey(origin)` generates a non-extractable key on first use and
keeps it in IndexedDB as the CryptoKey itself; every tab and worker of the page's origin gets the same key, after
reloads too ([ADR-0227](../decisions/0227-device-keys-in-indexeddb.md)). An application that manages keys itself
passes an Ed25519 `CryptoKeyPair` to `fromCryptoKey`. Two things to know:

- A non-extractable key cannot be stolen, but a script injected into the page can use it while the page is open.
  Content Security Policy is still your first defence.
- Clearing site data deletes the key, and browsers may evict storage under pressure. A log that matters should
  ask for persistent storage with `navigator.storage.persist()`.

A log keeps one key for its whole life: both factories refuse to open storage whose published checkpoint another
key signed. Key rotation is supported by the ported API (`withCheckpointSigner(primary, ...additional)`), not by
the safe API.

## The log object

`openServerLog` and `openBrowserLog` return a `TransparencyLog`
([ADR-0226](../decisions/0226-the-high-level-log.md)):

| Member | What it does |
| --- | --- |
| `append(data, { signal?, timeoutMs?, extraData? })` | adds one entry (up to 65535 bytes) and resolves, once a published checkpoint commits to it, to a verified `Receipt`, carrying `extraData` in its `extra` line if given |
| `prove(index, { extraData? })` | a receipt for an existing entry, relative to the latest checkpoint |
| `entries(from?, to?)` | the log's entries, in order, as `{ index, data }`: an async iterator up to `to` or the latest checkpoint's size |
| `entry(index)` | one entry, as `entries` reads it |
| `latestCheckpoint()` | the latest published checkpoint, verified |
| `verify(receipt, data)` | checks a receipt against this log's key and witness policy |
| `close()` | waits for every appended entry to be published, then stops |
| `origin`, `vkey`, `verifier` | the log's identity |
| `reader`, `appender` | the ported `LogReader` and `Appender`, the way down to the rest of the API |

The defaults are chosen so that the obvious call is the safe one:

| Default | Why |
| --- | --- |
| Storage is required on a server; memory must be asked for as `{ memory: true }` | a log in memory loses its tree on restart while its checkpoints live on in clients |
| SQLite locking is the adapter's, which fails closed: lease locking for every database another process could reach, local only for one that is private (in memory, a Durable Object) | two processes appending to one database under local locks fork the log |
| A browser log is kept in IndexedDB (`webtessera-log:<origin>`) with Web Locks, and needs a persistent key; without Web Locks it refuses to open, naming `storage: { indexedDB, singleWriter: true }` | a log that outlives the page with a key that does not cannot be signed again, and two tabs without locks fork it |
| A checkpoint is published every second while the log grows (`checkpointIntervalMs`) | `append` waits for one, so the interval is its latency |
| `append` gives up after 30 s (`publishTimeoutMs`), saying whether and where the entry was sequenced | a receipt that cannot arrive should fail loudly |
| Witnesses fail closed, and an open they refuse says why: unreachable, or storage that holds less than they cosigned | a receipt promises the cosignatures its policy asks for |
| Every receipt is verified before it is returned | damaged storage is caught before a client sees it |

`appendOptions: (opts) => opts.withAntispam(…)` tunes the ported `AppendOptions`; the log's key and witnesses are
installed after it.

### On a server

```ts
import { DatabaseSync } from "node:sqlite";
import { combineHandlers, toNodeListener } from "webtessera/http";
import { importLogKey, openServerLog } from "webtessera/server";
import { fromSqliteSync } from "webtessera/storage/sqlite";
import { createServer } from "node:http";

const log = await openServerLog({
  key: await importLogKey(process.env.LOG_SKEY ?? ""),
  storage: { sqlite: fromSqliteSync(new DatabaseSync("log.db")) },
  http: { cors: true },
});
createServer(toNodeListener(combineHandlers(log.handler))).listen(8080);
```

`storage` is `{ sqlite, namespace?, locking?, lease? }` with any adapter from `webtessera/storage/sqlite`
(`fromSqliteSync`, `fromLibsql`, `fromRqlite`, `fromD1`, `fromDurableObjectStorage`, `fromSqliteWasm`),
`{ objectStore }` for a durable store of your own, or `{ memory: true }`. `locking` overrides the adapter's
default, which is `"lease"` for a file and every networked engine, `"local"` for an in-memory database or a
Durable Object ([choosing storage](choosing-storage.md#sqlite)). `log.handler` serves the tlog-tiles read
API; on Deno it is `Deno.serve(combineHandlers(log.handler))`, on Workers `export default { fetch: … }`.

### In a browser

```ts
import { openBrowserLog, openDeviceKey } from "webtessera/browser";

const log = await openBrowserLog({ key: await openDeviceKey("device.example/7f3a") });
```

## Receipts

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
witness policy file verifies its receipts. A failure is a `ReceiptError` whose `reason` is `malformed`,
`signature`, `witnesses`, `inclusion` or `extra`, with a message that says what it usually means.

### Extra data

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

## Use cases

### 1. A client-only log

A browser keeps its own tamper-evident log, signed by a key that cannot leave the device, and reads it back:

```ts
const log = await openBrowserLog({ key: await openDeviceKey("device.example/7f3a") });
const receipt = await log.append(new TextEncoder().encode("opened the record"));
for await (const { index, data } of log.entries()) { … }
```

`entries` reads the log at the size of its latest checkpoint, a few entry bundles at a time, and checks each
entry against the leaf hash the log's tiles hold for it, so damaged storage fails rather than yield an entry no
receipt could prove; `prove(index)` gives the receipt that proves one to others.

Without witnesses, the device can still rewrite its own history and sign the new one; what it cannot do is
convince anyone who holds an older receipt or checkpoint, since the two would be inconsistent. Witnessing makes
that visible to others, as below.

### 2. Session receipts

The browser logs every interaction with your server in its own log, and your server, as its witness, cosigns
each checkpoint before the browser publishes it. The cosigned receipts are then a record, checkable by the user
and by you, of everything the server did in the user's space.

On the server, run `webtessera/witness` and register each browser log's vkey when its session starts:

```ts
import { cosignerVkey, newSignerForCosignatureV1, newWitnessServer } from "webtessera/witness";

const witness = newWitnessServer({
  signer: newSignerForCosignatureV1(env.WITNESS_SKEY),
  store,                                  // any ObjectStore: SQLite, D1, a Durable Object...
  lookupLog: (origin) => sessions.vkeyFor(origin), // { verifierKeys: [vkey] } or undefined
  prefix: "/witness",
  cors: true,                             // the browser posts cross-origin
});
const serverWitnessVkey = cosignerVkey(env.WITNESS_SKEY); // publish it: browsers and verifiers pin it
```

The witness's signer key is its only secret and its only key setting: `cosignerVkey` derives the vkey it
publishes, in the cosignature/v1 form that witness policies name.

In the browser, configure the log with that witness:

```ts
import { newWitness, newWitnessGroup } from "webtessera";

const log = await openBrowserLog({
  key,
  witnesses: newWitnessGroup(1, newWitness(serverWitnessVkey, new URL("https://api.example/witness/"))),
});
```

Receipts then carry the server's cosignature, and verify with
`{ witnesses: { threshold: 1, witnesses: [serverWitnessVkey] } }`. A browser log whose storage was wiped, while
its device key survived, cannot open again: the witness has cosigned more than the storage holds, and
`openBrowserLog` says exactly that. To keep an independent copy of a log, mirror it
with `webtessera/mirror` to S3 or R2: `newVerifiedMirror({ source, origin, verifier, target: newS3Sink({ … }) })`,
where `source` is the log's URL or a `log.reader`. Mirrors copy only what verifies.

### 3. A notary

A server stores a SHA-256 digest and the submitter's signature, and hands back a receipt. Choose an entry encoding
the verifier can reproduce exactly; fixed-length fields are the simplest:

```ts
const entry = new Uint8Array([...digest /* 32 bytes */, ...signature /* 64 bytes */]);
const receipt = await log.append(entry, { extraData: entry });
// later, anywhere: verifyReceipt(receipt.text, { vkey: notaryVkey, dataInExtra: true }).data is the entry
```

A verifier that holds the entry passes `data` instead, and one that holds only the leaf hash passes `leafHash`.

### 4. A log server

`openServerLog` on any SQLite with `log.handler` serves the read API. Writing is the personality's business; the
conventional `POST /add` is a few lines with `readEntryBody`, `addResponse` and `addErrorResponse` from
`webtessera/http`, or return `receipt.text` to give writers their receipts.

## When to drop down to the ported API

The safe API is deliberately small. Use the ported API, which it is built on, for:

- **Key rotation** and multiple checkpoint signers (`AppendOptions.withCheckpointSigner` or
  `withCheckpointAsyncSigner(primary, ...additional)`; the latter takes `LogKey`s, keeping their custody).
- **Static CT logs** (`newCertificateTransparencyAppender`, `webtessera/ctonly`), **migration**
  (`newMigrationTarget`) and custom entry layouts.
- **Reading and verifying remote logs** over HTTP (`webtessera/client`), whole-log audits (`webtessera/fsck`),
  mirroring (`webtessera/mirror`) and witnessing (`webtessera/witness`): pass them `log.reader` and `log.verifier`.
- **Index-only appends** without waiting for publication: `log.appender.add(newEntry(data))()`.

Everything the safe API does is a composition of those functions, named at the top of each module in `src/safe/`,
so dropping down never means relearning the log.
