# ADR-0155: Test the SQLite backend on every engine it claims, under production limits, with a live rqlite

- **Status:** proposed
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

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**
