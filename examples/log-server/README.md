# A public log server, on any SQLite, on Node, Bun or Deno

A transparency log anyone can write to and everyone can verify: `POST /add` appends an entry, and
the [C2SP tlog-tiles](https://c2sp.org/tlog-tiles) read API serves the checkpoint, tiles and entry
bundles that clients verify it with. The log lives in an ordinary SQLite file, and the **same
source** starts on Node.js (`node:sqlite`), Bun (`bun:sqlite`) and Deno (`node:sqlite`); one tiny
adapter file per runtime is all that differs. Several processes, on any mix of the three, can
append to the same file at once: lease locking keeps them from forking the log.

What it serves is byte for byte a Tessera log: Tessera's own Go client verifies it
(`verify:go`, below).

## How it works

```text
 writers                     log server (Node | Bun | Deno)                    readers
 ───────                     ──────────────────────────────                    ───────
 POST /add  ───────────────▶ log_server.ts: readEntryBody → log.append ──┐
            ◀── index ─────  (answers once a signed checkpoint covers it)│
                                                                         ▼
                             openServerLog (webtessera/server)       SQLite file
                               storage: { sqlite, locking: "lease" } ◀── leases fence every
                                                                         write, so N processes
 GET /checkpoint, /tile/…  ◀── log.handler (webtessera/http) ◀───────────  share one log
                                       │
                              client.ts / verify.ts (webtessera/client):
                              signature ✓  inclusion proof ✓  consistency with last run ✓
```

## Run it

You need the library built once, from the repository root: `bun run build`.
Then, in this directory:

```sh
node scripts/keygen.ts localhost/my-log > .env    # the log's key pair; keep LOG_SKEY secret

node --env-file=.env src/main.ts                  # Node.js 22.18+
bun src/main.ts                                   # Bun (reads .env itself)
deno run --env-file --allow-net --allow-read --allow-write --allow-env src/main.ts   # Deno 2
```

`npm run start:node`, `start:bun` and `start:deno` (or `bun run …`) are the same
commands. The server listens on `127.0.0.1:8080`; `PORT`, `HOST` and `LOG_DB` (default `log.db`)
change that.

**Several processes, one log.** Start one server per runtime on the same file, and append to all
three:

```console
$ node --env-file=.env src/main.ts &
localhost/my-log on node, serving http://127.0.0.1:8080/
$ PORT=8081 bun src/main.ts &
localhost/my-log on bun, serving http://127.0.0.1:8081/
$ PORT=8082 deno run --env-file --allow-net --allow-read --allow-write --allow-env src/main.ts &
localhost/my-log on deno, serving http://127.0.0.1:8082/

$ curl -X POST --data-binary 'hello, log' http://127.0.0.1:8080/add; echo
0
$ curl -X POST --data-binary 'via Bun' http://127.0.0.1:8081/add; echo
1
$ curl -X POST --data-binary 'via Deno' http://127.0.0.1:8082/add; echo
2
$ curl http://127.0.0.1:8080/checkpoint
localhost/my-log
3
5FQDdKHjTN8Ghc8xcg6Zh2e5C3O9G0HnGpLcZam883U=

— localhost/my-log AG5+qKCMNK3rItUXP+qUS284xhM/uKpRjHLmnTEMAYKtsc9AhhaQ0cFSr5m8mvAmbMTp8+ItdN3Jf1z7/HCwDrHtEAY=
```

Each process holds the log's lock as a lease row in the database while it writes, and every write
is fenced on that lease in the same transaction, so a process that stalls past its lease can never
overwrite what the next holder wrote. `LOG_LOCKING=local` drops the leases, and is only correct
when one process is certainly the file's only writer.

**Verify it** as a client, trusting only the log's verifier key (`LOG_VKEY` in `.env`):

```console
$ node scripts/verify.ts http://127.0.0.1:8080/ "$LOG_VKEY" 0
checkpoint: signed by the log, 3 entries, root e4540374a1e34cdf0685cf31720e998767b90b73bd1b41e71a92dc65a9bcf375
consistency: first run, nothing to compare with
entry 0: proven in the tree: "hello, log"

$ curl -X POST --data-binary 'one more' http://127.0.0.1:8082/add; echo
3
$ bun scripts/verify.ts http://127.0.0.1:8081/ "$LOG_VKEY" 2
checkpoint: signed by the log, 4 entries, root e0bf81e8936a978874d0970b608c4a29b4e05216640b5eb06be57c4bc3705aed
consistency: only grew since last run
entry 2: proven in the tree: "via Deno"
```

`verify.ts` keeps the checkpoint it verified in `.last-checkpoint`, and on the next run proves that
the log only grew since: that is how a client notices a log that rewrote its history. To watch a
log continuously, point [`../monitor`](../monitor) at it.

**Any other SQLite.** `src/runtime/` opens the runtime's built-in SQLite; any adapter from
`webtessera/storage/sqlite` works in its place: `fromLibsql(client)` for libSQL or Turso,
`fromRqlite({ url })` for rqlite, `fromD1(env.DB)` for Cloudflare D1 (see
[`../edge`](../edge) for this server as a Worker). [Choosing storage](../../docs/guides/choosing-storage.md)
compares them.

## Check it with Tessera's Go client (optional)

```sh
node scripts/verify_go.ts
```

starts the server on a temporary database, appends 300 entries (a full tile and bundle, and a
partial one), and runs [`go/main.go`](go/main.go), which verifies the checkpoint and an inclusion
proof for every entry with `github.com/transparency-dev/tessera/client`, the upstream Go code. It
needs Go and the pinned upstream checkout (`node scripts/fetch-upstream.mjs` at the repository
root), so it is not part of `ci`. The same program checks a running server, such as the
three-runtime log above:

```console
$ cd go && go run . -log http://127.0.0.1:8082/ -vkey "$LOG_VKEY"
verify-go: OK: checkpoint of 5 entries signed by localhost/my-log; every entry proven with Tessera's Go client
```

## Trust model

- **The log's key** is the one secret. Whoever holds `LOG_SKEY` can sign checkpoints; clients trust
  nothing the server says that the key did not sign. `importLogKey` holds it as a non-extractable
  WebCrypto key on all three runtimes.
- **Clients verify, they do not trust.** Every entry a client reads is proven against a signed
  checkpoint, and every checkpoint against the last one it saw. A server that drops, changes or
  reorders an entry it already published cannot produce those proofs.
- **What one client cannot see** is a server that shows different histories to different clients
  (a split view). Clients comparing checkpoints, a monitor ([`../monitor`](../monitor)) or witnesses
  cosigning every checkpoint close that gap.
- **Writers are not authenticated** here: anyone may add an entry, as on Tessera's own test
  personalities. Put authentication in front of `POST /add` for a log that should not take
  arbitrary entries.

## Test

```sh
npm run ci        # tsc --noEmit && vitest run
```

[`src/log_server_test.ts`](src/log_server_test.ts) runs on Node against temporary SQLite files:
two "processes" (two connections, two logs) appending to one file under lease locking make one
log with no index handed out twice; the read API's headers and errors; a client that notices a
log that rewrote its history; and a database that refuses a key that did not create its log.
`scripts/smoke.ts` starts the real server on whichever runtime runs it:
`node scripts/smoke.ts`, `bun scripts/smoke.ts`, `deno run -A scripts/smoke.ts`.

## Files to read first

1. [`src/log_server.ts`](src/log_server.ts): the routes, `POST /add` and the read API.
2. [`src/server.ts`](src/server.ts): opening the log with the safe API, with explicit locking.
3. [`src/runtime/`](src/runtime): the only runtime-specific code, one small file per runtime.
4. [`src/client.ts`](src/client.ts): what a client verifies, with `webtessera/client`.
