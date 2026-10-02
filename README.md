# webtessera

[![CI](https://github.com/diagnos-tech/webtessera/actions/workflows/ci.yml/badge.svg)](https://github.com/diagnos-tech/webtessera/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/webtessera)](https://www.npmjs.com/package/webtessera)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A faithful TypeScript port of [Tessera](https://github.com/transparency-dev/tessera), the tile-based
transparency log, that runs in the browser, on Cloudflare Durable Objects, and anywhere else modern
JavaScript runs.**

A transparency log is an append-only, tamper-evident record: anyone can verify that an entry is in
it, and that the log never rewrote its history. Tessera is the transparency-dev project's library
for building such logs in Go, serving them in the [C2SP tlog-tiles](https://c2sp.org/tlog-tiles)
format. webtessera brings the same log to places Go does not reach — a browser tab backed by
IndexedDB, or a Durable Object at the edge — while staying byte-for-byte compatible with it: a log
written by webtessera can be read and verified by Tessera's Go client, and the other way round.

> [!NOTE]
> webtessera is an independent port. It is not an official Google or transparency-dev project.

## Features

- **The whole append lifecycle**: batching, pushback, antispam deduplication, signed checkpoints
  ([signed notes](https://c2sp.org/signed-note), Ed25519), witnessing with witness policies and
  cosignatures, garbage collection of partial tiles, and migration of existing logs.
- **Storage for the web**: an in-memory driver, an IndexedDB driver (durable, shared safely between
  tabs through Web Locks), and a Durable Object driver (KV- and SQLite-backed objects alike). Any
  key/value store can be plugged in by implementing a six-method contract.
- **Verification**: checkpoint fetching, inclusion and consistency proofs, entry streaming, a
  client-side log state tracker, and `fsck` for whole-log integrity checks.
- **Static CT API** support for Certificate Transparency logs.
- **Small and portable**: ESM with type declarations, no Node built-ins, and only two runtime
  dependencies, the audited [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) and
  [`@noble/curves`](https://github.com/paulmillr/noble-curves).

## Install

```sh
npm install webtessera
# or: pnpm add webtessera / yarn add webtessera / bun add webtessera
```

## Quick start

Pick a storage driver and start an appender on it:

```ts file=src/README_test.ts region=common_imports
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";

// Choose one!
import { newMemoryDriver } from "webtessera/storage/memory";
// import { newIndexedDBDriver } from "webtessera/storage/indexeddb";
// import { newDurableObjectDriver } from "webtessera/storage/durableobject";
```

```ts file=src/README_test.ts region=construct_example
const driver = newMemoryDriver();
const signer = createSigner();

const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));
```

The log signs its checkpoints with a [note](https://c2sp.org/signed-note) signer, whose name is the
log's origin:

```ts file=src/README_test.ts region=create_signer_example
// Generate the key pair once. Keep skey secret; publish vkey so that clients can
// verify the log's checkpoints.
const { skey, vkey } = generateKey(undefined, "example.com/my-log");
const signer = newSigner(skey);
```

Adding an entry returns a future that resolves to the index the log durably assigned to it:

```ts file=src/README_test.ts region=use_appender_example
const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));

const index = await appender.add(newEntry(data))();
```

At that point the entry is sequenced and integrated into the tree, but clients can only verify it
once a published checkpoint commits to it, which happens within the checkpoint interval (ten
seconds by default; see `withCheckpointInterval`). If you need to wait for that — to hand back an
inclusion proof, say — use a `PublicationAwaiter`:

```ts file=src/README_test.ts region=await_publication_example
// One awaiter per log, shared by every request: it polls the published checkpoint
// only while somebody is waiting.
const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 100, signal);

const [index, checkpoint] = await awaiter.await(appender.add(newEntry(data)));
```

Call `shutdown()` before you abort the signal passed to `newAppender`: it waits until every entry
the appender accepted is integrated and covered by a published checkpoint.

## Storage drivers

| Driver | Import | Runs in | Persistence |
| --- | --- | --- | --- |
| Memory | `webtessera/storage/memory` | anywhere | none (tests, demos, ephemeral logs) |
| IndexedDB | `webtessera/storage/indexeddb` | browsers, web/service workers | durable, shared between tabs |
| Durable Object | `webtessera/storage/durableobject` | Cloudflare Workers | durable, one log per object |
| Your own | `webtessera/storage/objectstore` | wherever your store runs | yours |

All of them run the same storage engine, a port of Tessera's POSIX driver, on top of a small
key/value contract. They store every public resource under the path the tlog-tiles spec gives it
(`checkpoint`, `tile/0/x001/234`, `tile/entries/000.p/7`, …), so a store's contents *are* a static
tlog-tiles log, ready to be served over HTTP as they are.

### In the browser

```ts file=src/README_test.ts region=indexeddb_example
// The log survives reloads, and several tabs may share it: Web Locks serialise
// their writes.
const driver = await newIndexedDBDriver({ name: "my-log" }, signal);
const { appender, shutdown } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer), signal);
```

See [`examples/browser`](examples/browser) for a complete page you can open in two tabs.

### On Cloudflare Durable Objects

Create the driver and the appender once per object, in its constructor, and keep them for the
object's lifetime. Batching and checkpoint publication run on timers while the object is in memory;
when the runtime evicts it, the next instance resumes from storage, and every index the appender
returned was already durably integrated. Large entry bundles are split transparently to fit the
storage's per-value limit, on KV- and SQLite-backed objects alike, and no `nodejs_compat` flag is
needed. From the example's `TransparencyLog` Durable Object:

```ts file=examples/cloudflare-durable-object/src/index.ts region=durableobject_example
readonly #log: Promise<{ appender: Appender; reader: LogReader; awaiter: PublicationAwaiter }>;

constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  // Open the log once per instance, before the object serves its first request.
  // The appender's timers then batch, integrate and publish entries for as long
  // as the instance lives, and the next instance resumes from storage.
  this.#log = ctx.blockConcurrencyWhile(async () => {
    const driver = newDurableObjectDriver({ storage: ctx.storage });
    const opts = newAppendOptions()
      .withCheckpointSigner(newSigner(env.LOG_PRIVATE_KEY))
      .withCheckpointInterval(checkpointIntervalMs);
    const { appender, reader } = await newAppender(driver, opts);
    const awaiter = newPublicationAwaiter((signal) => reader.readCheckpoint(signal), 100);
    return { appender, reader, awaiter };
  });
}

/** add appends data to the log and resolves to its index once a published checkpoint commits to it. */
async add(data: Uint8Array): Promise<bigint> {
  const { appender, awaiter } = await this.#log;
  const [{ index }] = await awaiter.await(appender.add(newEntry(data)));
  return index;
}
```

[`examples/cloudflare-durable-object`](examples/cloudflare-durable-object) is a deployable Worker that
appends entries over HTTP and serves the log's tlog-tiles API.

### Bring your own store

Implement `ObjectStore` — `get`, `stat`, `put`, `create`, `deletePrefix` and `lock` — for any
backend and hand it to `newObjectStoreDriver({ store })`. The contract, including the atomicity and
locking guarantees the engine relies on, is documented in
[`src/storage/objectstore/objectstore.ts`](src/storage/objectstore/objectstore.ts).

## Reading and verifying a log

The `webtessera/client` package reads any tlog-tiles log — one written by webtessera, by Tessera, or
by any other compatible implementation — and verifies what it reads:

```ts file=src/README_test.ts region=verify_example
const verifier = newVerifier(verifierKey);
const log = newHTTPFetcher(new URL("https://log.example.com/"));

// Fetch the latest checkpoint and check the log's signature on it.
const { checkpoint } = await fetchCheckpoint((s) => log.readCheckpoint(s), verifier, verifier.name());

// Prove that the entry at `index` is committed to by that checkpoint.
const proofs = await newProofBuilder(checkpoint.size, (l, i, p, s) => log.readTile(l, i, p, s));
const proof = await proofs.inclusionProof(index.index);
verifyInclusion(DefaultHasher, index.index, checkpoint.size, DefaultHasher.hashLeaf(data), proof, checkpoint.hash);
```

A `LogReader` from `newAppender` can stand in for the HTTP fetcher when the log is local.

## Packages

The package is split the way Tessera is split into Go packages:

| Import | Go counterpart | Contents |
| --- | --- | --- |
| `webtessera` | `tessera` | appender, options, publication awaiter, antispam, witnessing, migration |
| `webtessera/client` | `tessera/client` | fetchers, proof building, entry streaming, log state tracking |
| `webtessera/storage/*` | `tessera/storage/*` | storage drivers (see above) |
| `webtessera/api`, `webtessera/api/layout` | `tessera/api`, `tessera/api/layout` | tile and entry-bundle formats, tlog-tiles paths |
| `webtessera/fsck` | `tessera/fsck` | whole-log verification |
| `webtessera/ctonly` | `tessera/ctonly` | Static CT API entries |
| `webtessera/testonly` | `tessera/testonly` | an in-memory test log for your own tests |
| `webtessera/note` | `golang.org/x/mod/sumdb/note` | signed notes, signers and verifiers |
| `webtessera/formats/log` | `transparency-dev/formats/log` | checkpoints |
| `webtessera/merkle/*` | `transparency-dev/merkle/*` | RFC 6962 hashing, compact ranges, proofs |

Names follow Go's, with functions in camelCase (`NewAppender` is `newAppender`). Go's `uint64` is
`bigint`, durations are milliseconds, errors are thrown with Go's message text, and
`context.Context` is an optional trailing `AbortSignal`.

## Fidelity and compatibility

webtessera is a translation, not a reimplementation, and is built to be reviewed against the
original:

- Every source file mirrors an upstream file of the same name, with the upstream comments carried
  over. [`docs/PORTING-MAP.md`](docs/PORTING-MAP.md) tracks the status of every Go file, and each
  divergence, however small, is recorded as an ADR in [`docs/decisions`](docs/decisions).
- The golden fixtures in [`fixtures/data`](fixtures/data) are produced by running the real Tessera,
  at a pinned commit, through the Go program in [`fixtures/gen`](fixtures/gen). The tests assert
  byte-for-byte equality against them — tiles, entry bundles, checkpoints, proofs, notes — and CI
  regenerates them from upstream and fails on any difference.
- The test suites run in Node, in a real Chromium, and in workerd, Cloudflare's runtime.

## Runtime support

Node.js 20 or later, current browsers (IndexedDB and Web Locks for the IndexedDB driver), Cloudflare
Workers and Durable Objects, Deno 2 and Bun. CI runs the test suites on Node 20, 22 and 24, in Chromium
and in workerd, and an end-to-end smoke test of the built package on Node, Bun and Deno. The
published build is ES2022.

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains the setup and the workflow,
and [`PORTING.md`](PORTING.md) the porting rules every change follows. To report a vulnerability,
see [`SECURITY.md`](SECURITY.md).

## License

Apache License 2.0; see [`LICENSE`](LICENSE). Files translated from Go's own libraries
(`golang.org/x/mod/sumdb/note`, parts of `golang.org/x/crypto` and the standard library) keep their
BSD 3-Clause license, reproduced in [`LICENSES`](LICENSES); [`NOTICE`](NOTICE) lists every source.

webtessera exists because of the work of the Tessera authors, to whom it owes its design, its
comments, and its tests.
