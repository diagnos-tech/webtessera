# A log server

This guide shows how to run a public transparency log over HTTP on any SQLite; read it when anyone
should be able to append to your log and verify it.

**Example:** [`examples/log-server`](../../examples/log-server)

Writers use `POST /add`, and everyone else reads the [tlog-tiles](https://c2sp.org/tlog-tiles) API.
The handler is a plain `(Request) => Promise<Response>`, so one source serves on Node, Bun, Deno and
Workers.

```ts
const log = await openServerLog({
  key: await importLogKey(env.LOG_SKEY),
  storage: { sqlite: fromSqliteSync(db) },                      // a file: lease locking, shareable
  http: { cors: true },                                         // a public log, readable from any origin
});

const serve = combineHandlers(async (request) => {
  if (new URL(request.url).pathname !== "/add") return undefined;
  const entry = await readEntryBody(request);                   // capped while it streams
  if (entry === undefined) return new Response("too large\n", { status: 413 });
  try {
    return addResponse((await log.append(entry)).index);         // the bare index, as Tessera answers
  } catch (err) {
    return addErrorResponse(err);                               // 503 + Retry-After on pushback
  }
}, log.handler);
```

To give writers their receipts instead of the bare index, answer with `receipt.text`.

Then `Deno.serve(serve)`, `Bun.serve({ fetch: serve })`, or `createServer(toNodeListener(serve))` on
Node. The example keeps the runtime-specific part (which SQLite binding opens the file, how the
handler is served) in one small file per runtime, chosen by `detectRuntime()`. On Deno, a route that
reads `request.signal` prints a harmless warning; see [On Deno](serve-witness-mirror.md#on-deno).

## Locking

For a SQLite file, the adapter's default is lease locking, which lets any number of processes, on any
mix of runtimes, append to one file; the example's README shows Node, Bun and Deno doing it at once.
Pass `locking: "local"` only to declare that this process is the file's only writer.
[Choosing storage](choosing-storage.md#lease-or-local) explains both.

## Verifying it

A client trusts the log's vkey and nothing else: it checks the checkpoint's signature, proves each
entry it cares about with an inclusion proof, and proves that each new checkpoint extends the last
it saw (`webtessera/client`'s `fetchCheckpoint`, `newProofBuilder`, and `verifyInclusion` /
`verifyConsistency` from `webtessera/merkle/proof`). The example's `scripts/verify.ts` does all
three, and `scripts/verify_go.ts` has Tessera's own Go client verify the same log, which it does,
byte for byte.

Writers are not authenticated in the example, as on Tessera's own test personalities; put your
authentication in front of `POST /add`.
