# The log server at the edge: a Cloudflare Worker

[`../log-server`](../log-server) as a Cloudflare Worker: the same routes, `POST /add` and the
[tlog-tiles](https://c2sp.org/tlog-tiles) read API, from **the same file**
([`../log-server/src/log_server.ts`](../log-server/src/log_server.ts), imported as a workspace
package), with the log kept in a SQLite-backed Durable Object. It is one deployment target among
several: the identical handler runs on Node, Bun and Deno over any SQLite, and nothing in it knows
which runtime serves it.

## How it works

```text
 client ──▶ Worker fetch ──▶ env.LOG.getByName("log") ──▶ LogObject (Durable Object)
                                                           openServerLog({
                                                             key: importLogKey(env.LOG_SKEY),
                                                             storage: { sqlite: fromDurableObjectStorage(ctx.storage),
                                                                        locking: "local" } })
                                                           newLogServer(log)   ← ../log-server
 other Workers ──▶ RPC: env.LOG.getByName("log").add(data) → receipt
```

- **One object per log.** The runtime runs one instance of a Durable Object at a time, so the object
  is its database's only writer, and `locking: "local"` says so, sparing the lease's writes. Run
  more logs by addressing more objects.
- **Opened once per instance**, under `blockConcurrencyWhile`; the appender's timers then batch and
  publish while the instance lives, and the next instance resumes from storage. Pending timers keep
  the instance in memory (and billed for duration) while the log is open.
- **Durability.** `POST /add` answers once a published checkpoint covers the entry, and the runtime's
  output gate holds the response until the writes are persisted.

**Other deployment targets.** On D1, `storage: { sqlite: fromD1(env.DB) }` uses lease locking, so
any number of Worker instances can share the database; but a stateless Worker keeps no timers
between requests, so each request would open the log afresh, which a Durable Object avoids. On a
server or container, use [`../log-server`](../log-server) with `node:sqlite`, `bun:sqlite`, libSQL or
rqlite. [Choosing storage](../../docs/guides/choosing-storage.md) compares them.

## Run it

Build the library once at the repository root (`pnpm build` or `bun run build`), then here:

```sh
node scripts/keygen.ts localhost/my-log      # prints the key pair, and the .dev.vars line
echo 'LOG_SKEY=PRIVATE+KEY+localhost/my-log+…' > .dev.vars
npx wrangler dev
```

```console
$ curl -X POST --data-binary 'hello, edge' http://localhost:8787/add; echo
0
$ curl http://localhost:8787/checkpoint
localhost/my-log
1
JULsgW01d/mNqUZJrgOXttsvzDNwVjanoq6450j2EsI=

— localhost/my-log ZHGmMt1PNGVfOoCvUU6RV/oqCOi+59uCMoJmx7RKt7s2eaMtzqA1I/FQhnOiAcQ228/pyzAJVhhirGMnt/Vdvc/mtAE=
```

Deploy with `npx wrangler secret put LOG_SKEY` (paste the private key) and `npx wrangler deploy`.
The Worker needs no `nodejs_compat` flag: webtessera uses only web-standard APIs. Verify the
deployed log with [`../log-server/scripts/verify.ts`](../log-server/scripts/verify.ts), or with
Tessera's Go client ([`../log-server/go`](../log-server/go)).

## Trust model

As for [`../log-server`](../log-server#trust-model): `LOG_SKEY` is the one secret, held as a Workers
secret and imported as a non-extractable WebCrypto key; clients verify every entry against a signed
checkpoint and every checkpoint against the last; split views need monitors or witnesses to catch.
Here the platform also holds the data, so Cloudflare is in the same position as any host: it can
withhold the log, not rewrite it unseen.

## Test

```sh
npm run ci        # tsc --noEmit && vitest run, inside workerd
```

[`src/worker_test.ts`](src/worker_test.ts) runs in workerd with
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
and drives the Worker over HTTP: `POST /add` answering once a signed checkpoint covers the entry,
tiles and bundles from which webtessera's client verifies inclusion (including the largest entry
tlog-tiles allows), the cache headers, the errors, and appends over RPC with receipts that verify.
[`vitest.config.ts`](vitest.config.ts) enables `nodejs_compat` for the test pool only.

## Files to read first

1. [`src/worker.ts`](src/worker.ts): the Durable Object and the Worker.
2. [`../log-server/src/log_server.ts`](../log-server/src/log_server.ts): the routes, shared with Node,
   Bun and Deno.
