# ADR-0105: Test the migration lifecycle end to end against the ObjectStore driver, closing ADR-0074

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/posix/files.go` (`MigrationWriter`, `MigrationStorage`), `migrate.go`,
  `migrate_lifecycle.go`, `integration/integration_test.go`

## Context

[ADR-0074](0074-migrate-untestable-without-driver.md) recorded that, with no storage driver in the port, two
parts of the migration lifecycle could not be tested without inventing a fake driver:

- `newMigrationTarget`'s success path, a real driver's `migrationWriter` returning a working
  `MigrationWriter`/`LogReader` pair;
- `MigrationTarget.migrate` end to end: the copier fetching a real source log's bundles, a driver integrating
  them, `awaitIntegration` waiting on real progress, and the final root-hash comparison.

It named the memory driver as the natural place to close that gap. The ObjectStore driver now implements the
migration target (`ObjectStoreDriver.migrationWriter`, `MigrationStorage`, ported from `files.go`), and
`MemoryObjectStore` is its reference backend.

## Decision

`src/storage/objectstore/driver_migration_test.ts` drives the real lifecycle with no fakes on the target
side: `newMigrationTarget(newObjectStoreDriver({ store }), newMigrationOptions())` and
`MigrationTarget.migrate(4, size, root, getEntries)`. The source logs are `fixtures/data/log_<N>.json`, written
by the real Go POSIX driver, whose entry bundles are served to the copier through `partialOrFullResource` as
an HTTP fetcher would serve them. The cases:

- migrating `log_0`, `log_1`, `log_257` and `log_5000` into an empty store succeeds (so the locally computed
  root equals the fixture's) and leaves exactly the fixture's tiles and bundles, byte for byte;
- migrating `log_5000` into a store already holding `log_1000` fetches only the bundles beyond the target's
  tree and converges on `log_5000`'s resources;
- a wrong source root fails with upstream's `migration completed, but local root hash ... != source root hash
  ...`;
- a migration target publishes no checkpoint, so its reader reports `ErrNotExist`.

`testing/driver_conformance.ts` repeats a migration on every backend ("migrates a log into an empty store").
ADR-0074 itself is not edited; this ADR supersedes its "Not covered" list for the two items above.

## Consequences

- Both gaps ADR-0074 listed are closed against a real driver and real Go-written source data, which is what
  that ADR's review asked of the first driver to land. `docs/PORTING-MAP.md`'s `migrate.go` and
  `migrate_lifecycle.go` rows can drop their "end-to-end coverage deferred" caveat.
- What ADR-0074 listed as its third item, witnessing against a real witness server, remains out of scope; it
  concerns `internal/witness`, not migration.
- Each migration takes at least a second, because `MigrationStorage.awaitIntegration` polls once a second as
  `files.go` does; the cases run concurrently.
- The antispam-populating path (`MigrationOptions.withAntispam`) is still untested end to end: the port has no
  persistent `Antispam` implementation to drive it with.

## Alternatives considered

- **Source logs built by this driver** rather than Go fixtures. Rejected for the main cases: a Go-written
  source proves the target reproduces upstream's tree, not merely its own. The conformance suite does build its
  source in memory, because there the backend under test is the target.
- **Shorten `awaitIntegration`'s poll interval for tests.** Rejected: it would mean a test-only knob on a
  ported type to save a second per case.

## Review

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - The tests do what the ADR says. `driver_migration_test.ts` drives `newMigrationTarget(newObjectStoreDriver({ store }),
    newMigrationOptions())` and `migrate(4, size, root, getEntries)` with the real `MigrationStorage`; the sources are the
    Go-written `log_<N>` fixtures served through `partialOrFullResource`; the cases are as listed (log_0, 1, 257 and 5000
    reproducing tiles and bundles byte for byte; log_1000 continued to log_5000, fetching only bundles 3 to 19; a wrong
    root failing with `migration completed, but local root hash ... != source root hash ...`, which is `migrate_lifecycle.go`
    line 182 verbatim; no checkpoint published, reader reports `ErrNotExist`). They pass, as does the conformance
    suite's "migrates a log into an empty store" on every backend I ran. The PORTING-MAP rows were updated as the
    Consequences say.
  - **Wrong citation, must be fixed.** The Upstream reference lists `integration/integration_test.go`. At 4a6d9f9 nothing
    in `integration/`, in any `*_test.go`, or in `.github/workflows` touches migration (`grep -i migrat` finds only
    non-test files, and `integration_test.go` is `TestLiveLogIntegration`, which adds entries over HTTP and verifies
    proofs). Upstream has no migration test at all, so this ADR adds coverage rather than porting it. The same mistaken
    premise sits in ADR-0074 ("exercised by Tessera's `integration/` end-to-end suite") and in the header of
    `driver_migration_test.ts` ("Upstream covers the same ground in its `integration/` suite"); ADR-0074 and the code are
    not this ADR's to edit, but this ADR must drop the reference and say that upstream has no such test.
  - The remaining claims check out: each migration takes at least a second (`awaitIntegration` polls once a second, as
    `files.go` does); the antispam-populating path is untested end to end.

## Update (2026-10-04): the upstream reference is dropped

This answers the Review above. Upstream has no migration test at 4a6d9f9. Nothing in `integration/`, in any
`*_test.go` or in `.github/` mentions migration. `grep -ril migrat` over the test files and workflows finds
nothing. `integration/integration_test.go` is `TestLiveLogIntegration`, which only appends to and verifies a live
log. That file should be read as removed from this ADR's Upstream reference, and the tests this ADR describes add
coverage rather than port it. The same premise is corrected:
- in ADR-0074, by an update note;
- in the header of `src/storage/objectstore/driver_migration_test.ts`, which now says that upstream has no test
  of the migration lifecycle.
