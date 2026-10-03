# webtessera in the browser

A transparency log that runs entirely in a browser tab. The page keeps a
[Tessera](https://github.com/transparency-dev/tessera)-compatible log in IndexedDB, appends whatever you
type, waits for a signed checkpoint that commits to your entry, and verifies the entry's inclusion proof
against that checkpoint, as any client of the log would.

> **Demo only.** The log's Ed25519 signing key is generated in the browser and stored in `localStorage`, where
> any script on the page's origin can read it. That is fine for a demo and wrong for a real log, whose
> checkpoints are only worth something if nobody else can sign them.

## Run it

From the repository root:

```sh
bun install
bun run --cwd examples/browser dev
```

Then open the URL Vite prints (`http://localhost:5173`). `dev` and `build` build the library first, so the
demo always runs against the code in this repository. `bun run --cwd examples/browser build`
produces a static site in `dist/` that any static file server can host.

## Two tabs, one log

Open the page in a second tab and append from both. Each tab runs its own appender, yet the entries land in a
single log with no gaps or duplicates: the tabs take turns through the
[Web Locks API](https://developer.mozilla.org/docs/Web/API/Web_Locks_API), which excludes every tab and worker
of the origin, and both read and write the same IndexedDB database. Each tab polls for new checkpoints, so
entries appended in one tab appear under "Most recent entries" in the other within a second.

Web Locks only exist in [secure contexts](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts):
`https://` or `localhost`. Served over plain `http://` from another host, the page says that cross-tab locking is
unavailable, and only one tab at a time should use the log.

"Delete the log and its key" deletes the database. Other tabs let go of it as soon as the deletion reaches them,
so it is never blocked, and they show a banner asking you to reload.

## How it works

Everything is in [`src/main.ts`](src/main.ts). The calls that matter:

```ts
import { newAppender, newAppendOptions, newEntry, newPublicationAwaiter } from "webtessera";
import { newProofBuilder } from "webtessera/client";
import { parseCheckpoint } from "webtessera/formats/log";
import { verifyInclusion } from "webtessera/merkle/proof";
import { DefaultHasher } from "webtessera/merkle/rfc6962";
import { newIndexedDBDriver } from "webtessera/storage/indexeddb";

// One signal bounds both the database connection and the appender's background work.
const lifetime = new AbortController();
const driver = await newIndexedDBDriver({ name: "webtessera-demo" }, lifetime.signal);
const { appender, reader } = await newAppender(
	driver,
	newAppendOptions().withCheckpointSigner(signer),
	lifetime.signal,
);
const awaiter = newPublicationAwaiter((signal) => reader.readCheckpoint(signal), 100, lifetime.signal);

// Append, and wait until a published checkpoint commits to the entry.
const [index, raw] = await awaiter.await(appender.add(newEntry(data)));
if (raw === undefined) throw new Error("the log published no checkpoint");

// Verify inclusion as a client would: check the checkpoint's signature, then prove
// the entry's leaf hash against its root hash using only the log's tiles.
const { checkpoint } = parseCheckpoint(raw, origin, verifier);
const proofs = await newProofBuilder(checkpoint.size, (level, i, p, signal) => reader.readTile(level, i, p, signal));
const proof = await proofs.inclusionProof(index.index);
verifyInclusion(DefaultHasher, index.index, checkpoint.size, DefaultHasher.hashLeaf(data), proof, checkpoint.hash);
```

The database holds the log's resources under the paths the
[C2SP tlog-tiles](https://c2sp.org/tlog-tiles) specification gives them (`checkpoint`, `tile/0/000`,
`tile/entries/000`, ...), byte for byte as Tessera's POSIX driver writes them to disk.

## Keeping the log

Browsers may evict IndexedDB data when the device runs short of space, unless the origin has persistent storage.
For a log whose checkpoints leave the device, losing its data means it can no longer prove what it signed, so the
page shows whether persistent storage is granted and offers to request it with `navigator.storage.persist()`.
