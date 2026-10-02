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

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:** pending
