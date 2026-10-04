# At the edge

**Example:** [`examples/edge`](../../examples/edge)

The log server of [the log server guide](log-server.md) runs on any runtime that serves a fetch
handler, and an edge platform is one more. The example deploys the *same handler file* as a
Cloudflare Worker, with the log in a SQLite-backed Durable Object:

```ts
export class LogObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#log = ctx.blockConcurrencyWhile(async () =>
      openServerLog({
        key: await importLogKey(env.LOG_SKEY),
        storage: { sqlite: fromDurableObjectStorage(ctx.storage) }, // local locks: one instance at a time
        http: { cors: true },
      }),
    );
  }
}
```

## Choosing where the log lives

| Platform | Storage | Locking | Notes |
| --- | --- | --- | --- |
| Cloudflare Durable Object | `fromDurableObjectStorage(ctx.storage)` | `"local"` | One instance at a time: the object is the only writer, which the adapter knows, so its default is local. Timers keep the instance in memory while the log is open. |
| Cloudflare D1 | `fromD1(env.DB)` | `"lease"` | Any number of Worker instances can share the database, but a stateless Worker keeps no timers between requests, so each request opens the log afresh. |
| Containers, VMs, serverless functions with a disk | `fromSqliteSync` over node:sqlite or bun:sqlite | `"lease"` | See [the log server](log-server.md). |
| Turso, rqlite | `fromLibsql`, `fromRqlite` | `"lease"` | A database several regions or instances reach over the network. |

The locking column is each adapter's default, which `openServerLog` keeps unless it is given `locking`.

Whatever the platform, the log's key is a secret of the platform's (`wrangler secret put LOG_SKEY`),
imported as a non-extractable WebCrypto key, and clients verify the log exactly as they would any
other: the platform can withhold the log, not rewrite it unseen.

The example's tests run inside workerd with `@cloudflare/vitest-pool-workers`, and the Worker needs
no `nodejs_compat` flag.
