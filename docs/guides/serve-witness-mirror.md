# Serving, witnessing and mirroring

This guide covers serving a log (`webtessera/http`), witnessing other logs (`webtessera/witness`) and
mirroring a log into storage you control (`webtessera/mirror`); read it when you deploy a log, run a
witness, or keep a copy of someone else's log.

Tessera leaves serving and witnessing to the programs built on it, and its mirror is an experimental
command; here all three are libraries. Each package's module comment (`src/http/index.ts`,
`src/witness/index.ts`, `src/mirror/index.ts`) is its full reference.

## Serve a log

`newLogHandler` from `webtessera/http` serves the [tlog-tiles](https://c2sp.org/tlog-tiles) read API
from any `LogReader`. It is a plain function from `Request` to `Response`, so it runs unchanged on any
runtime with the Fetch API:

```ts
const { reader } = await newAppender(driver, opts);
const log = newLogHandler({ reader, cors: true });

const serve = combineHandlers(log, witness.handle);

Deno.serve(serve);                                   // Deno
Bun.serve({ fetch: serve });                         // Bun
export default { fetch: serve };                     // Cloudflare Workers, and other
                                                     // runtimes with the same module shape
createServer(toNodeListener(serve)).listen(8080);    // Node, with node:http's createServer
```

A log from the safe API's `openServerLog` carries the same handler as `log.handler`, and as
`log.fetch`, which answers 404 for the rest.

- **What it serves.** `GET` and `HEAD` on the checkpoint, tiles and entry bundles, under an optional
  `prefix`, with the content types and cache headers the specification gives, an `ETag`, and CORS
  headers when you pass `cors`, so that a page on another origin can verify the log.
- **Canonical paths only.** Any other path under `tile/` gets 400 with the canonical spelling. A
  resource the reader does not have gets 404, and other methods get 405.
- **Composition.** A handler resolves to `undefined` for requests that are not its own.
  `combineHandlers` joins handlers, yours included, into the one function a runtime expects, and
  answers 404 when none matches.
- **The reader is trusted.** An `HTTPFetcher` for a remote log is a valid reader: the handler then
  re-serves that log unverified. To re-serve a log you do not operate, mirror it with
  `newVerifiedMirror` and serve the copy.
- **Compression.** The specification says entry bundles should be compressed at the HTTP layer. Deno,
  Bun and most edge platforms do it automatically; behind Node, use a reverse proxy.

tlog-tiles specifies no write API, so adding entries stays your application's job, as in Tessera.
`readEntryBody`, `addResponse` and `addErrorResponse` give a `POST /add` route the conventions
Tessera's own personalities follow. `readEntryBody` refuses anything but a POST, which
`addErrorResponse` answers with 405; [a log server](log-server.md) shows the route.

### On Deno

The handlers here never read `request.signal`. Deno 2 aborts a request's signal once its response
has been sent, and prints a one-time warning ("request.signal aborts on successful responses (legacy
behavior)") the first time code reads it. A route of your own that reads it prints that warning,
which is harmless if the route has finished its work when it responds. `--unstable-no-legacy-abort`
opts in to Deno's newer behavior.

## Run a witness

The root package `webtessera` holds a log's side of the [tlog-witness](https://c2sp.org/tlog-witness)
protocol: `newWitness`, `newWitnessGroup` and `newWitnessGroupFromPolicy` describe the witnesses, and
`withWitnesses` makes the appender ask them before it publishes a checkpoint. `newWitnessServer` from
`webtessera/witness` is the other side, the server that cosigns:

```ts
import { cosignerVkey, newSignerForCosignatureV1, newWitnessServer } from "webtessera/witness";

const witness = newWitnessServer({
  signer: newSignerForCosignatureV1(env.WITNESS_SKEY),
  store,                                     // any ObjectStore: memory, IndexedDB, SQLite...
  logs: [{ origin: "example.com/log", verifierKeys: [logVkey] }],
});
// Publish this vkey: log operators name it in their witness policies.
const vkey = cosignerVkey(env.WITNESS_SKEY);
```

Create `WITNESS_SKEY` once with `generateKey` from `webtessera/note`, and keep it in your secret store.

- **What it checks.** It cosigns a checkpoint only when a consistency proof shows that it extends the
  last checkpoint it cosigned for that log. It checks and replaces that checkpoint under the store's
  lock, so concurrent requests cannot roll a log back.
- **Many logs.** `lookupLog(origin)` is asked about every origin that `logs` does not list, so one
  server can witness an open-ended set of logs, such as one per user or browser session. Logs in
  browser tabs post their checkpoints cross-origin; pass `cors: true` for them.
- **Endpoints.** `witness.handle` is a `webtessera/http` handler for `POST <prefix>/add-checkpoint`
  and the monitoring endpoint `GET <prefix>/<origin hash>/checkpoint`. `witness.addCheckpoint` makes
  the same call without HTTP.
- **Keys.** `cosignerVkey(skey)` derives the cosignature/v1 vkey from the signer key, so the key is
  the witness's only setting. `vKeyToCosignatureV1` converts an existing Ed25519 vkey to that form.
- **Witness URLs.** A log accepts only `https` witness URLs, or `http` to a loopback address.

[ADR-0171](../decisions/0171-witness-server.md) lists what is not implemented: the optional
sign-subtree call and ML-DSA cosignatures.

## Mirror a log

`Mirror` from `webtessera/mirror` is the port of Tessera's experimental mirror. It copies the tiles
and entry bundles that a target lacks, in parallel, and writes the source's checkpoint last, so the
target publishes a checkpoint only once its resources are in place, and a run that stops halfway
resumes. Like the original, it copies bytes without checking them.

For a log you do not operate, use `newVerifiedMirror`. Before it writes anything, it checks the log's
signature on the checkpoint, that the checkpoint extends what was mirrored before, and every tile and
bundle against that checkpoint:

```ts
import { newVerifier } from "webtessera/note";
import { newS3Sink, newVerifiedMirror } from "webtessera/mirror";

const mirror = newVerifiedMirror({
  source: "https://log.example/",
  origin: "log.example",
  verifier: newVerifier(logVkey),
  target: newS3Sink({ endpoint, bucket, region, accessKeyId, secretAccessKey }),
});
await mirror.run(signal);          // run again on a schedule to follow the log
```

`source` is a URL or any `Source`, such as an `HTTPFetcher` or a log's `reader`. `target` is any
sink, which is anything with `put(key, bytes)`, plus `get(key)` to resume:

- **`newS3Sink`** writes to any S3-compatible service, such as AWS S3, Cloudflare R2, Google Cloud
  Storage's XML API, Backblaze B2, MinIO or Ceph. It signs requests with AWS Signature Version 4 over
  `fetch`, with no SDK. It stores each object with the `Content-Type` and `Cache-Control` that
  tlog-tiles gives, so the bucket can be served as a static log. It sends tiles and bundles with
  `If-None-Match: *`, so a service that honors the header refuses to overwrite one with different
  bytes.
- **Any `ObjectStore`** is a sink as it is.
- **Bindings with the same shape**, such as a Cloudflare Workers R2 binding, or a short wrapper
  around another SDK.

`newSinkTarget(sink, { prefix })` mirrors under a key prefix. The result also reads the copy back, as
a `webtessera/fsck` fetcher, which is how you check a copy that `Mirror` made.

The library's S3 tests, and the session-receipts example's, run against a real bucket when
`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set.
