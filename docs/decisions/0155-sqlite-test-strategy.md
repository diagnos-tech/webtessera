# ADR-0155: Test the SQLite backend on every engine it claims, under production limits, with a live rqlite

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files_test.go` (ported, for the driver, in
  `src/storage/objectstore/driver_test.ts`); no upstream counterpart for the engines

## Context

"Works with any SQLite" is a claim about eight engine configurations, three JavaScript runtimes, a browser,
workerd and a distributed database. Local engines enforce none of the production limits that matter (miniflare
does not cap D1 rows at 2 MB; node:sqlite accepts a billion bytes), and the in-process engines run every batch
synchronously, so they cannot exhibit the races asynchronous engines can (ADR-0152's release race was found on
rqlite). PORTING.md §8 requires every backend to pass the shared conformance suite, and the golden suite
(ADR-0160) holds every backend to byte-identity with Tessera's POSIX driver.

## Decision

Every engine runs the same four shared suites: `describeObjectStoreConformance`, `describeDriverConformance`
(with `reopen` returning a second store over a second handle: the same SqlDatabase for local locking, another
connection, client or isolate for lease locking), `describeGoldenCompatibility` (with `listKeys` reading the
objects table through `hex(key)`), and the backend's own `describeSqliteBehaviour` (`testing/behaviour.ts`:
13 `deletePrefix` boundary cases, chunk thresholds, stale chunks, `create` on chunked objects, subarray
inputs, clock-stamped `modTime`, namespaces, ill-formed keys, corruption detection).

| Runner | Engine configurations |
| --- | --- |
| Node (`*_test.ts`) | node:sqlite in memory, file, file + namespace, lease (other process), lease (second connection to a file), 4 KiB chunks under D1 limits, lease under D1 limits; libSQL in memory, file, lease (second client), lease under D1 limits; rqlite against an in-process fake of its HTTP API |
| Chromium (`*_browser_test.ts`) | sqlite-wasm in memory, lease, 4 KiB chunks under D1 limits |
| workerd (`*_workers_test.ts`) | D1 (lease, one namespace per store), D1 with 4 KiB chunks under D1 limits; SQLite-backed Durable Object (local), and with 4 KiB chunks under production limits |
| Services (`*_services_test.ts`) | rqlite at `RQLITE_URL`, one namespace per store; fails, never skips, without it |

Beyond the shared suites:

- `StrictSqlDatabase` (`testing/strict.ts`) wraps any SqlDatabase and rejects what D1 and Durable Objects
  would: a value or row over 2,000,000 bytes, SQL over 100 KB, more than 100 parameters, transaction control in
  a statement; and what any adapter would: numbered placeholders, or a placeholder count that differs from the
  parameters. It also counts batches and statements.
- `lease_test.ts` drives leases between stores that share a database but no memory: exclusion, a stalled holder
  fenced out after takeover (all three write kinds), every write of a store with a lapsed lease fenced, renewal
  keeping a lease alive past its time to live, takeover of a dead holder's lease, abort while polling (no
  further statements, no row left), fail-fast after a renewal finds the lease lost, release deferred until
  fenced writes in flight have settled, release on throw; once on an injected clock and once on the database's
  clock in real time. The fencing tests were checked to fail with the fence disabled, and the in-flight test
  with the deferral disabled.
- `keys_test.ts` checks `prefixRange` against `startsWith` on 20,000 random strings over UTF-8 and UTF-16
  encoding edges.
- `schema_test.ts`: table names, concurrent creation, refusal of a newer schema, an injected migration applied
  once under concurrent openers, a failing migration.
- Each adapter's own tests: pragmas raised and left alone, memoization, a better-sqlite3-shaped statement API
  (`reader`, `run`), structural assignment of the real engine types (`D1Database`, `DurableObjectStorage`,
  `@libsql/client`'s `Client`, sqlite-wasm's `DB`), rqlite's wire format (hex BLOB parameters, base64 results,
  errors in results, HTTP errors, refused hex-literal strings), and sqlite-wasm's fail-closed VFS detection.
- `testing/concurrent.ts` appends from three drivers on separate handles at once and then verifies distinct
  indices, the signed checkpoint, every inclusion proof and `fsck`: on node:sqlite (three connections to one
  file), D1 and live rqlite.
- The Durable Object driver tests ported from the old backend: resume after a reset, publication after a reset,
  publication between requests, and no timers left after shutdown (graceful eviction succeeds).
- `scripts/smoke-sqlite.mjs` runs the built package end to end on the runtime's own SQLite: node:sqlite under
  Node and Deno, bun:sqlite under Bun.

## Consequences

- The Node suite needs no services; the services suite needs one rqlite node (CI can start the
  `rqlite/rqlite` container).
- better-sqlite3 is not installed, so it is exercised only through a stand-in of its statement API; the
  structural interface was written against its documented API.
- The test files import `node:sqlite`, `node:fs` and `node:os`, declared minimally in `testing/node.d.ts`
  because the repository deliberately installs no `@types/node`.

## Alternatives considered

- **Fakes instead of miniflare and Chromium.** They would not catch engine differences such as node:sqlite's
  NULL empty BLOB or rqlite's rebinding of hex-literal strings; the real engines are cheap to run.
- **Skipping the services suite without `RQLITE_URL`.** A skipped suite reads as green; failing names what is
  missing.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Checked the test table against the files. Node: eight node:sqlite variants in `sqlite_test.ts` (memory, file, file + namespace, lease from another process, lease on a second connection, default options on a second connection, 4 KiB chunks under D1 limits, lease under D1 limits), four libSQL variants, rqlite against `testing/fake_rqlite.ts`; Chromium: three sqlite-wasm variants; workerd: D1 (two variants) and Durable Object (two); services: rqlite, failing rather than skipping without `RQLITE_URL`. Every engine runs conformance, driver conformance, behaviour and (in the `*golden*` files) the golden suite. `StrictSqlDatabase` does what the ADR lists and its limits match Cloudflare's D1 and Durable Object limits pages. `lease_test.ts`, `keys_test.ts`, `schema_test.ts`, `concurrent.ts` and the Durable Object driver tests exist as described (the four DO tests: resume after reset, publish after reset, publish between requests, no timers after shutdown).
  - Ran, not taken from the author: `vitest` over `src/storage/sqlite src/http src/witness src/mirror` (22 files, 989 tests pass), `src/storage/objectstore src/storage/indexeddb src/storage/memory` (9 files, 286 pass), the workerd config (8 files, 300 pass) and the Chromium config (8 files, 265 pass). The live rqlite suite passes against a real rqlite 9.4.5 node I started for the purpose (79 tests); the mutation checks the ADR says were done (fence disabled, in-flight deferral disabled) fail the tests as stated.
  - The ADR is honest that better-sqlite3 is exercised only through a stand-in; I additionally ran the suites against the real better-sqlite3 (see ADR-0150's notes) and they pass.
  - Non-blocking: the ADR names `pnpm test:services` and `pnpm interop`; the scripts are now `bun run test:services` and `bun run interop` (ADR-0240). That is history, not an error, but `docs/` text that quotes these should use the Bun forms.
  - Not verified: the browser tests on a real multi-tab OPFS database (not tested by the suite either); Deno.
  - Alternatives hold (fakes, skipping the services suite). Status: proposed becomes accepted.

## Update (2026-10-03)

Tests added with the security-review fixes (ADR-0210 to ADR-0213):

- **Several processes on one file:** `sqlite_test.ts` spawns three Node processes
  (`testing/append_process.ts`, which Node runs from source by stripping its types) that append 100
  entries each to one file with default options, then checks distinct indices, the checkpoint's size and
  `fsck`. It is the one test that tells local from lease locking across processes: it fails with the
  default forced back to local, and it found the busy-timeout bug (ADR-0153's update).
  `testing/node.d.ts` declares the few `node:process` and `node:child_process` members it uses.
- The Node table gains "node:sqlite file, default options, second store on a second connection", which runs
  the conformance suites, "never assigns an index twice when two drivers share a store" included, with no
  locking chosen; and two witness servers on two connections to one file race, with exactly one success.
- `describeSqliteBehaviour` gains a fenced-write case (every write kind refused once another holder took
  the lock over, nothing written, no fence row), so the NOT NULL fence is recognised on every engine:
  node:sqlite, libSQL, rqlite (fake and live), sqlite-wasm, D1 and Durable Objects. `lease_test.ts` runs
  the same refusal on a connection with `PRAGMA ignore_check_constraints = ON`.
- `schema_test.ts`: schema version 2, the version 1 to 2 migration under concurrent openers with both fences
  holding, and UTF-16le and UTF-16be databases refused before any table is created.
- Adapter defaults: `sync_test.ts` checks the default against node:sqlite's `location()` for five kinds of
  database; `libsql_test.ts` an in-memory client, a file client, an embedded-replica stand-in and a remote
  client. `rqlite_test.ts` checks the read level and the request policy, and `rqlite_workers_test.ts` and
  `src/mirror/s3_workers_test.ts` that workerd accepts the requests the rqlite adapter and the S3 sink make.
- The live rqlite suite (`pnpm test:services` against rqlite 9.4.5) found that the first form of the
  encoding check read back BLOB expressions, which rqlite returns as text; the check now compares in SQL.

*Review of this update: approved, ADR reviewer (independent), 2026-10-04. Verified by running: the three-process test (`sqlite_test.ts`) appends 100 entries each to one file with default options and checks distinct indices, checkpoint size and fsck, and passes; with a scratch copy of its child script forced to `locking: "local"` I got 200 distinct indices out of 300, so the setup does distinguish the modes. `sync_test.ts` checks five kinds of database against `location()`, `libsql_test.ts` an in-memory client, a file client, an embedded-replica stand-in and a remote one, `schema_test.ts` the version 1 to 2 migration and both UTF-16 encodings, `rqlite_workers_test.ts` and `src/mirror/s3_workers_test.ts` workerd's acceptance of the requests (mutating the adapter to `redirect: "error"` makes the workerd test fail with workerd's `Invalid redirect value` message). Gap that the new tests leave: the multi-process test covers node:sqlite only; a libSQL `file:` multi-process test would have found the SQLITE_BUSY failure described in my review of ADR-0210.*

## Update (2026-10-04): commands, and the multi-process test's engines

- Since ADR-0240, `pnpm test:services` and `pnpm interop` in this ADR read `bun run test:services` and
  `bun run interop`.
- The three-process append test is now shared, as `testing/processes.ts`, and `testing/append_process.ts` takes an
  engine argument. It covers node:sqlite (`sqlite_test.ts`) and libSQL with a busy timeout (`libsql_test.ts`).
  The review of the update above names this as the gap that ADR-0210's review found; ADR-0210's 2026-10-04 update
  explains it.

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. `package.json` has `test:services`
(`vitest run --config vitest.services.config.ts`) and `interop` (`node scripts/interop.mjs`), run as `bun run ...` under ADR-0240; the
two `pnpm` spellings are in the Decision's history (lines 87 and 114). `testing/processes.ts` exports `appendFromProcesses(engine, path, perProcess,
reopen)`, which spawns three Node children of `testing/append_process.ts`, whose first argument is the engine (`"node:sqlite"` or
`"libsql"`, the latter `createClient({ url: "file:...", timeout: DefaultBusyTimeoutMs })`); `sqlite_test.ts` and `adapters/libsql_test.ts` each call it
("keeps one consistent log when processes append to one file with default options"). I ran both cases: 2 passed. `libsql_test.ts` also asserts the adapter's
error for a client with no busy timeout, which names `createClient({ url, timeout: 5000 })`. ADR-0210 has an Update dated 2026-10-04, "libSQL `file:`
clients shared by several processes", which is where the gap is explained. The multi-process test still covers only these two engines, which the Update says.
