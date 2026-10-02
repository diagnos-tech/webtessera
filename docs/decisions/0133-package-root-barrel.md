# ADR-0133: The package root re-exports Tessera's root package, plus the names TypeScript needs to express it

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Claude
- **Upstream reference:** the exported identifiers of package `tessera` at `4a6d9f9`: `append_lifecycle.go`, `await.go`, `ct_only.go`, `entry.go`, `lifecycle.go`, `log.go`, `migrate_lifecycle.go`, `witness.go`

## Context

In Go the package is the unit of import: `tessera.NewAppender`, `tessera.NewEntry` and the rest are all
visible to a caller because they are exported from package `tessera`, whichever file declares them. The port
mirrors the file layout (`src/append_lifecycle.ts`, `src/entry.ts`, ...), and a TypeScript module's exports are
per file, so something has to play the part of the package clause. `package.json` already maps `"."` to
`dist/index.js`; the subpath barrels (`src/client/index.ts`, `src/api/layout/index.ts`, `src/fsck/index.ts`,
`src/vendor/formats/log/index.ts`) exist and `src/index.ts` did not.

The difficulty is that "everything the files export" is the wrong set. Several modules export identifiers that
Go keeps unexported, solely so the port's tests can reach them, the pattern
[ADR-0010](0010-package-private-members.md) and [ADR-0044](0044-ct-only-partial-port.md) establish and whose
doc comments say "not re-exported from any barrel": `identityHash`, `defaultIDHasher`,
`defaultMerkleLeafHasher`, `memoizeFuture`, `convertCTEntry`, `ctEntriesPath`, `ctBundleIDHasher`,
`ctMerkleLeafHasher`, the `copy*` helpers, `awaitFollower`, `progress`, `newInMemoryDedup`, `newCopier`,
`populateWork` and `Copier`. A blanket `export *` would publish all of them as API.

## Decision

`src/index.ts` re-exports, by name, exactly the 37 identifiers that package `tessera` exports in non-test
files (enumerated by parsing the upstream source, not read off by eye), under the names
[ADR-0002](0002-file-and-identifier-naming.md) gives them:

- the eight `Default*` constants, `newAppender`, `newAppendOptions`, `AppendOptions`, `Appender`,
  `WitnessOptions`, and the types `AddFn`, `Index`, `IndexFuture`;
- `newPublicationAwaiter`, `PublicationAwaiter`;
- `newCertificateTransparencyAppender`;
- `newEntry`, `Entry`;
- the types `Antispam`, `Follower`, `LogReader`;
- `Driver`, `ErrPushback`, `ErrPushbackAntispam`, `ErrPushbackIntegration`;
- `newMigrationOptions`, `newMigrationTarget`, `MigrationOptions`, `MigrationTarget`;
- `newWitness`, `newWitnessGroup`, `newWitnessGroupFromPolicy`, `Witness`, `WitnessGroup`.

Six further names are exported because the contract Go expresses implicitly needs them in TypeScript. Each is
an addition to upstream's surface, which is why this ADR exists:

| Name | Why Go does not need it |
| --- | --- |
| `withCTLayout` | Go's two `WithCTLayout` *methods* are not package-level identifiers; this is their free-function form ([ADR-0079](0079-migrationoptions-withctlayout-is-a-function.md), [ADR-0130](0130-ct-only-port-completed.md)). |
| `AppendLifecycle` (type) | Go's driver-side `appendLifecycle` is a local interface a driver satisfies by type assertion. The port needs a name for a driver author to implement against ([ADR-0083](0083-append-lifecycle-structural-mappings.md)). |
| `AppenderInit` (type) | What that interface's method returns; Go returns three positional values. |
| `NewAppenderResult` (type) | What `newAppender` returns; Go returns four positional values ([ADR-0031](0031-multi-value-returns.md)). Without the name a caller cannot annotate it. |
| `ErrNotExist` | Go's `os.ErrNotExist`, which the contract is written in terms of: `LogReader.readCheckpoint` must report it when no checkpoint exists. A personality wrapping or implementing a `LogReader` needs the sentinel. |
| `errorIs` | Go's `errors.Is`. `ErrPushback` is documented as "check for this error, wrapped or not, using `errors.Is`", and `ErrPushbackAntispam` and `ErrPushbackIntegration` wrap it through `cause`, so `===` is not enough. |

Nothing else is re-exported. `src/index_test.ts` writes the sorted list of runtime export names out in full, so
that any addition or removal shows up in review as a change to the test; it checks the type-only names with
the compiler (`expectTypeOf`), checks each of the 37 Go identifiers against the barrel, and asserts by name that
none of the test-only helpers above leak. The module-level comment documents the entry points and their
subpaths (`webtessera/client`, `webtessera/storage/*`, `webtessera/api`, ...) and the naming conventions, for
readers who arrive from the Go documentation.

## Consequences

- `import { newAppender, newEntry } from "webtessera"` works, and the surface is reviewable in one place.
- `ErrNotExist` and `errorIs` are now public API, though they are defined in `src/internal/gostd/`. Their
  definitions are not renamed or moved; the barrel only re-exports them. They are two names that exist because
  Go's standard library supplies them for free, so any consumer of Tessera needs them from somewhere.
- Any new export from the root is a deliberate act: the explicit array in `index_test.ts` fails until it is
  edited. The cost is that adding a legitimate export touches two files.
- `docs/PORTING-MAP.md` has no row for `src/index.ts`, since it has no upstream file; it belongs with the other
  barrels as a file with no Go counterpart.
- Storage drivers are intentionally not exported from the root, so that a consumer that uses one driver does
  not carry the others. They are reached through `webtessera/storage/<driver>` subpaths, whose entries in
  `package.json` `exports` are separate work.

## Alternatives considered

- **`export * from` each module.** Rejected: it publishes the test-only exports listed above, and silently
  publishes any later addition to a module, which is the accidental API change `index_test.ts` exists to stop.
- **Strictly Go's 37 identifiers plus `withCTLayout`.** Rejected for the two error names, and for the three
  types, which a driver author cannot do without: no public path reaches `src/internal/gostd/`, so a
  consumer could not obtain `ErrNotExist` or follow a `cause` chain at all.
- **Put `ErrNotExist` and `errorIs` in their own subpath, e.g. `webtessera/errors`.** A reasonable alternative
  and the easiest one to move to later: they are two lines in the barrel and one array entry. Kept at the root
  because that is where the Go documentation for `ErrPushback` sends a reader, and a personality needs them
  at the call site that handles `newAppender`'s futures. Left for the reviewer to overrule.
- **Not adding `AppendLifecycle`, `AppenderInit` and `NewAppenderResult`.** They are types only, with no runtime
  cost, and without them `Awaited<ReturnType<typeof newAppender>>` is the only way to name what `newAppender`
  returns.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
