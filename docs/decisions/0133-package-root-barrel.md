# ADR-0133: The package root re-exports Tessera's root package, plus the names TypeScript needs to express it

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
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

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Enumerated the exported identifiers of package `tessera` at 4a6d9f9 by parsing the non-test files with `go/parser`: 37
    (8 `Default*` consts, 2 funcs and 6 types in `append_lifecycle.go`, 2 in `await.go`, 1 in `ct_only.go`, 2 in `entry.go`,
    3 types in `lifecycle.go`, `Driver` and 3 `ErrPushback*` in `log.go`, 4 in `migrate_lifecycle.go`, 5 in `witness.go`),
    exactly the ADR's list. `src/index.ts` re-exports all 37 under ADR-0002's names, plus the six additions the table
    justifies (`withCTLayout`, `AppendLifecycle`, `AppenderInit`, `NewAppenderResult`, `ErrNotExist`, `errorIs`) and nothing
    else; none of the test-only helpers it lists is exported.
  - `src/index_test.ts` passes (33 tests): the sorted list of runtime names written out in full (33 = 30 Go values plus the
    three runtime additions), `expectTypeOf` for the type-only names, one case per Go value, and the leak list. Two nits
    against the ADR's text: the leak list asserts `copier` and `bundle` where the ADR names `Copier` and `progress`
    (`progress` was deleted by ADR-0181), but the exact-set test would catch any leak anyway.
  - Challenge: `ErrNotExist` and `errorIs` at the root is the debatable part. The ADR records the subpath alternative and
    leaves it to the reviewer; I accept the root, since `ErrPushback`'s documentation sends readers to `errors.Is` and a
    personality handling `newAppender`'s futures needs both at that call site.
  - The two "future work" statements have since been done (`docs/PORTING-MAP.md` now has a row for `src/index.ts`, and
    `package.json` `exports` has every storage subpath); no change needed.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.

## Update (2026-10-04)

The Context names `Copier` and `progress` among the test-only identifiers. `progress` was deleted by ADR-0181, and
the leak test in `src/index_test.ts` asserts `copier` and `bundle` among its names, alongside the `copy*` helpers. The
exact-set test against Go's root exports catches any leak either way.

**Review of this update:** ADR reviewer (independent), 2026-10-04. Verdict: approved. `progress` is gone (`migrate_lifecycle.ts`'s header and
ADR-0181), and the leak test in `src/index_test.ts` ("does not export helpers that exist only for tests") lists `copyBytes`,
`copyUint16LengthPrefixed`, `copyUint24LengthPrefixed`, `newCopier`, `copier`, `bundle` and `populateWork` among its names and has neither
`Copier` nor `progress`, as the Update says. The class is `copier` (`src/migrate.ts`, lowercase as Go's unexported type), so the
Context's capitalised `Copier` names that type loosely. The exact-set test (the sorted list of runtime exports, written out in full) is what catches a
leak independent of the name list. I ran `index_test.ts`: 33 passed. This restates, in an Update, what the Review's nit already found, and adds nothing wrong.

## Update (2026-10-07): `errorAs` next to `errorIs`

The root barrel also exports `errorAs`, the stand-in for Go's `errors.As`, for the reason `errorIs` is there: Go's
API is specified in terms of `errors.Is` and `errors.As`, and errors that carry data (`ErrInconsistency` from
webtessera/client, `OldSizeMismatchError` from webtessera/witness) can only be found in a wrapped error with it.
The root module's documentation now says how to test for a sentinel and for an error class. ADR-0243 has the
decision; `index_test.ts` lists the export and exercises it.

**Review of this update:** DX reviewer (independent), 2026-10-07. Verdict: approved. `errorAs` is exported from `src/index.ts` next to `errorIs`; the exact export list in `index_test.ts` includes it and the new case exercises a class found through a wrapped chain; the module documentation section is accurate. Ran `index_test.ts`: passes.
