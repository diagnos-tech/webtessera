# ADR-0240: Use Bun as the package manager and script runner; keep Node for the tests and npm for publishing

- **Status:** proposed
- **Date:** 2026-10-03
- **Author:** Gustavo Simões
- **Upstream reference:** n/a (tooling; nothing in Tessera corresponds)

## Context

The project owner wants Bun, not pnpm, to be the default tool in the repository. This repository promises more than a
package manager does, though: the library supports Node 22 and 24 as well as Bun, Deno, browsers and workerd; its tests
run in Vitest's Chromium and workerd pools; and a release is published to npm with provenance, by a pipeline whose
guarantee is that the digest recorded when the tarball was packed is the digest of what the registry receives
(`docs/RELEASING.md`). "Bun in everything" therefore needs a line drawn between what Bun *manages and starts* and what
Bun *executes*. This ADR draws it, with the evidence, and records the problems the migration hit. Measured with Bun
1.3.14 and Node 22.22.0 on Linux x64.

## Decision

### What moved to Bun

- **Installing.** `bun install` with `bun.lock`; `"packageManager": "bun@1.3.14"`; `trustedDependencies` replaces
  pnpm's `onlyBuiltDependencies`; the workspace (`examples/*`, `site`) is the root `package.json`'s `workspaces`.
  `bun.lock` was migrated from `pnpm-lock.yaml`, so every resolved version is unchanged (a fresh resolve would have
  moved `@noble/hashes` and `@noble/curves` from 2.3.0 to 2.4.0, and the migration kept them).
- **Running scripts.** `bun run <script>`, `bun run --cwd <dir> <script>` for one workspace package, `bun run --filter
  <pattern> <script>` for several, `bunx` for one-off tools. `upstream`, `fixtures` and the Cloudflare example's
  `keygen` run their script on Bun, because they only orchestrate (git, `go run`, one call into `dist/`).
- **Packing.** `bun pm pack` makes the npm tarball in `_package.yml`, and, through `scripts/release/rescope.mjs`, the
  GitHub Packages variant.
- **CI.** `.github/actions/setup` installs Bun with `oven-sh/setup-bun` (the commit SHA of v2.2.0, the latest release,
  the same pin as in `_runtimes.yml`; the version is read from `packageManager`), caches Bun's install cache
  (`~/.bun/install/cache`, keyed on `bun.lock`, OS and CPU) with `actions/cache`, and runs `bun install
  --frozen-lockfile`. Dependabot uses its `bun` ecosystem; its `npm` one refuses a repository that has a `bun.lock`.
- **Hygiene.** `.githooks/pre-commit` (Biome `--staged`, `gofmt -l`), enabled by the root `prepare` script, which
  also links the library into the workspace (below); `.vscode/` settings; a Go job in `_quality.yml`; `biome.jsonc`.

### What stays on Node, and why

| What | Runs on | Evidence |
| --- | --- | --- |
| Unit tests (Vitest, `bun run test:unit`) | **Node** | Node: 98 files, 2985 tests pass (93 s). `bunx --bun vitest run` (Vitest and its workers on Bun): **7 files fail to load, 467 tests never run**, all with `No such built-in module: node:sqlite` (`sqlite_test`, `sqlite_golden_test`, `schema_test`, `lease_test`, `rqlite_test`, `sync_test`, `README_test`); 91 files, 2518 tests pass. `node:sqlite` is one of the engines the library supports and tests. |
| workerd tests (`bun run test:workers`) | **Node** | Node: 4 files, 245 tests pass (47 s). On Bun (`bunx --bun vitest run --config vitest.workers.config.ts`): no result after 10 minutes, with three idle workerd processes and `ws.WebSocket 'upgrade' event is not implemented in bun`. The run was stopped. |
| Chromium tests (`bun run test:browser`) | **Node** | Passes on both (5 files, 210 tests, 19 s). Not the reason; Node is what CI and the supported matrix use. |
| `interop`, `smoke-runtimes`, `smoke-sqlite` | Node | They verify what the built package does on Node (`node:sqlite`, fake-indexeddb, libSQL). CI runs the smoke tests on Node, Bun and Deno as a matrix already (`_runtimes.yml`). |
| `smoke-pack`, `scripts/release/*` | Node, npm | They stand in for, or are, an npm consumer and publisher. |
| Site `smoke` and `og` | Node | They drive Chromium through Playwright. They also pass on Bun 1.3.14, but Playwright supports Node, and the smoke test gates the Pages deployment. |

Consequences for how scripts are written: a package script that names a binary (`vitest`, `tsc`, `biome`, `vite`) runs
the binary's `#!/usr/bin/env node` line, so it executes on Node, and `bunfig.toml` sets `[run] bun = false` so that a
developer's own `~/.bunfig.toml` with `bun = true` cannot move Vitest onto Bun (verified: `bun = true` does).
Two traps are documented in `CONTRIBUTING.md` and `AGENTS.md` §3.9: **`bun test` is Bun's own runner**, not the
`test` script, and **Bun makes `node` mean Bun when no Node is on `PATH`**, which would run the suites on Bun without
a warning. (In this environment `bun run --bun` and `bun --bun` did not move a Node-shebang binary onto Bun while Node
was installed; `bunx --bun` and `[run] bun = true` did, so the experiments above use `bunx --bun`.)

### npm publishes

`bun publish` has no `--provenance` flag (its help lists none; tracked as oven-sh/bun#15601) and no OIDC exchange for
npm's trusted publishing (oven-sh/bun#22423, open). The release needs both, so `release.yml` and
`scripts/release/publish.mjs` stay on `npm publish --provenance`, in jobs that install Node and no Bun.

Packing is separable from uploading, so it moved to Bun after checking that nothing the pipeline guarantees depends on
which tool packed:

- `npm publish <tarball>` uploads the file as it is. For the Bun-packed tarball it reports the file's own `shasum`
  (3741eae0…) and `integrity`, so the SHA-256 that `_package.yml` records when it packs is the digest of what is
  published. `npm publish --dry-run` through `publish.mjs` passes on it.
- `bun pm pack` and `npm pack` select the same 443 files, each byte for byte identical, from the same tree. Their
  tarballs differ as files (Bun puts `package.json` first and gzips at level 9; npm lists files in directory order
  and compresses at its own level), so a digest taken from one is not the digest of the other. That does not matter: each tarball is
  checked, and published, as the very file that was packed. Bun's output is deterministic: packing the same
  tree twice gave the same SHA-256.
- `publint --strict`, Are the Types Wrong? (`--profile esm-only`) and `scripts/smoke-pack.mjs` run on the Bun-packed
  tarball as before. (`smoke-pack.mjs` currently reports two problems at the base commit, `dist/http/node.js` importing
  `node:http` and `dist/storage/sqlite/adapters/sync.js` importing `node:sqlite`; they are not caused by this change.)
- A new step in the `build` job asks `npm pack --dry-run --json` which files npm would pack from the checkout and fails
  on any difference from the Bun tarball, because `files` in `package.json` is written for npm's rules.
- `rescope.mjs` repacks with Bun, not npm. npm 10 runs a package's `prepare` script when it packs a *directory*, even
  with `--ignore-scripts` (it honours the flag for `prepack` only), and the packed `package.json` names
  `scripts/prepare.mjs`, which is not in the tarball: `npm pack` of the unpacked tarball failed with "Cannot find
  module". `bun pm pack --ignore-scripts` skips both.

### The linker: isolated, stated explicitly

Bun 1.3 chooses the linker from `configVersion` in `bun.lock`: new workspaces get `isolated`, older projects and
single-package projects `hoisted`. `bunfig.toml` sets `linker = "isolated"` anyway, for the reason and not only the
result: a tool that rewrites the lockfile can drop `configVersion` (Dependabot did, dependabot-core#13623, since
fixed), and an unstated choice cannot carry a rationale.

Isolated is kept because it works for everything and catches what hoisting hides. Every suite and script passes on it
(results below). In the isolated layout the workspace root cannot resolve `vite`, `esbuild` or `shiki`, and
`examples/browser` cannot resolve `shiki` (declared by `site` only) or `esbuild` (a transitive dependency of `vite`);
with `--linker hoisted` the root resolves all three. Isolated is also what pnpm gave. Bun keeps a fallback directory,
`node_modules/.bun/node_modules`, through which *dependencies* may resolve their own undeclared imports; the
workspace's code is not served by it. Hoisted was not run through every suite.

### The workspace root cannot be a workspace dependency

The examples and the site import `webtessera`, which is the repository root. pnpm resolved
`"webtessera": "workspace:*"` to the root; Bun 1.3.14 does not:

- `workspace:*` fails with `Workspace dependency "webtessera" not found`, and listing `"."` among the `workspaces`
  changes nothing (the root is never a member; oven-sh/bun#41653, an open pull request, calls linking the root
  through `workspaces` a bug to prevent);
- `workspace:.` and `workspace:../..` fail ("No matching version"); `link:../..` means `bun link`'s global registry,
  not a path; `file:../..` fails with `Could not find package.json for "file:.." dependency`, apparently because the
  path of a target that is the root itself normalises to nothing.

`scripts/prepare.mjs`, run by the root `prepare` script after `bun install`, therefore creates
`node_modules/webtessera` -> `..`: the link pnpm made for each package, one level up, found by every workspace package
through Node's walk up the tree, and followed through `exports` into `dist/`, which is what a consumer's `node_modules`
holds. Each of the three manifests declares `webtessera` as an optional peer dependency (`"*"`, `optional: true`) so
that the manifests, people and linters such as Biome's `noUndeclaredDependencies` see the dependency: Bun records the
peer in `bun.lock` and, like any optional peer, never installs it (checked with a package that does exist on the
registry), even once `webtessera` is published.

### The pnpm lockfile migration

`bun install` converts `pnpm-lock.yaml` automatically, but stops with `NonExistentWorkspaceDependency` on the three
`webtessera: link:../..` importer entries (oven-sh/bun#23026). The conversion was done once on a copy with those
entries removed, which also keeps every version, and the entries are what the optional peers above replace.

### `trustedDependencies`

`esbuild` and `workerd` stay, as the same packages were allowed under pnpm; `bun pm untrusted` lists nothing else. The
installs were compared with and without them: with an empty list the workerd suite (245 tests) and the Vite build of the
site still pass. The one visible difference is that workerd's install script replaces its 5.7 KB JavaScript shim with the
150 MB native binary (a hard link), which only saves starting Node to launch it; esbuild's script changes nothing
visible under Bun. They are kept for parity, not necessity; emptying the list would run no dependency script at all.

### Examples' `ci` scripts

`_examples.yml` ran `pnpm --filter "./examples/**" --if-present run ci`, but no example defined `ci` (and the glob did not
match `site`), so the job ran nothing. Each example now has one. `bun run --filter './examples/*' ci` (a path filter)
starts the scripts together, and they do not rebuild the library, so that two `tsc` runs cannot race on `dist/`.
Measured `bun --filter` behaviour: a package without the script is skipped silently; if *no* package has it, it fails
with `No packages matched the filter` (exit 1) unless `--if-present` is given, which turns that into a silent pass, so
the workflow omits it; one failing script makes the exit status non-zero (3 in the test). The root is never matched by
`--filter`, which is why the workspace packages build the library with `bun run --cwd <path to the root> build`.

### Formatting and lint baseline

Made in the same change, because the hook and the editor settings run through the package manager. Nothing changes what
Biome prints for existing files (`biome check .` is clean on the same files before and after).

- **`biome.jsonc`** replaces `biome.json`, so the configuration can carry its reasons. It formats and lints TypeScript,
  JavaScript, JSON, JSONC and CSS, and lints HTML. HTML is not formatted: in Biome 2.5.15 that formatter is
  experimental and opt-in, and enabling it would rewrite both pages (void elements lose their `/>`, text is re-wrapped).
  Go is formatted by gofmt (hook, editor and a `_quality.yml` job that also runs `go vet`); Markdown and YAML by nothing
  (`.editorconfig` covers them).
- **Rules adopted** are the ones that fire nowhere today and enforce an `AGENTS.md` rule: `noFloatingPromises`,
  `noMisusedPromises`, `usePromiseRejectErrors`, `useExhaustiveSwitchCases` (promises and unions);
  `useThrowOnlyError`, `useThrowNewError`, `useErrorMessage` (§3.6); `useImportExtensions` (§3.8);
  `noTemplateCurlyInString`, `noUnusedExpressions`, `noAccumulatingSpread`; and, for shipped code only (`src/` outside
  tests and `testing/`), `noNodejsModules`, `noProcessGlobal` and `noRestrictedGlobals` for `Buffer` (§7). Each was
  counted with `biome lint --only=<rule> .` and shown to fire on a probe file. They sit in their own commit so that it
  can be reverted if another change trips one.
- **Rules not adopted**, with their hits on the base commit: `useAwait` 143 and `noAwaitInLoops` 143 (async methods that
  implement a Promise-returning contract; sequential awaits are the port), `noBitwiseOperators` 329,
  `noUnsafeTypeAssertion` 366, `useErrorCause` 98, `useConsistentMethodSignatures` 96, `noExcessiveCognitiveComplexity` 37,
  `noShadow` 41 (closures that mirror Go's, such as `(b) =>` in the cryptobyte builders), `useMaxParams` 22,
  `noImportCycles` 2 (`compact/nodes.ts` and `range.ts`, one Go package split over two files), `useAwaitThenable` 7 (three
  are the intended `await null`), `noUnnecessaryConditions` 10 (flow analysis that cannot see an async mutation of
  `this.#closed`), `noBaseToString` 7, `useArraySortCompare` 6 (sorting strings), `noNestedPromises` 1 (`void x.then()`).
  Worth adopting after a few edits: `noUndeclaredDependencies` (2: the site imports `playwright`, which only the root
  declares), `noEvolvingTypes` (1) and `useNullishCoalescing` (2).

## Consequences

- Contributors need Bun *and* Node. The Bun version is the `packageManager` field and is bumped by hand (Dependabot
  does not track it); `.nvmrc` still says Node 22.
- `bun test`, `bun build` and `bun deploy`-style habits are traps; the docs say `bun run <script>`.
- The library root is linked into `node_modules` by a script, not declared as a dependency, because Bun cannot. If Bun
  later supports a workspace root as a dependency (or the library moves to `packages/webtessera`), the script, the
  optional peers and this section go away.
- The packed `package.json` still carries `workspaces`, `trustedDependencies`, `packageManager` and a `prepare` script
  that is not in the tarball. They are inert for consumers: installing the tarball with npm and with Bun ran no script.
  Installing a *registry* package never runs `prepare` in either tool; both run it for the root project, git
  dependencies, `pack` and `publish`.
- `prepare` writes the repository's shared git configuration (`core.hooksPath`), so in a repository with several
  worktrees the hook is on for all of them. It sets nothing when `core.hooksPath` is already set, in CI, outside the top
  level of a working tree, or without git.
- Two things could not be exercised here: a real GitHub Actions run (setup-bun, the cache, the new jobs; `actionlint`
  passes, without shellcheck), and Dependabot's behaviour for a `bun` ecosystem with `directories` that list the
  workspace members. If its first run is noisy, list only `/`.

## Alternatives considered

- **Stay on pnpm.** Rejected by the owner; this ADR keeps what pnpm gave (isolated `node_modules`, frozen installs, a
  lockfile that CI enforces).
- **Run Vitest on Bun's runtime** (`bunx --bun vitest`). Rejected on the evidence above: seven suites cannot load and
  the workerd pool never finishes, and it would stop testing the Node versions the project supports.
- **Hoisted linker.** Works, but lets undeclared imports resolve (demonstrated above), which is what a published
  library must not depend on.
- **`npm pack` for the tarballs.** Equivalent, and not simpler: the `prepare` behaviour above makes npm unusable for the
  repack in `rescope.mjs` unless the script were guarded or stubbed in the unpacked tree.
- **`bun publish`.** No provenance, no trusted publishing.
- **Move the library to `packages/webtessera`**, making `workspace:*` work the way Bun wants. The right shape in the end,
  but it renames every path in a repository whose `src/` is being edited by others; best done once, in a quiet moment.
- **Separate installs for each example** (`file:../..` from a non-workspace directory). Three more lockfiles, no
  `bun --filter`, and drifting versions of Vite, TypeScript and Vitest.
- **A `postinstall` script for the link.** It would run for every consumer of the package.
- **`workspaces` listing `"."`, or `link:`.** Do not work; see above.

## Review

- **Reviewer:** <reviewer name or GitHub handle; not the author>
- **Verdict:** <approved | changes requested | disputed>
- **Notes:** <what the reviewer checked: for example, re-run `bunx --bun vitest run`, `bun pm pack` against `npm pack --dry-run`,
  and the isolated/hoisted resolution probes>

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.
