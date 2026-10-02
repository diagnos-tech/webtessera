# ADR-0132: `TestForbiddenFunction` walks syntax trees from a Vite glob instead of grepping the file system

- **Status:** proposed
- **Date:** 2026-10-02
- **Author:** Gustavo Simões
- **Upstream reference:** `storage/storage_test.go` (`TestForbiddenFunction`)

## Context

Tessera lets a personality swap the entry bundle layout (`AppendOptions.WithCTLayout` selects the Static CT
API's `tile/data/...` instead of `tile/entries/...`). That only works if every storage implementation asks the
options for the path. A driver that calls `layout.EntriesPath` directly would write the wrong paths for a CT
log without any error. Upstream guards the rule with a test that walks the storage directory and fails if any
non-test file contains the string `layout.EntriesPath`:

```go
// The layout.EntriesPath function should never been called by storage implementations.
// They should use `tessera.AppendOptions.EntriesPath` instead.
func TestForbiddenFunction(t *testing.T) {
	rootDir := "."
	forbiddenName := "layout.EntriesPath"
	err := filepath.WalkDir(rootDir, func(path string, d os.DirEntry, err error) error {
		...
		if strings.Contains(string(content), forbiddenName) {
			t.Errorf("Found forbidden call %q in file %q", forbiddenName, path)
		}
```

Two things stop a literal port.

**There is no file system API.** Library code runs on the edge, so `node:fs` is out for it
([PORTING.md](../../PORTING.md) section 7). A test could in principle import Node built-ins, but the project has no
`@types/node` (`tsconfig.json` sets `types: []`), and adding it for one test would make Node's globals visible to
every file, hiding exactly the mistakes `types: []` exists to catch.

**A substring grep does not transfer.** Go can grep for `layout.EntriesPath` because every use is qualified by
the package name. TypeScript also allows `import { entriesPath } from "../api/layout/index.ts"`, after which the
call is a bare `entriesPath(...)`, an import can be renamed with `as`, and a namespace import can be aliased to
anything. None of those contains the string. Conversely, a grep flags comments and strings that merely explain
the rule, which is the opposite of what a guard test should do to the people who write that prose.

## Decision

`src/storage/storage_test.ts` obtains the source of every `.ts` file under `src/storage/` with Vite's
`import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true })`. Vitest runs on Vite, so this
is resolved at transform time and needs no runtime I/O. The project does not depend on `vite/client`, whose
ambient types declare `glob`, so the file declares the minimal `ImportMetaWithGlob` interface itself and casts
`import.meta` to it. Vite still recognises the call after type erasure.

Each implementation file is parsed with the `typescript` compiler API (already a dev dependency, so nothing is
added) and the tree is checked for three things:

1. a named import or re-export of `entriesPath` from a module whose specifier names `api/layout`, under any local
   alias;
2. a member access `entriesPath` on a namespace import of such a module, under any alias;
3. the literal `layout.entriesPath`, even where `layout` was not imported by name, which is what upstream matches.

`entriesPathForLogIndex` is forbidden alongside `entriesPath`. Go's substring match
`layout.EntriesPath` is also a prefix of `layout.EntriesPathForLogIndex`, and the wrapper hard-wires the same
tlog-tiles path, so it bypasses the options equally. Importing an identically named function from some other
module, a property or method called `entriesPath` (as `AppendOptions.entriesPath()` and
`MigrationOptions.internal.entriesPath` are), and comments or strings that mention the call are all allowed.

A file counts as an implementation unless it is a `*_test.ts` file or sits under a `testing/` directory. Go
skips only `_test.go`; these are the TypeScript equivalents, and `tsconfig.build.json` excludes both from the
published package, so neither can ship a driver.

The test first asserts that the walk reached `./internal/integrate.ts`, so that a glob that silently matches
nothing cannot pass vacuously.

Because this detector is more than one `strings.Contains`, it carries its own proof, 25 port additions beside the
ported test: 12 inline sources that must be flagged, 9 look-alikes that must not be, and a case
that appends a violation to the real text of `integrate.ts` as the glob delivers it, so that the pipeline is
exercised without ever adding a violating file to the tree.

## Consequences

- The test depends on Vite's `import.meta.glob`, so it runs only under `vitest.config.ts`. That is where it
  belongs: `vitest.browser.config.ts` and `vitest.workers.config.ts` select their own drivers' tests and do not
  include `src/storage/storage_test.ts`.
- Blind spots, shared with upstream's grep: dynamic `import()` of the module, and reaching `entriesPath` through a
  third module that re-exports it. Neither is a pattern worth building machinery for; a reviewer will see it.
- The `typescript` package is loaded by one more test file. It is already installed for the type checker.
- Driver authors get a precise message (`entriesPath imported from ../../api/layout/index.ts in file ./...`)
  instead of a bare file name.
- A new storage subdirectory is covered automatically. A helper that must legitimately call the layout function
  belongs under `testing/` or in a `_test.ts` file, not in an exemption list here.

## Alternatives considered

- **`node:fs` with a local `declare module "node:fs"`.** Rejected: it works around the type restriction rather
  than honouring it, and hand-written declarations of Node's API drift from the real one.
- **Add `@types/node`.** Rejected, as above: it changes what every file in the project can reference.
- **A literal substring grep over the globbed text, as Go does.** Rejected: it misses `import { entriesPath }`,
  which is the natural way to write the violation in TypeScript, and fails on comments.
- **A hand-written scanner (regular expressions plus a comment stripper).** Built first and discarded: it needs
  its own handling of string, template and regular-expression literals and is easy to derail, where the compiler
  parser already does that correctly.
- **A Biome lint rule.** Rejected: the rule is about a directory-scoped architectural constraint, upstream
  expresses it as a test, and a test is the artefact a reviewer comparing the two projects will look for.

## Review

- **Reviewer:** pending
- **Verdict:** pending
- **Notes:**

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
