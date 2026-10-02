# ADR-0076: `internal/migrate/migrate.go` ported alongside `migrate_lifecycle.ts`

- **Status:** accepted
- **Date:** 2026-08-19
- **Author:** witness/migrate agent
- **Upstream reference:** `internal/migrate/migrate.go`

## Context

`migrate_lifecycle.go` imports `github.com/transparency-dev/tessera/internal/migrate` for the
`MigrationWriter` interface a storage `Driver` must implement to be a valid migration target:

```go
type MigrationWriter interface {
    SetEntryBundle(ctx context.Context, idx uint64, partial uint8, bundle []byte) error
    AwaitIntegration(ctx context.Context, size uint64) ([]byte, error)
    IntegratedSize(ctx context.Context) (uint64, error)
}
```

`docs/PORTING-MAP.md` already carries a row for `internal/migrate/migrate.go` → `src/internal/migrate/migrate.ts`
(`not started`), but this exact file is not named in this work package's assigned list
(`AGENTS.md`'s table: `witness.go`, `witness_test.go`, `witness_policy_test.go`,
`internal/witness/witness.go`, `internal/witness/witness_test.go`, `migrate.go`,
`migrate_lifecycle.go`). Without it, `src/migrate_lifecycle.ts` cannot compile at all —
`NewMigrationTarget`'s local `migrateLifecycle` interface and `MigrationTarget`'s `writer` field are
both typed in terms of `migrate.MigrationWriter`.

## Decision

`src/internal/migrate/migrate.ts` is ported now, as a three-method interface with no logic and no
Go test file to port (`internal/migrate` has no `migrate_test.go`). This is the same judgement call
`docs/decisions/0056-future-ported-ahead-of-schedule.md` made when `storage/internal/queue.ts` needed
`internal/future/future.go` before the `client` work package that formally owned it had landed: a
small, self-contained, interface-only dependency is ported by whichever work package hits the need
first, rather than blocked on ownership sequencing.

`docs/PORTING-MAP.md`'s row moves from `not started` to `done`, naming this ADR.

## Consequences

- Nothing for a future agent to reconcile: the interface is complete (all three Go methods present,
  same names camelCased, same parameter shapes under ADR-0003's `uint64`→`bigint` mapping), and
  nothing else in Tessera's `internal/migrate` package exists to port later.
- `Driver`/storage-driver work (Wave 4) implementing `MigrationWriter` for a real backend imports this
  file directly; no interface shape decisions are left open for it.

## Alternatives considered

- **Inline the interface directly into `migrate_lifecycle.ts`** instead of a separate file. Rejected:
  `AGENTS.md` §3.1's file-name fidelity is this port's main reviewability asset — a transparency-dev
  reviewer who knows `MigrationWriter` is defined in `internal/migrate/migrate.go` should find it at
  `src/internal/migrate/migrate.ts`, not inlined somewhere else because it was convenient mid-port.
- **Leave `migrate_lifecycle.ts` unported until the `internal/migrate` package's formal owner lands
  it.** Rejected: `migrate_lifecycle.go` is explicitly this work package's assigned mission, and the
  missing dependency is three method signatures long — deferring the whole file for that would mean
  reporting the assignment incomplete over an easily-isolated, non-controversial interface port.

## Review

- **Reviewer:** Witness/Migrate Reviewer (agent)
- **Verdict:** approved
- **Notes:** Diffed `src/internal/migrate/migrate.ts` against `internal/migrate/migrate.go` (read in
  full). All three methods present and faithful under the mappings: `SetEntryBundle(ctx, idx uint64,
  partial uint8, bundle []byte) error` → `setEntryBundle(idx: bigint, partial: number, bundle:
  Uint8Array, signal?): Promise<void>`; `AwaitIntegration(ctx, size uint64) ([]byte, error)` →
  `awaitIntegration(size: bigint, signal?): Promise<Uint8Array>`; `IntegratedSize(ctx) (uint64,
  error)` → `integratedSize(signal?): Promise<bigint>`. Every upstream doc comment carried over
  (idempotency note, "any order", "block until"). No upstream `migrate_test.go`, so none to port.
  Interface-only, nothing for a Wave-4 driver to reconcile. Same ahead-of-schedule precedent as
  ADR-0056, applied identically.
