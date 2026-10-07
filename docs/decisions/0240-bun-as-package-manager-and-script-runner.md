# ADR-0240: Use Bun as the package manager and script runner; keep Node for the tests and npm for publishing

- **Status:** accepted
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

- **Reviewer:** ADR review agent (independent), 2026-10-04
- **Verdict:** changes requested
- **Notes:**
  - Reproduced with Bun 1.3.14 and Node 22.22 (the versions the ADR measured): `bun pm pack` and `npm pack` select the same files with identical bytes (527 files now, not 443; run in a scratch copy of `package.json`, `dist/` and the other packed files with `--ignore-scripts`, so that npm's `prepare` could not touch the repository), the tarballs differ as files, two `bun pm pack` runs give the same SHA-256, and `npm publish --dry-run ./<bun tarball>` reports that tarball's own SHA-1. `bun publish --help` lists no `--provenance`. `bun pm untrusted` finds nothing outside `trustedDependencies`. `bun run --filter` behaves as written (script-less packages skipped, "No packages matched the filter" with exit 1 when none has it, `--if-present` turns it into a pass, a failing script gives its exit status). Chromium passes under `bunx --bun` (8 files / 265 tests), workerd under `bunx --bun` printed `ws.WebSocket 'upgrade' event is not implemented in bun` and gave no result in 200 s (I stopped it there; the ADR ran 10 minutes), and the unit suite under `bunx --bun` fails to load 8 files with `No such built-in module: node:sqlite` plus the `detectRuntime` test that insists the suite runs on Node. Biome rules adopted in the ADR are all in `biome.jsonc`; `biome check .` (521 files) and both `tsc --noEmit` projects exit 0; `prepare.mjs`, `.githooks/pre-commit`, `_package.yml`, `_examples.yml` and the optional peer dependencies are as described.
  - REQUEST 1 (the evidence for the workspace-root workaround does not reproduce). The section "The workspace root cannot be a workspace dependency" says `workspace:.` and `workspace:../..` fail with "No matching version" and `file:../..` fails with `Could not find package.json for "file:.." dependency`. On Bun 1.3.14, in a minimal workspace and in a copy of this repository's tree and manifests, none of the three fails: `workspace:.` installs and makes `examples/<x>/node_modules/webtessera -> ..`, a link to the example itself; `workspace:../..` and `file:../..` install a hard-linked snapshot copy of the whole root (28 MB here) under `node_modules/.bun/webtessera@root`, which does not follow later changes to `dist/`. What did reproduce: `workspace:*` fails ("Workspace dependency ... not found" in the minimal case, "failed to resolve" in the copy), listing `"."` in `workspaces` changes nothing, and `link:../..` means the global `bun link` registry. The conclusion, a script-made symlink, still stands, but for a different reason (every path form either links the wrong directory or copies the root). Correct the text to what Bun does, or say under what conditions the quoted errors were seen.
  - REQUEST 2 (a statement that is false for the tree as it now is). "In the isolated layout the workspace root cannot resolve `vite`, `esbuild` or `shiki`": `esbuild` became a root devDependency in commit cfb1824 (the merge that followed this ADR; `server_test.ts` bundles with it) and resolves from the root; `vite` and `shiki` still do not. Add a dated update.
  - Smaller points: (a) "verified: `bun = true` does" move Vitest onto Bun: a project-level `[run] bun = true` does (I reproduced it with a stand-in binary), but I could not make a global `~/.bunfig.toml` (via `HOME` or `XDG_CONFIG_HOME`) take effect for `bun run` at all, so the case the sentence guards against was not reproduced; the project's `bun = false` is harmless either way. (b) Figures that have moved and are worth a dated line: unit suite 122 files / 3439 tests on Node today (ADR: 98 / 2985); "each of the three manifests" is now six examples and `site`; the 443-file tarball is 527. They are labelled as measurements, so I do not count them as errors.
  - Not verified: the GitHub issue and pull request numbers (oven-sh/bun #15601, #22423, #23026, #41653, dependabot-core #13623) and the `setup-bun` v2.2.0 SHA (the session has no GitHub API access); GitHub Actions and Dependabot behaviour; the runs with an empty `trustedDependencies` and with the hoisted linker; the Biome hit counts "on the base commit"; the pnpm lockfile conversion (`pnpm-lock.yaml` is gone).
  - Status stays `proposed` until Request 1 and 2 are answered.

> An ADR without a signed review is not in force. If author and reviewer disagree, record both
> positions here and escalate to the maintainers — do not silently settle it.

## Update (2026-10-04): what Bun does with a workspace-root dependency; figures

This answers the two requests and the smaller points of the Review above. The conclusion stands: the root is
linked by `scripts/prepare.mjs`. The evidence for it was wrong, and is corrected here.

- **The workspace-root evidence, re-run.** The section "The workspace root cannot be a workspace dependency" quotes
  errors that do not reproduce on Bun 1.3.14. The reviewer tried a minimal workspace and a copy of this repository's
  manifests, and this update repeated the minimal case. A root package and one example depended on it with each
  form in turn:
  - `workspace:*` fails (`failed to resolve`, or `Workspace dependency … not found`), and listing `"."` among the
    `workspaces` changes nothing, as the section says. `link:../..` names `bun link`'s global registry, not a path,
    as the section says.
  - `workspace:.` does not fail. It installs `examples/<x>/node_modules/<root> -> ..`, a link to the example itself,
    not to the root.
  - `workspace:../..` and `file:../..` do not fail either. They install a copy of the root under
    `node_modules/.bun/<root>@root/`, linked from the example. Its files are hard links to the files the root had at
    install time, so a file added later, such as a rebuilt `dist/`, does not appear in it.

  So none of the forms gives the example a live link to the root. That is the reason for the script-made
  `node_modules/webtessera -> ..` link, which follows `exports` into the current `dist/` as a consumer's install
  would. The quoted "No matching version" and `Could not find package.json` errors should be read as withdrawn.
- **esbuild now resolves from the root.** "In the isolated layout the workspace root cannot resolve `vite`,
  `esbuild` or `shiki`" was true when written. `esbuild` became a root devDependency in cfb1824 (`server_test.ts`
  bundles with it), and `require.resolve("esbuild")` from the root now succeeds. `vite` and `shiki` still do not
  resolve from the root.
- **Figures that have moved.** These were measured at the review:
  - the unit suite on Node: 122 files and 3,439 tests (the ADR says 98 files and 2,985 tests), and 123 files and
    3,480 tests after the other 2026-10-04 fixes;
  - the packed tarball: 527 files (the ADR says 443);
  - the workspace: six examples plus `site` (the ADR says "three manifests"). Each declares `webtessera` as an
    optional peer dependency.
- **A global `bunfig.toml`.** The Review could not make a global `~/.bunfig.toml` with `[run] bun = true` take
  effect for `bun run`, though a project-level one does. `bunfig.toml`'s `bun = false`, kept against the global
  case, is harmless if that case cannot arise. Its comment's claim that a personal setting "would silently move every
  such script onto Bun's runtime" is unverified on Bun 1.3.14.

*Review of this update: approved, ADR review agent (independent), 2026-10-04. See the Re-review below.*

## Re-review (2026-10-04)

- **Re-review:** ADR review agent (independent), 2026-10-04
- **Verdict:** approved
- **Notes:**
  - Both requests and the smaller points of the earlier Review are answered. I re-ran them on Bun 1.3.14 and Node 22.22.0.
  - Request 1, the workspace-root evidence. Reproduced in a minimal workspace, one dependency form at a time: `workspace:*` fails ("failed to resolve"); `workspace:.` installs `ex/x/node_modules/rootpkg -> ..`, a link to the example itself; `workspace:../..` and `file:../..` both install `node_modules/.bun/rootpkg@root/node_modules/rootpkg`, whose files are hard links to the root's (same inode, link count 2), and a `dist/b.js` added afterwards does not appear in it; `link:../..` fails ("failed to resolve"). So the quoted "No matching version" and `Could not find package.json` errors do not reproduce, the Update withdraws them, and its replacement (no form gives the example a live link to the root, hence the script-made `node_modules/webtessera -> ..`) is what I observed.
  - Request 2. `require.resolve("esbuild")` from the root now succeeds (`node_modules/.bun/esbuild@0.28.1`), `vite` and `shiki` do not; `package.json` carries `"esbuild": "0.28.1"` as a root devDependency, added in the merge cfb1824.
  - Figures. The full unit suite on Node at HEAD: 123 files, 3480 tests, all pass (I ran `bun run test:unit`). Six examples plus `site`, each declaring the optional peer `webtessera`: checked in the seven manifests. The tarball count I could not reproduce as 527: a clean `tsc -p tsconfig.build.json` into a scratch directory plus the `files` entries gives 523 files with `bun pm pack --dry-run`, while the working tree's `dist/` holds 8 stale `storage/durableobject/*` files from the removed backend, which gives 531; 527 presumably came from a dist with stale output. Non-blocking, since the Update labels these as measured at the review, but a clean build packs 523.
  - Global bunfig. Reproduced: `[run] bun = true` in a project `bunfig.toml` moves a `#!/usr/bin/env node` binary onto Bun; the same setting in `$HOME/.bunfig.toml` or under `XDG_CONFIG_HOME` does not; a project `bun = false` keeps Node. The Update's "unverified" is accurate; the `bunfig.toml` comment it refers to is unchanged and still makes the claim.
  - Not re-verified here, as in the earlier Review: the GitHub issue and pull request numbers, the `setup-bun` SHA, GitHub Actions and Dependabot behaviour, the hoisted-linker and empty-`trustedDependencies` runs.

## Update (2026-10-07): examples copied out of the repository

The fresh-eyes audit of the 0.1.0 tarball copied the notary and log-server examples out of the repository and
installed them with npm 10.9.4, Node.js 22's bundled npm: `npm install <tgz>` crashed (`Cannot read properties
of undefined (reading 'spec')`), and so did a plain `npm install` (`… (reading 'edgesOut')`). Once worked around,
both examples ran exactly as their READMEs say. The question was whether one declaration of `webtessera` in each
example's manifest can satisfy Bun inside this workspace and npm outside it. It cannot, on Bun 1.3.14 and npm 10
and 11; what was tried, in a minimal workspace whose root package is not on the registry (as `webtessera` is not
yet) and on copies of the real examples:

- **A real dependency, `"webtessera": "^0.1.0"`.** Bun resolves it against the registry: `GET …/webtessera - 404`,
  and the install fails. Once the package is published, Bun would install the registry copy into each example and
  shadow the link to the checkout, so the examples would test the last release instead of the code beside them.
- **The same with a root `overrides` or `resolutions` entry** (`file:.`, `link:.`). Bun installs
  `node_modules/.bun/webtessera@root/`, a hard-linked snapshot of the whole root taken at install time: a rebuilt
  `dist/` with new files does not appear in it.
- **A non-optional peer with `install.peer = false` in `bunfig.toml`.** Bun still resolves the peer, and fails on
  the 404.
- **The optional peer, with `"^0.1.0"` instead of `"*"`.** Bun is content (it never fetches an optional peer), but
  npm never installs an optional peer by itself, and npm 10 crashes when a declared optional peer is installed
  explicitly with `--legacy-peer-deps` (the `spec` crash above).
- **`.npmrc` with `legacy-peer-deps=true`** in each example, for the other crash. It leads to the `spec` crash
  whenever the optional peer is installed explicitly.

The `edgesOut` crash is npm 10's, with Vitest 4.1.11's peer set, and needs no webtessera at all: a project whose
only dependency is `vitest@4.1.11` crashes the same way; `--legacy-peer-deps` and npm 11 (11.21.0) install it.

**Decision.** The manifests keep the optional peer, which is what Bun's workspace needs, and every example's README
gains an "Outside this repository" section with the one change to make in a copy:

```sh
npm pkg delete peerDependencies peerDependenciesMeta && npm install --legacy-peer-deps webtessera@^0.1.0
```

with the reason for `--legacy-peer-deps`, the tarball alternative for unreleased builds, and, for the edge
example, the `file:../log-server` dependency that replaces its `workspace:*` one. Verified on copies outside the
repository, against a local registry serving the packed tarball as `webtessera@0.1.0`: notary with npm 10 (`ci`:
`tsc` and 10 tests pass; `node scripts/keygen.ts` and `npx webtessera keygen` run), log-server with npm 11 and the
tarball path (`ci`: 4 tests pass), edge with npm 10, the tarball and the log-server copy (`tsc` clean, 5 workerd
tests pass).

*Review of this update: pending.*
