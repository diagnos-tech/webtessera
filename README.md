# webtessera

[![CI](https://github.com/diagnos-tech/webtessera/actions/workflows/ci.yml/badge.svg)](https://github.com/diagnos-tech/webtessera/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/webtessera)](https://www.npmjs.com/package/webtessera)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**webtessera is a faithful TypeScript port of [Tessera](https://github.com/transparency-dev/tessera),
the tile-based transparency log, for browsers, servers and edge runtimes.**

A transparency log is an append-only, tamper-evident record: anyone can verify that an entry is in it,
and that the log never rewrote its history. webtessera runs where Go does not reach, in a browser tab
on IndexedDB or on whichever SQLite your server already has, and its logs are byte-for-byte compatible
with Tessera's: each side reads, verifies and extends logs that the other wrote.

> [!NOTE]
> webtessera is an independent port. It is not an official Google or transparency-dev project.

## Install

```sh
npm install webtessera
# or: bun add webtessera / pnpm add webtessera / yarn add webtessera
```

webtessera runs on Node.js 22.18 or later, Deno 2, Bun, current browsers, and edge runtimes built on
web standards.

## Quick start

Open a log on a server, append an entry, and verify its receipt:

```ts file=src/README_test.ts region=safe_imports
import { DatabaseSync } from "node:sqlite";
import { importLogKey, openServerLog, verifyReceipt } from "webtessera/server";
import { fromSqliteSync } from "webtessera/storage/sqlite";
```

```ts file=src/README_test.ts region=safe_server_example
// The key comes from your secret store, never from source code.
const log = await openServerLog({
  key: await importLogKey(process.env.LOG_SKEY),
  storage: { sqlite: fromSqliteSync(new DatabaseSync("log.db")) },
});

// append resolves once a published checkpoint covers the entry, with a verified receipt.
const entry = new TextEncoder().encode("hello");
const receipt = await log.append(entry);

// Anyone with the log's vkey and the entry can check the receipt, offline.
const { index, checkpoint } = verifyReceipt(receipt.text, { vkey: log.vkey, data: entry });
```

To create the key, run `npx webtessera keygen example.com/log >> .env` once (or `bunx`, or
`generateLogKeyPair` from `webtessera/server` in a script), then start with `node --env-file=.env`
(Deno: `--env-file`; Bun reads `.env` itself). Keep `LOG_SKEY` in your secret store, and publish
`LOG_VKEY`.

In a browser, `openDeviceKey` and `openBrowserLog` from `webtessera/browser` keep the log in IndexedDB:

```ts file=src/README_test.ts region=safe_browser_example
// A key generated on this device and kept in IndexedDB, which no script can export.
const key = await openDeviceKey("device.example/7f3a");
const log = await openBrowserLog({ key });

const receipt = await log.append(new TextEncoder().encode("signed the form"));
```

This is the safe API. `webtessera/server` refuses to run in a browser, storage is durable unless you
ask for memory by name, SQLite is locked so that several processes cannot fork the log, and every
receipt is verified before it is returned. Serve the log with `log.fetch`, append in batches with
`appendMany`, and branch on an error's `code`. The [safe API guide](docs/guides/safe-api.md) explains
each default.

## The ported API

Underneath the safe API is Tessera's own API, translated name for name (`NewAppender` is
`newAppender`). Use it for what the safe API leaves out: custom storage, migration, antispam, witness
policies and Static CT. These are the snippets of Tessera's README, ported:

```ts file=src/README_test.ts region=common_imports
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";

// Choose one!
import { newMemoryDriver } from "webtessera/storage/memory";
// import { newIndexedDBDriver } from "webtessera/storage/indexeddb";
// import { newSqliteDriver, fromSqliteSync } from "webtessera/storage/sqlite";
```

The log signs its checkpoints with a [signed-note](https://c2sp.org/signed-note) signer, whose name
is the log's origin; `createSigner()` below returns this one:

```ts file=src/README_test.ts region=create_signer_example
// Generate the key pair once. Keep skey secret; publish vkey so that clients can
// verify the log's checkpoints.
const { skey, vkey } = generateKey(undefined, "example.com/my-log");
const signer = newSigner(skey);
```

Start an appender on a storage driver:

```ts file=src/README_test.ts region=construct_example
const driver = newMemoryDriver();
const signer = createSigner();

const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));
```

Add an entry. The future resolves to the index that the log durably assigned to it:

```ts file=src/README_test.ts region=use_appender_example
const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));

const index = await appender.add(newEntry(data))();
```

The [ported API guide](docs/guides/ported-api.md) continues with publication, storage drivers,
verification and the map of every package.

## What's included

- **Safe API**: `webtessera/server` and `webtessera/browser`, with receipts that are
  [C2SP tlog-proofs](https://c2sp.org/tlog-proof). See the [safe API guide](docs/guides/safe-api.md).
- **The append lifecycle**: batching, antispam, signed checkpoints, witnessing, garbage collection,
  migration and Static CT. See [the ported API](docs/guides/ported-api.md).
- **Storage**: memory, IndexedDB, any SQLite engine (node:sqlite, bun:sqlite, better-sqlite3, libSQL,
  rqlite, D1, Durable Objects, sqlite-wasm), or your own key/value store. See
  [choosing storage](docs/guides/choosing-storage.md).
- **Verification**: checkpoints, inclusion and consistency proofs, log state tracking and `fsck`, for
  any [tlog-tiles](https://c2sp.org/tlog-tiles) log. See [the ported API](docs/guides/ported-api.md#read-and-verify-a-log).
- **Serving, witnessing and mirroring**: a fetch-style handler, a [tlog-witness](https://c2sp.org/tlog-witness)
  server, and a verifying mirror. See [the guide](docs/guides/serve-witness-mirror.md).
- **Examples**: six small applications, each with tests and a guide. See the [guides](docs/guides/README.md).
- **Two runtime dependencies**: [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) and
  [`@noble/curves`](https://github.com/paulmillr/noble-curves); ESM with types, and no Node built-ins.

## Next steps

- [Guides](docs/guides/README.md): one per use case, each with a runnable example.
- [Packages](docs/guides/ported-api.md#packages): every entry point and its Go counterpart. The doc
  comments in each package's source are its reference.
- [Compatibility](docs/compatibility.md): how byte compatibility with Tessera is proven, and which
  runtimes CI tests.
- [Contributing](CONTRIBUTING.md) and the porting rules in [PORTING.md](PORTING.md). To report a
  vulnerability, see [SECURITY.md](SECURITY.md).

## License

Apache License 2.0; see [`LICENSE`](LICENSE). Files translated from Go's own libraries
(`golang.org/x/mod/sumdb/note`, parts of `golang.org/x/crypto` and the standard library) keep their
BSD 3-Clause license, reproduced in [`LICENSES`](LICENSES); [`NOTICE`](NOTICE) lists every source.

webtessera exists because of the work of the Tessera authors, to whom it owes its design, its
comments, and its tests.
