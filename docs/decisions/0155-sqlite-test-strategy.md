# ADR-0155: Test the SQLite backend on every engine it claims, under production limits, with a live rqlite

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** `storage/posix/files_test.go` (ported, for the driver, in
  `src/storage/objectstore/driver_test.ts`); no upstream counterpart for the engines

## Context

"Works with any SQLite" is a claim about eight engine configurations, three JavaScript runtimes, a browser,
workerd and a distributed database. Local engines enforce none of the production limits that matter (miniflare
does not cap D1 rows at 2 MB; node:sqlite accepts a billion bytes), and the in-process engines run every batch
synchronously, so they cannot exhibit the races asynchronous engines can (ADR-0152's release race was found on
rqlite). AGENTS.md §8 requires every backend to pass the shared conformance suite, and the golden suite
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

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

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
