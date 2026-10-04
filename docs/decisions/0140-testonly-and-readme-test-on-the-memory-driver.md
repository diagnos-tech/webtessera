# ADR-0140: Port `testonly/testlog.go` and `README_test.go` onto the memory driver, and check README.md in CI

- **Status:** accepted
- **Date:** 2026-10-02
- **Author:** lead maintainer
- **Upstream reference:** `testonly/testlog.go`, `README_test.go`, `README.md`

## Context

Both files were blocked until a storage driver existed (ADR-0058 for `README_test.go`; the
`testonly/testlog.go` row in `docs/PORTING-MAP.md` was `not started` for the same reason). Both
construct their log on the POSIX driver:

```go
root := t.TempDir()
driver, err := posix.New(t.Context(), posix.Config{Path: root})
```

```go
// #region construct_example
driver, _ := posix.New(ctx, posix.Config{Path: "/tmp/mylog"})
```

`storage/posix` is not ported (ADR-0001): browsers and edge runtimes have no filesystem. The memory
driver, `src/storage/memory`, built on the ObjectStore engine that ports `storage/posix`
(ADR-0100), is its counterpart.

`README_test.go` exists so that `README.md`'s snippets compile and run. Upstream syncs the two by
running `mdcode` by hand and leaves the check itself as a TODO:

```go
// TODO(al): We should probably add a presubmit test to check docs have
// actually been updated.
```

## Decision

1. **`src/testonly/testlog.ts`** ports `NewTestLog`/`TestLog` with the memory driver in place of a
   temporary POSIX directory. `TestLog.Root` (a path) becomes `TestLog.store` (the
   `MemoryObjectStore`); `t *testing.T` is dropped, so failures throw; `t.Context()` becomes the
   optional trailing signal; the `(*TestLog, shutdown)` pair becomes a named object (ADR-0031). It is
   published as `webtessera/testonly`, as upstream's `testonly` package is importable by
   personalities' tests. `src/testonly/fixtures.ts`, this repository's fixture loader, stays
   unexported.
2. **`src/README_test.ts`** ports both upstream tests and `createSigner` with the same `#region`
   markers (`common_imports`, `construct_example`, `use_appender_example`), the memory driver
   standing in for POSIX. It adds regions for what this port's README must show and upstream's
   README covers in prose or not at all: `create_signer_example`, `await_publication_example`,
   `verify_example` (client-side checkpoint and inclusion-proof verification over HTTP, served from a
   `MemoryObjectStore` through a stubbed `fetch`) and `indexeddb_example` (on `fake-indexeddb`).
   Every region runs as part of a test.
3. **`src/README_sync_test.ts`** is upstream's TODO: every fenced block in `README.md` tagged
   `file=<path> region=<name>` (mdcode's own syntax) must equal that region of that file, compared
   after dedenting and rendering tabs as two spaces. Besides `src/README_test.ts`, it may embed
   `examples/cloudflare-durable-object/src/index.ts`, whose code is type-checked and tested by the
   example's own suite. It also requires the three upstream regions to stay embedded.
4. So that the snippets can be written exactly as a user writes them (`from "webtessera"`,
   `from "webtessera/storage/memory"`), tests may import the package by its published name:
   `vitest.config.ts` derives aliases from `package.json` `exports` (dist/X.js → src/X.ts), and
   `tsconfig.json` mirrors them in `paths`. Library code must keep using relative imports.

## Consequences

- A README change that breaks a snippet, or a code change that silently outdates one, fails the
  unit suite. Upstream's process (regenerate with mdcode) still works on this repository's files.
- `tsconfig.json` `paths` duplicates the exports map. A new subpath must be added to both; the
  alias side is automatic, and an import through a missing `paths` entry fails type-checking.
- ADR-0058 is resolved: both upstream tests are ported, and `docs/PORTING-MAP.md` marks
  `README_test.go` and `testonly/testlog.go` done.

## Alternatives considered

- **Leave README snippets unchecked**, as upstream does today. Rejected: this README is the first
  thing outside users read, and its snippets span three drivers and the client.
- **Run `mdcode` in CI** to regenerate and diff. Rejected: it adds a Go tool to the TypeScript
  toolchain for a check that a few lines of TypeScript express directly.
- **Import from relative paths in `README_test.ts`** and rewrite specifiers when comparing.
  Rejected: the comparison would no longer be verbatim, which is the point of the check.

## Review

- **Reviewer:** ADR reviewer (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - `testonly/testlog.go` against `src/testonly/testlog.ts`: same key generation, signer and verifier, `opts.WithCheckpointSigner`,
    `NewAppender`; `Root` becomes `store`, `t.Fatalf` becomes a throw, `t.Context()` the optional signal, the pair a named
    object (ADR-0031). `webtessera/testonly` exports `newTestLog`, `TestLog`, `NewTestLogResult` and not the fixture loader.
    `README_test.go` against `src/README_test.ts`: both upstream tests and `createSigner` are kept with Go's names and
    regions (`common_imports`, `construct_example`, `use_appender_example`), memory driver for posix, plus the extra regions.
    `README_sync_test.ts` is upstream's TODO: it fails on a block naming a file it does not load, a missing region, a body that differs
    after dedent and tabs-as-two-spaces, and a README that lacks the three upstream regions. It does not pass vacuously
    (12 tagged blocks now). Run: `README_test.ts`, `README_sync_test.ts`, `testlog_test.ts` and the fixture-loader tests
    all pass (71 tests with `fetcher_test.ts`). The `paths` mirror in `tsconfig.json` equals the `package.json` exports
    map, and no library file imports the package by name (only doc comments).
  - Not blocking, stale since the examples were reorganised: Decision 3 says the sync test may embed
    `examples/cloudflare-durable-object/src/index.ts`. That directory no longer exists (`examples/` now holds `client-only`,
    `edge`, `log-server`, `monitor`, `notary`, `session-receipts`) and the test embeds only `src/README_test.ts`.
    ADR-0141's Update records the same reorganisation; this ADR deserves an Update line too.

## Update (2026-10-04)

Decision 3 says that `src/README_sync_test.ts` may embed `examples/cloudflare-durable-object/src/index.ts`. That
example no longer exists: `examples/` now holds `client-only`, `edge`, `log-server`, `monitor`, `notary` and
`session-receipts`, and the sync test embeds only `src/README_test.ts`.
