# Guides

Task-oriented guides for building on webtessera. Each use case has a short guide and a runnable
example under [`examples/`](../../examples) with its own tests; start with the guide, then read the
example's code, which the guide points into.

| Guide | What you build | Example |
| --- | --- | --- |
| [The safe API](safe-api.md) | The layer every guide below starts from: key custody, the log object, receipts. | — |
| [A client-only log](client-only-log.md) | A browser keeps its own tamper-evident log, signed by a key that cannot leave the device. | [`client-only`](../../examples/client-only) |
| [Session receipts](session-receipts.md) | The browser records every exchange with your server; the server witnesses and commits the record. Neither can rewrite it alone. | [`session-receipts`](../../examples/session-receipts) |
| [A notary](notary.md) | A service that logs document digests with their submitters' signatures, and returns receipts anyone can verify offline. | [`notary`](../../examples/notary) |
| [A log server](log-server.md) | A public log: `POST /add` and the tlog-tiles read API, on any SQLite, on Node, Bun or Deno. | [`log-server`](../../examples/log-server) |
| [A monitor](monitor.md) | A process that follows a log, proves it only grows, and reports forks and rollbacks. | [`monitor`](../../examples/monitor) |
| [At the edge](edge.md) | The log server as a Cloudflare Worker on a Durable Object, one deployment target among several. | [`edge`](../../examples/edge) |
| [Choosing storage](choosing-storage.md) | Memory, IndexedDB, each SQLite engine, ObjectStore sinks and S3: what each guarantees, and how locking keeps a log from forking. | — |

Every example runs its tests with no network and no external service: `npm run ci` (or `bun run
ci`, `pnpm run ci`) in its directory, once the library is built at the repository root.

## Which one do I need?

- **The log lives in the browser.** [A client-only log](client-only-log.md); add a witness with
  [session receipts](session-receipts.md) when someone else must be able to rely on it.
- **The log lives on your server.** [A log server](log-server.md) for a public log anyone can write
  to, [a notary](notary.md) for receipts over documents, [at the edge](edge.md) for a Worker.
- **Someone else runs the log.** [A monitor](monitor.md) to check it, and `newVerifiedMirror`
  (`webtessera/mirror`) to keep a verified copy.
