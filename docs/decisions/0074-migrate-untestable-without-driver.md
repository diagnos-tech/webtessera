# ADR-0074: What `migrate.ts`/`migrate_lifecycle.ts` cannot be tested until a storage driver exists

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate contributor
- **Upstream reference:** `migrate.go`, `migrate_lifecycle.go`, `integration/integration_test.go`

## Context

Upstream has no `migrate_test.go` or `migrate_lifecycle_test.go`. `migrate.go`/`migrate_lifecycle.go`
are exercised by Tessera's `integration/` end-to-end suite, which drives a real storage `Driver`
(POSIX in CI) through a real `MigrationTarget` against a real source log. `PORTING.md`'s `docs/PORTING-MAP.md`
lists every driver (`storage/{posix,aws,gcp,mysql}` and this port's own planned
`storage/{memory,indexeddb,durableobject,s3}`) as `pending ADR` or `not started` — Wave 4's job, not
this work package's. `PORTING.md` §4 forbids inventing a fake driver to force coverage of code that
upstream itself only tests against a real one; the mission brief for this work package repeats that
instruction explicitly.

## Decision

Coverage is split along the boundary between what depends on a `Driver`/`MigrationWriter` actually
persisting and integrating data, and what does not:

**Covered by fresh tests in this landing** (`src/migrate_test.ts`, `src/migrate_lifecycle_test.ts`):

- `populateWork`'s chunking arithmetic (`migrate_test.ts`'s `describe("populateWork", ...)`) — the
  mission brief calls this out by name as the highest-risk-of-an-off-by-one code in this package.
- `Copier.copy`'s full worker-orchestration *logic* — chunk distribution across concurrent workers,
  the `fromSize > sourceSize` guard, seeding `_bundlesCopied` from a resumed count, and the
  retry-with-backoff path (success after transient failures, and exhausting all retries) — driven
  against in-memory fakes of `EntryBundleFetcherFunc`/`setEntryBundleFunc`. These are 2-argument,
  3-argument function *types*, not a storage `Driver`; faking a function is not "inventing a fake
  driver" in the sense the mission brief warns against.
- `progress()`'s formatting, including the `total == 0` NaN/+Inf edge cases Go's `%.2f` verb renders
  differently from JavaScript's `toFixed`.
- `awaitFollower`'s polling loop (catch-up detection, tolerating a transient `entriesProcessed()`
  error, stopping on `AbortSignal`) — driven against a minimal fake `Follower` (three methods: `name`,
  `follow`, `entriesProcessed`), not a driver.
- `MigrationOptions`'s pure accessors (`entriesPath()`, `leafHasher()`) and `withAntispam`'s
  followers-list mutation, against a minimal fake `Antispam`.
- `newMigrationTarget`'s **rejection** path: a plain object without a `migrationWriter` method proves
  the `d.(migrateLifecycle)`-equivalent type guard (`hasMigrationWriter`) correctly refuses it. This
  needs no driver at all, fake or real.

**Not covered, and will not be until Wave 4 lands a driver:**

- `newMigrationTarget`'s **success** path — calling a real driver's `migrationWriter` lifecycle
  method and receiving back a working `MigrationWriter`/`LogReader` pair.
- `MigrationTarget.migrate`'s full, real orchestration: a `Copier` actually fetching bundles from one
  log and a driver actually integrating them, `awaitIntegration` genuinely blocking on real
  integration progress, and the final root-hash comparison against bytes a real tree produced. A
  fake `MigrationWriter` returning canned bytes would let this "pass" while verifying nothing about
  whether a real migration is correct — exactly the vacuous-coverage failure mode
  `docs/REVIEW-PROTOCOL.md` §2.3 warns reviewers to look for.
- End-to-end interop with `internal/witness`'s `WitnessGateway` and a *real* witness HTTP server (this
  work package's own `internal/witness/witness_test.ts` covers the HTTP protocol against a mocked
  `FetchFn`, which is a different, already-testable boundary — see that file's own header comment).

## Consequences

- `docs/PORTING-MAP.md`'s rows for `migrate.go`/`migrate_lifecycle.go` are marked `done` for the code
  itself (every exported symbol ported, declaration order preserved, comments carried over) but their
  `notes` column names this ADR and states plainly that end-to-end coverage is deferred to Wave 4.
- Whoever lands the first storage driver (the mission brief names `storage/memory` as the natural
  reference driver) inherits the job of writing the real `MigrationTarget.migrate` integration test
  this ADR could not — it should drive a real source log's entry bundles into a fresh driver and
  assert the resulting root hash matches, mirroring upstream's own `integration/integration_test.go`
  shape.
- This is the same shape of gap `docs/decisions/0058-readme-test-fully-blocked-on-appender.md` already
  documents for `README_test.go`, and the same judgement call `docs/decisions/0056-future-ported-ahead-of-schedule.md`
  and `docs/decisions/0044-ct-only-partial-port.md` make elsewhere in this codebase: port and test
  everything reachable now, name exactly what is not, rather than inventing scaffolding to manufacture
  a passing test.

## Alternatives considered

- **A minimal in-memory `Driver`/`MigrationWriter` implementation, built just for this test.**
  Rejected by the mission brief's own explicit instruction ("do not invent a fake driver to force
  coverage"), and for the reason `docs/REVIEW-PROTOCOL.md` gives generally: a test built entirely by
  and for the code under test proves the two agree with each other, not that either is correct.
- **Wait for Wave 4 before landing `migrate.ts`/`migrate_lifecycle.ts` at all.** Rejected: both files
  are explicitly this work package's assigned mission, the pure logic they contain is real,
  substantial, and independently testable (as this ADR demonstrates), and deferring them would mean
  reporting the assignment incomplete for a dependency (a storage driver) this work package has no
  authority to build.

## Review

- **Reviewer:** Witness/Migrate Reviewer
- **Verdict:** approved
- **Notes:** The covered/not-covered split is honest and matches the code. Confirmed
  `migrate_test.ts` genuinely tests `populateWork`'s chunking (boundary cases at 256/257/513,
  resume-at-full-tile-boundary, resume-mid-bundle) and `Copier.copy`'s worker orchestration
  against function fakes — the "copies every bundle in [from,sourceSize) exactly once across 4
  workers" case keys stored bundles by index and asserts `size === want.length`, which is what
  actually catches a double-processed or skipped item (the shared-generator invariant, ADR-0077).
  `migrate_lifecycle_test.ts` covers `progress()` (incl. `total==0` → `NaN%`/`+Inf%`, Go's `%.2f`
  on NaN/+Inf), `awaitFollower`'s polling loop (catch-up, transient-error tolerance, abort-stop),
  `MigrationOptions` accessors + `withAntispam`, and `newMigrationTarget`'s type-guard rejection.
  The genuinely-deferred parts — `newMigrationTarget`'s success path and `MigrationTarget.migrate`'s
  real copy+integrate+root-compare — are exactly the ones that would be vacuous against a canned
  fake `MigrationWriter`, so deferring them to Wave 4 (rather than manufacturing a passing test) is
  the right call and correctly matches REVIEW-PROTOCOL §2.3. Wave 4 inherits the integration test.

## Update (2026-10-02)

`progress()` and its tests are deleted (ADR-0181). `migrate_lifecycle_test.ts` now also drives
`newMigrationTarget` and `migrate` with a stub `MigrationWriter` that has nothing to copy, to pin
how followers are started (ADR-0180) and which followers a target takes from its options.

## Update (2026-10-04): upstream has no migration test

The Context said that these paths "are exercised by Tessera's `integration/` end-to-end suite", and the Upstream
reference lists `integration/integration_test.go`. Neither holds at 4a6d9f9. Nothing in `integration/`, in any
`*_test.go` or in `.github/` mentions migration. `grep -ril migrat` over the test files and workflows finds
nothing, and `integration_test.go` is `TestLiveLogIntegration`, which appends to a live log over HTTP and verifies
it. So the port's migration tests (ADR-0105) add coverage that upstream does not have, rather than port it. The
reference to `integration/integration_test.go` should be read as dropped. The header of
`src/storage/objectstore/driver_migration_test.ts`, which repeated the premise, has been corrected. ADR-0105's
review found this.
