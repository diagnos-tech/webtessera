# The ported API

This guide walks through Tessera's own API as webtessera ports it, and maps every package to its Go
counterpart; read it when you need what the [safe API](safe-api.md) leaves out, such as custom
storage, migration, antispam, witness policies, key rotation or Static CT.

Every safe API log exposes this API as `log.reader` and `log.appender`, so you can start with the safe
API and drop down only where you need to.

## Conventions

Names follow Go's, with functions in camelCase: `NewAppender` is `newAppender`. Go's `uint64` is
`bigint`, durations are milliseconds, errors are thrown with Go's message text, and `context.Context`
is an optional trailing `AbortSignal`. Test for Go's sentinels with `errorIs(err, ErrPushback)`, never
`===`, and find an error class anywhere in a cause chain with `errorAs(err, ErrInconsistency)`, both from
`webtessera`. [AGENTS.md §3](../../AGENTS.md#3-fidelity-rules) has the full mapping, so Tessera's own
documentation applies to this API once you translate the names.

## Write to a log

### Create a signer

The log signs its checkpoints with a [signed-note](https://c2sp.org/signed-note) signer, whose name is
the log's origin:

```ts file=src/README_test.ts region=create_signer_example
// Generate the key pair once. Keep skey secret; publish vkey so that clients can
// verify the log's checkpoints.
const { skey, vkey } = generateKey(undefined, "example.com/my-log");
const signer = newSigner(skey);
```

`generateKey`, `newSigner` and `newVerifier` come from `webtessera/note`.

### Start an appender

Import the root package and one storage driver, then start an appender on the driver:

```ts file=src/README_test.ts region=common_imports
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";

// Choose one!
import { newMemoryDriver } from "webtessera/storage/memory";
// import { newIndexedDBDriver } from "webtessera/storage/indexeddb";
// import { newSqliteDriver, fromSqliteSync } from "webtessera/storage/sqlite";
```

```ts file=src/README_test.ts region=construct_example
const driver = newMemoryDriver();
const signer = createSigner();

const { appender, shutdown, reader } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer));
```

`newAppender` takes an optional `AbortSignal` as its last argument, which its background tasks watch.

### Add entries

`appender.add` returns a future. Call it to get the index that the log durably assigned to the entry:

```ts
const index = await appender.add(newEntry(data))();
```

The entry is then sequenced and integrated into the tree, but clients can verify it only once a
published checkpoint commits to it. That happens within the checkpoint interval, ten seconds by
default. To wait for it, for example to return an inclusion proof, use a `PublicationAwaiter`:

```ts file=src/README_test.ts region=await_publication_example
// One awaiter per log, shared by every request: it polls the published checkpoint
// only while somebody is waiting.
const awaiter = newPublicationAwaiter((s) => reader.readCheckpoint(s), 100, signal);

const [index, checkpoint] = await awaiter.await(appender.add(newEntry(data)));
```

### Shut down

Call `shutdown()` before you abort the signal passed to `newAppender`. It waits until every entry that
the appender accepted is integrated and covered by a published checkpoint. After it returns, `add`
fails.

### Tune the appender

`newAppendOptions()` returns an `AppendOptions`. Its methods mirror Tessera's `With*` options; these
are the ones most logs set, and each method's doc comment covers its parameters:

| Method | What it configures | Default |
| --- | --- | --- |
| `withCheckpointSigner(signer, ...additional)` | The checkpoint signer, plus signers of the same name, for key rotation. | required |
| `withCheckpointAsyncSigner(signer, ...additional)` | The same, for asynchronous signers such as the safe API's `LogKey`. | — |
| `withBatching(maxSize, maxAgeMs)` | When a batch of entries goes to the sequencer. | 256 entries, 250 ms |
| `withAntispam(inMemEntries, antispam)` | Deduplication of entries already in the log. | off |
| `withCheckpointInterval(intervalMs)` | How often a new checkpoint is published. | 10 s |
| `withCheckpointRepublishInterval(intervalMs)` | How often an unchanged checkpoint is published again. | 10 min |
| `withWitnesses(group, opts)` | The witnesses that must cosign each checkpoint before it is published. | none |
| `withGarbageCollectionInterval(intervalMs)` | How often obsolete partial tiles and bundles are removed. | 1 min |

## Choose a storage driver

Every driver runs the same storage engine, a port of Tessera's POSIX driver. To keep the log in a
browser, use IndexedDB:

```ts file=src/README_test.ts region=indexeddb_example
// The log survives reloads, and several tabs may share it: Web Locks serialise
// their writes.
const driver = await newIndexedDBDriver({ name: "my-log" }, signal);
const { appender, shutdown } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer), signal);
```

On a server or at the edge, use SQLite through the adapter for your engine:

```ts file=src/README_test.ts region=sqlite_example
// node:sqlite here; any other engine changes only this line, through its own adapter.
const database = fromSqliteSync(new DatabaseSync(file));
const driver = await newSqliteDriver({ database }, signal);
const { appender, shutdown } = await newAppender(driver, newAppendOptions().withCheckpointSigner(signer), signal);
```

For any other backend, implement `ObjectStore` and pass it to `newObjectStoreDriver({ store })` from
`webtessera/storage/objectstore`. [Choosing storage](choosing-storage.md) covers what each backend
guarantees, the SQLite adapters, and how locking keeps a log from forking.

## Read and verify a log

`webtessera/client` reads any [tlog-tiles](https://c2sp.org/tlog-tiles) log, whether webtessera,
Tessera or another implementation wrote it, and verifies what it reads:

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

`verifyInclusion` comes from `webtessera/merkle/proof`, and `DefaultHasher` from
`webtessera/merkle/rfc6962`. For a local log, the `reader` that `newAppender` returns can stand in for
the HTTP fetcher. To follow a log over time and prove that each checkpoint extends the last, use
`newLogStateTracker`; [a monitor](monitor.md) shows how.

## Beyond appending

| Task | API |
| --- | --- |
| Static CT logs | `newCertificateTransparencyAppender` and `withCTLayout` (`webtessera`), with entries from `webtessera/ctonly` |
| Import an existing tlog-tiles or Static CT log | `newMigrationTarget` and `newMigrationOptions` (`webtessera`) |
| Witness policies | `newWitnessGroupFromPolicy` (`webtessera`), passed to `withWitnesses` |
| Whole-log audits | `newFsck` (`webtessera/fsck`), whose bundle hasher defaults to `defaultMerkleLeafHasher` |
| Tests of your own code | `newTestLog` (`webtessera/testonly`), an in-memory log |

## Packages

The package is split the way Tessera is split into Go packages, plus the additions marked —:

| Import | Go counterpart | Contents |
| --- | --- | --- |
| `webtessera` | `tessera` | appender, options, publication awaiter, antispam, witnessing, migration |
| `webtessera/client` | `tessera/client` | fetchers, proof building, entry streaming, log state tracking |
| `webtessera/storage/objectstore` | `tessera/storage/posix` | the storage engine, on a six-method key/value contract |
| `webtessera/storage/memory`, `webtessera/storage/indexeddb` | — | in-memory and IndexedDB backends |
| `webtessera/storage/sqlite` | — | the SQLite backend and one adapter per engine |
| `webtessera/api`, `webtessera/api/layout` | `tessera/api`, `tessera/api/layout` | tile and entry-bundle formats, tlog-tiles paths |
| `webtessera/fsck` | `tessera/fsck` | whole-log verification |
| `webtessera/ctonly` | `tessera/ctonly` | Static CT API entries |
| `webtessera/testonly` | `tessera/testonly` | an in-memory test log for your own tests |
| `webtessera/server` | — (safe API) | `openServerLog`, `importLogKey`, receipts; refuses to run in browsers |
| `webtessera/browser` | — (safe API) | `openBrowserLog`, device keys, receipts |
| `webtessera/http` | — | serves a log over the tlog-tiles HTTP API, as a fetch-style handler |
| `webtessera/witness` | — | a tlog-witness server, the other side of the witnessing in `webtessera` |
| `webtessera/mirror` | `tessera/cmd/experimental/mirror` | copies a log into S3-compatible storage or any `ObjectStore` |
| `webtessera/note` | `golang.org/x/mod/sumdb/note` | signed notes, signers and verifiers |
| `webtessera/formats/log` | `transparency-dev/formats/log` | checkpoints |
| `webtessera/formats/proof` | `transparency-dev/formats/proof` | [C2SP tlog-proof](https://c2sp.org/tlog-proof) encoding |
| `webtessera/merkle/*` | `transparency-dev/merkle/*` | RFC 6962 hashing, compact ranges, proofs |

The doc comments in each package's source are its reference.
