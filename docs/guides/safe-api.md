# The safe API: `webtessera/server` and `webtessera/browser`

Read this guide before you open your first log: it covers the safe API's environment model, key custody, the log
object and its errors, and when to drop down to the ported API. [Receipts](receipts.md) covers what `append`
returns and how anyone verifies it.

webtessera's ported API is Go's, translated, which makes it reviewable against the original but easy to
misuse. The safe API is a small layer on top of it that makes the common mistakes impossible. It has no
upstream counterpart, lives in its own entry points, and never changes how the ported API behaves
([ADR-0220](../decisions/0220-safe-api-entry-points.md)).

## The environment model

Code that uses the safe API declares where it runs by what it imports:

| Import | Runs in | Can it hold a log's private key? |
| --- | --- | --- |
| `webtessera/server` | your server's private environment: Node.js 22.18+, Deno, Bun, Cloudflare Workers, Vercel Edge and other edge runtimes | yes: imported from your secret store, held by WebCrypto |
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

- **Non-extractable WebCrypto keys where the runtime supports Ed25519**: Node.js 22.18+, Deno, Bun, workerd, Chrome
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

```sh
npx webtessera keygen example.com/log >> .env   # LOG_SKEY (secret), LOG_VKEY (publish)
```

or, in a deploy script, `generateLogKeyPair("example.com/log")` from `webtessera/server`, which returns
`{ skey, vkey }`. At run time, `importLogKey(process.env.LOG_SKEY)` validates it exactly as Go's `note.NewSigner` does and imports it into a
non-extractable WebCrypto key, wiping the bytes it decoded. The string itself is immutable, so keep it out of
logs and source code; that, and the copy your environment holds, is beyond what any library can protect.

**In a browser**, a key is never a string. `openDeviceKey(origin)` generates a non-extractable key on first use and
keeps it in IndexedDB as the CryptoKey itself; every tab and worker of the page's origin gets the same key, after
reloads too ([ADR-0227](../decisions/0227-device-keys-in-indexeddb.md)). An application that manages keys itself
passes an Ed25519 `CryptoKeyPair` to `fromCryptoKey`. Two things to know:

- A non-extractable key cannot be stolen, but a script injected into the page can use it while the page is open.
  Content Security Policy is still your first defense.
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
| `appendMany(entries, { signal?, timeoutMs? })` | adds entries in order, for the cost of one checkpoint wait; refuses the whole batch if one entry is too large |
| `prove(index, { extraData? })` | a receipt for an existing entry, relative to the latest checkpoint |
| `entries(from?, to?)` | the log's entries, in order, as `{ index, data }`: an async iterator up to `to` or the latest checkpoint's size |
| `entry(index)` | one entry, as `entries` reads it |
| `latestCheckpoint()` | the latest published checkpoint, verified |
| `verify(receipt, data)` | checks a receipt against this log's key and witness policy |
| `fsck({ signal?, workers? })` | verifies every entry bundle, tile and the root hash against the latest checkpoint; reads the whole log |
| `fetch`, `handler` (server only) | the tlog-tiles read API: `fetch` answers 404 for what is not the log's, `handler` returns `undefined` so `combineHandlers` can try your routes |
| `close()` | waits for every appended entry to be published, then stops; `await using` does the same |
| `origin`, `vkey`, `verifier` | the log's identity |
| `reader`, `appender` | the ported `LogReader` and `Appender`, the way down to the rest of the API |

The defaults are chosen so that the obvious call is the safe one:

| Default | Why |
| --- | --- |
| Storage is required on a server; memory must be asked for as `{ memory: true }` | a log in memory loses its tree on restart while its checkpoints live on in clients |
| SQLite locking is the adapter's, which fails closed: lease locking for every database another process could reach, local only for one that is private (in memory, a Durable Object) | two processes appending to one database under local locks fork the log; `locking: "single-writer"` declares that there is only one, and stops a second that makes the same claim |
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
import { toNodeListener } from "webtessera/http";
import { importLogKey, openServerLog } from "webtessera/server";
import { fromSqliteSync } from "webtessera/storage/sqlite";
import { createServer } from "node:http";

const log = await openServerLog({
  key: await importLogKey(process.env.LOG_SKEY),
  storage: { sqlite: fromSqliteSync(new DatabaseSync("log.db")) },
  http: { cors: true },
});
createServer(toNodeListener(log.fetch)).listen(8080);
```

`storage` is `{ sqlite, namespace?, locking?, lease? }` with any adapter from `webtessera/storage/sqlite`,
`{ objectStore }` for a durable store of your own, or `{ memory: true }`;
[choosing storage](choosing-storage.md) covers each, and the locking each adapter defaults to. On Deno, serve
with `Deno.serve(log.fetch)`; on Bun, `Bun.serve({ fetch: log.fetch })`; on Workers,
`export default { fetch: log.fetch }`. [Serve a log](serve-witness-mirror.md#serve-a-log) adds routes of your
own.

### In a browser

```ts file=src/README_test.ts region=safe_browser_example
// A key generated on this device and kept in IndexedDB, which no script can export.
const key = await openDeviceKey("device.example/7f3a");
const log = await openBrowserLog({ key });

const receipt = await log.append(new TextEncoder().encode("signed the form"));
```

Both functions come from `webtessera/browser`. [A client-only log](client-only-log.md) covers the choices to
make.

## Batches, errors and checks

`append` waits for the next checkpoint, about `checkpointIntervalMs` (1 s). Appends started together share
it, so `await log.appendMany(entries)` (or `Promise.all` over `append`) costs one wait, where a loop of
awaited appends costs one each.

Every error the safe API raises itself is a `WebtesseraError` with a stable `code` to branch on; the TSDoc
of `WebtesseraErrorCode` lists them. `PUBLISH_TIMEOUT` and `NOT_COVERED` carry the entry's `index`, and a
failed receipt is the subclass `ReceiptError`. A signer key passed where a verifier key, an origin or a name
belongs is refused with `SIGNER_KEY_MISUSE` and is never repeated in an error
([ADR-0243](../decisions/0243-one-error-class-for-the-safe-api.md)).

`await log.fsck()` checks the whole log against its latest checkpoint and throws `STORAGE_DAMAGED` if
anything does not match. It reads every tile and bundle: run it after an incident or on a schedule, in
the process that writes the log. A second process that opens the log is a second writer, which a
single-writer declaration does not allow; to check a log from elsewhere, give `newFsck`
(`webtessera/fsck`) a `newHTTPFetcher` (`webtessera/client`) for its read API.

## Troubleshooting

**`"openServerLog" is not exported by ".../NOT-FOR-BROWSERS--use-webtessera-browser.js"`** (Vite), or
`No matching export in "…/NOT-FOR-BROWSERS--use-webtessera-browser.js"` (esbuild, `bun build`): a browser
bundle imported `webtessera/server`. Import from `webtessera/browser` there, and keep `webtessera/server` in
server and edge code.

**`WRITER_CONFLICT`**: two processes opened one SQLite file with `locking: "single-writer"`, and this one
stopped writing so that the log does not fork. Use the adapter's default, lease locking, to share a file
between processes.

**`STORAGE_DIVERGED`**: storage changed under this process, usually because another writer used it without
shared locks. Run `log.fsck()`.

## Use cases

Each use case has its own guide and a runnable example:

- [A client-only log](client-only-log.md): a browser keeps its own log, signed by a device key.
- [Session receipts](session-receipts.md): your server witnesses a browser's log, and commits it to a bucket.
- [A notary](notary.md): receipts over document digests, verified offline.
- [A log server](log-server.md): `POST /add` and the tlog-tiles read API on any SQLite.

## When to drop down to the ported API

The safe API is deliberately small. Use [the ported API](ported-api.md), which it is built on, for:

- **Key rotation** and multiple checkpoint signers (`AppendOptions.withCheckpointSigner` or
  `withCheckpointAsyncSigner(primary, ...additional)`; the latter takes `LogKey`s, keeping their custody).
- **Static CT logs** (`newCertificateTransparencyAppender`, `webtessera/ctonly`), **migration**
  (`newMigrationTarget`) and custom entry layouts.
- **Reading and verifying remote logs** over HTTP (`webtessera/client`), whole-log audits (`webtessera/fsck`),
  mirroring (`webtessera/mirror`) and witnessing (`webtessera/witness`): pass them `log.reader` and `log.verifier`.
- **Index-only appends** without waiting for publication: `log.appender.add(newEntry(data))()`.

Everything the safe API does is a composition of those functions, named at the top of each module in `src/safe/`,
so dropping down never means relearning the log.
