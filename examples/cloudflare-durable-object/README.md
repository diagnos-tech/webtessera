# A transparency log on Cloudflare Durable Objects

A Worker that runs a [webtessera](../../README.md) transparency log in a Durable Object. It
appends entries over HTTP and serves the log's [tlog-tiles](https://c2sp.org/tlog-tiles) read API,
so any tlog-tiles client, such as webtessera's own or Tessera's Go client, can fetch and verify
it. The Worker needs no `nodejs_compat` flag.

## API

| Method      | Path                           | Response                                                                                                                     |
| ----------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST`      | `/add`                         | The request body is the entry, at most 65535 bytes. Answers with the entry's index as a bare decimal (`text/plain`), as Tessera's own personalities do, once a published checkpoint commits to the entry. |
| `GET` `HEAD` | `/checkpoint`                  | The latest signed checkpoint, `text/plain; charset=utf-8`, `Cache-Control: no-cache`.                                       |
| `GET` `HEAD` | `/tile/<L>/<N>[.p/<W>]`        | A hash tile, `application/octet-stream`.                                                                                     |
| `GET` `HEAD` | `/tile/entries/<N>[.p/<W>]`    | An entry bundle, `application/octet-stream`.                                                                                 |

Full tiles and bundles never change, and are served with `Cache-Control: public, max-age=31536000,
immutable`; partial ones get `max-age=60`. Every read response allows any origin, so browsers can
verify the log directly.

Errors: `404` for a resource that does not exist (yet) and for any other path, `400` for a
malformed tile path, `405` for the wrong method, `413` for an entry over 65535 bytes (the limit
the tlog-tiles bundle format imposes), and `503` with `Retry-After` when the log is applying
back-pressure.

## Run it locally

From a checkout of this repository:

```sh
pnpm install
cd examples/cloudflare-durable-object
pnpm keygen localhost/my-log      # prints a key pair, and the .dev.vars line to use
echo 'LOG_PRIVATE_KEY=PRIVATE+KEY+localhost/my-log+…' > .dev.vars
pnpm dev                          # builds webtessera, then starts wrangler dev
```

Then, in another terminal:

```console
$ curl -X POST --data-binary 'hello, log' http://localhost:8787/add; echo
0
$ curl -X POST --data-binary 'second entry' http://localhost:8787/add; echo
1
$ curl http://localhost:8787/checkpoint
localhost/my-log
2
mjYvVTS+XkUmXXfsmu2ey9PiZaeJCckzncvqk97CELA=

— localhost/my-log <signature>
```

## Deploy

```sh
pnpm keygen log.example.com/my-log
pnpm exec wrangler secret put LOG_PRIVATE_KEY   # paste the private key when prompted
pnpm run deploy                                 # `pnpm deploy` is a different, built-in command
```

The key's name is the log's _origin_, the first line of every checkpoint, which clients check.
By convention it is the URL the log is served at, without the scheme. Keep the private key
secret, and publish the public key: clients verify checkpoints with it. Keys use the signed-note
format of `golang.org/x/mod/sumdb/note`, so tools built on Go's `note` package accept them too.
`pnpm keygen` wraps `generateKey` from `webtessera/note`, which you can also call yourself.

## Verify it

```ts
import { fetchCheckpoint, newHTTPFetcher, newProofBuilder } from "webtessera/client";
import { verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { newVerifier } from "webtessera/note";

const verifier = newVerifier(publicKey);
const log = newHTTPFetcher(new URL("https://log.example.com/"));
const { checkpoint } = await fetchCheckpoint((s) => log.readCheckpoint(s), verifier, verifier.name());

const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => log.readTile(l, i, p, s));
const proof = await proofs.inclusionProof(index);
verifyInclusion(DefaultHasher, index, checkpoint.size, DefaultHasher.hashLeaf(entry), proof, checkpoint.hash);
```

## How it works

- **One object per log.** A single SQLite-backed `TransparencyLog` Durable Object holds the
  whole log, and the Worker forwards every request to it. Run more logs by addressing more
  objects (`env.LOG.getByName(...)`). Other Workers can append over RPC, without HTTP:
  `await env.LOG.getByName("log").add(data)`.
- **Opened once per instance.** The object's constructor creates the storage driver, which
  keeps the log in the object's own SQLite database
  (`newSqliteDriver({ database: fromDurableObjectStorage(ctx.storage) })`), the appender and a
  `PublicationAwaiter` under `ctx.blockConcurrencyWhile`, so no request sees a half-opened log.
  The same driver runs on any other SQLite (node:sqlite, bun:sqlite, libSQL, rqlite, D1, …)
  through the matching adapter of `webtessera/storage/sqlite`.
- **Durability.** By the time `POST /add` answers, the entry is sequenced, integrated into the
  tree and committed to by a published checkpoint. The driver's storage writes commit before it
  moves on, and the runtime's output gate holds the response back until they are persisted, so
  an acknowledged entry is never lost. Entry bundles larger than the SQL API's 2 MB row limit
  are split across several rows transparently.
- **Background work.** Batching, checkpoint publication and garbage collection run on timers
  for as long as the instance is in memory. Pending timers keep an instance from hibernating
  (and workerd will not evict one gracefully while they are pending), so expect the object to
  stay in memory, and to be billed for duration, while the log is open. When the runtime does
  discard the instance (a deploy, a restart, a move to another machine), the next request
  starts a new one, which resumes from storage and publishes anything integrated but not yet
  published within one checkpoint interval.
- **Latency.** `POST /add` waits for the entry's batch to fill or age (at most 250 ms by
  default) and for the next checkpoint (here at most one second, `checkpointIntervalMs`).
  Tune both with `withBatching` and `withCheckpointInterval`. A personality that does not need
  to wait for publication can answer as soon as `appender.add(...)()` resolves, when the entry
  is durably sequenced and integrated.
- **Reads.** Every read is served from the object's storage. A busy log can take that load off
  the object by caching responses in front of it, for instance with the Workers Cache API in
  the Worker's `fetch`; the `Cache-Control` headers already say what may be cached for how long.

## Test

```sh
pnpm test
```

runs [`src/index_test.ts`](src/index_test.ts) inside workerd with
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/).
It talks to the Worker over HTTP and verifies what it serves, signatures and inclusion proofs
included, with webtessera's client. [`vitest.config.ts`](vitest.config.ts) enables `nodejs_compat`
for the test run only, because the test pool needs it to run Vitest; the Worker does not.
