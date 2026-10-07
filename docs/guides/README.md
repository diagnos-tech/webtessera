# Guides

Start with the guide for your use case, then read its example, a small application with its own
tests under [`examples/`](../../examples) that the guide points into.

| Guide | What you build | Runs on | Example |
| --- | --- | --- | --- |
| [A client-only log](client-only-log.md) | A browser keeps its own tamper-evident log in IndexedDB, signed by a device key that no script can export. | browsers | [`client-only`](../../examples/client-only) |
| [Session receipts](session-receipts.md) | The browser records every exchange with your server; the server witnesses the record and commits it, verified, to a bucket. Neither side can rewrite it alone. | browser + Node, Bun, Deno | [`session-receipts`](../../examples/session-receipts) |
| [A notary](notary.md) | A service that logs document digests with their submitters' signatures, and returns receipts anyone can verify offline. | Node, Bun, Deno | [`notary`](../../examples/notary) |
| [A log server](log-server.md) | A public log: `POST /add` and the tlog-tiles read API, on any SQLite. | Node, Bun, Deno | [`log-server`](../../examples/log-server) |
| [A monitor](monitor.md) | A process that follows a log, proves it only grows, and reports forks and rollbacks. | Node, Bun, Deno | [`monitor`](../../examples/monitor) |
| [At the edge](edge.md) | The log server as a Worker on a SQLite-backed Durable Object, one deployment target among several. | Cloudflare Workers | [`edge`](../../examples/edge) |

To run an example's tests, which need no network and no external service, build the library at the
repository root, then run `npm run ci` (or `bun run ci`, `pnpm run ci`) in the example's directory.

## Topics

- [The safe API](safe-api.md): the layer every use case starts from: key custody, the log object,
  receipts.
- [Choosing storage](choosing-storage.md): memory, IndexedDB, each SQLite engine, your own store and
  S3 buckets: what each guarantees, and how locking keeps a log from forking.
- [The ported API](ported-api.md): Tessera's own API, translated, and the map of every package.
- [Serving, witnessing and mirroring](serve-witness-mirror.md): `webtessera/http`,
  `webtessera/witness` and `webtessera/mirror`.

## Which one do I need?

- **The log lives in the browser.** [A client-only log](client-only-log.md); add a witness with
  [session receipts](session-receipts.md) when someone else must be able to rely on it.
- **The log lives on your server.** [A log server](log-server.md) for a public log anyone can write
  to, [a notary](notary.md) for receipts over documents, [at the edge](edge.md) for an edge runtime.
- **Someone else runs the log.** [A monitor](monitor.md) to check it, and
  [a verified mirror](serve-witness-mirror.md#mirror-a-log) to keep a copy.
