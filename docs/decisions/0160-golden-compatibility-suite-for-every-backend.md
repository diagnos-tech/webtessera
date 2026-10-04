# ADR-0160: Hold every storage backend to Tessera's bytes with one shared golden suite

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go`, `fixtures/gen/log.go` (which drives it)

## Context

`fixtures/data/log_<N>.json` holds complete logs written by Tessera's own POSIX driver. Until now only
`driver_fixtures_test.ts` compared anything against them, and only over `MemoryObjectStore`, in Node, reading
the store's keys through `MemoryObjectStore.keys()`. The claim the project makes is stronger: that **every**
backend (memory, IndexedDB, the SQLite engines, in Node, in Chromium and in workerd) stores a log that is
byte-for-byte the one Tessera writes, and can carry on a log Tessera wrote. ADR-0106 already chose "one suite for
every backend" for behaviour (`describeDriverConformance`); byte compatibility had no equivalent.

Two constraints shape such a suite. It must run unchanged in three runtimes, so it can use only vitest, library
code and the fixture loader. And the `ObjectStore` contract deliberately has no listing operation (ADR-0101), so
the suite cannot ask an arbitrary backend which keys it holds.

## Decision

`src/storage/objectstore/testing/golden.ts` exports
`describeGoldenCompatibility(name, newStore, { reopen?, listKeys?, sizes?, timeout? })`, documented in its file
header, with its data model in `golden_fixtures.ts` and its log driving in `golden_log.ts`. For every `log_<N>`
fixture it runs:

1. **one batch**: the store holds exactly the fixture's public files and Go's `.state/treeState` and
   `.state/version` (ADR-0161), byte for byte;
2. **batches of 37** (sizes above one tile): the fixture's files plus exactly the superseded partials those batch
   boundaries leave, each holding the prefix POSIX wrote there; after garbage collection, exactly what POSIX's GC
   leaves;
3. **restarts**: one fresh driver per session over a fresh handle (`reopen`), split at and around tile
   boundaries, converging on the same files;
4. **Go-written state continued**: the store preloaded with a smaller fixture's files and `.state/` exactly as Go
   left them; appending the next entries yields the larger fixture.

Which keys a backend holds is established either through `listKeys` (the backend's own listing, preferred) or by
`KeyRecorder`: every write goes through a recording wrapper, and each recorded key is read back from the backend
itself. Superseded partials are checked by content as well as by name: `supersededPartial` derives the expected
bytes from the final tree's resources (a partial version is a prefix of every later version).

Wiring: `driver_fixtures_test.ts` (memory, Node, with `keys()`), `memory_golden_workers_test.ts` (memory,
workerd), `indexeddb_golden_test.ts` (fake-indexeddb, Node) and `indexeddb_golden_browser_test.ts` (Chromium),
the IndexedDB ones listing keys through IndexedDB itself (`indexeddb/testing/keys.ts`). Every runtime runs every
fixture size: the largest takes under two seconds in Chromium.

## Consequences

- A backend is proven byte-compatible by one call. The SQLite engines call the same function.
- Without `listKeys`, the suite cannot see a key a backend invents on its own (it sees keys dropped, left
  undeleted or stored under another name). Backends that can list should pass it; the header says so.
- `memory_golden_workers_test.ts` runs only once `vitest.workers.config.ts` includes `src/**/*_workers_test.ts`,
  as `vitest.config.ts`'s header already documents. Until then it was verified with a temporary configuration.
- The suite reaches `ObjectStoreDriver.garbageCollect`, an `@internal` member, as the `files_test.go` port does,
  because it disables the GC loop to keep the key set deterministic.

## Alternatives considered

- **Add `list(prefix)` to `ObjectStore`** so the suite can enumerate any backend. Rejected for the reasons in
  ADR-0101; an optional test-side `listKeys` gives the same strength where a backend can list.
- **Run the larger sizes only in Node.** Rejected as unnecessary: measured, every size runs in seconds in
  Chromium and workerd, and a size limit would be a gap exactly where backends differ most.
- **Compare superseded partials by name only**, as the previous test did. Rejected: a backend that truncated or
  corrupted a superseded partial would pass, yet clients holding an older checkpoint read those bytes.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Read `golden.ts`, `golden_fixtures.ts`, `golden_log.ts` and the wiring files against the Decision. The four case groups exist as described (one batch per fixture size; batches of 37 above 256; restarts at and around boundaries; eight Go-written-state crossings), the key set comes from `listKeys` or `KeyRecorder` (every key written through the wrapper read back from the backend), superseded partials are compared by content (`supersededPartial` derives the prefix from the final tree's resources), and expectations are derived from the fixtures and layout rules, not from the driver. Wiring: `driver_fixtures_test.ts`, `memory_golden_workers_test.ts`, `indexeddb_golden_test.ts`, `indexeddb_golden_browser_test.ts` (keys via `indexeddb/testing/keys.ts`), and the SQLite files; all pass in Node, Chromium and workerd in my runs.
  - The one claim that rested on reading rather than recorded Go output, "after garbage collection, exactly what POSIX's GC leaves", I checked against the real POSIX driver. Scratch Go program on the pinned checkout (driver run from outside the log directory, batches of 37, GC enabled, `gcState` reached the last full bundle): the files left for 1,000 entries (66 before GC, 26 after) and 5,000 entries (330 and 68) are identical, key for key, to `expectedPublicKeys(fixture, batchEndsOf(0, n, 37), afterGC)`. So the suite's model of POSIX's GC is right; it is not in the repository as recorded evidence (the fixtures and the interop harness both run with GC off, and `gcState` is not compared; the ADR says so for gcState). Recording a GC-on fixture would turn this from reading into evidence; suggestion only.
  - Check of the fixtures the suite leans on: `bun run fixtures`'s generator, run into a scratch directory, reproduces `fixtures/data` byte for byte (`diff -rq` empty over 41 files); commit 670e4c8 added only a `state` key to the eight `log_<N>.json` files (every other key equal).
  - Non-blocking staleness: Consequences say `memory_golden_workers_test.ts` runs only once `vitest.workers.config.ts` includes `*_workers_test.ts`; it now does (it ran in my workerd run). Accurate when written, not now.
  - Alternatives (`list(prefix)` on the contract, Node-only large sizes, comparing partials by name only) are real, and the rejection of name-only comparison is justified: the suite does catch a truncated partial. Status: proposed becomes accepted.

## Update (2026-10-04)

The Consequences sentence on `memory_golden_workers_test.ts` is no longer conditional:
`vitest.workers.config.ts` includes `src/**/*_workers_test.ts`, so the file runs in every `bun run test:workers`.
