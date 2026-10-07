# Contributing to webtessera

`webtessera` is a **faithful port** of [Tessera](https://github.com/transparency-dev/tessera) to
TypeScript. Its value is that a reviewer can put a TypeScript file next to its Go original and see
that they do the same thing, so a change that is clever, idiomatic and unfaithful is a bad change.

Read [PORTING.md](PORTING.md) before you write code: it holds the rules, and this file covers the
workflow around them.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems
through [SECURITY.md](SECURITY.md), not the issue tracker.

## What to work on

- **Port work.** [`docs/PORTING-MAP.md`](docs/PORTING-MAP.md) lists every upstream Go file with its
  status; `not started` rows are open. Comment on an issue, or open one, before you start, so that two
  people do not port the same file.
- **Storage drivers and examples.** The web drivers (PORTING.md §8) are new code rather than
  translation. Bug reports with a failing test are especially welcome.
- **Bugs.** A discrepancy with Go's behavior is a bug; include the Go output in the report.
- **API that Tessera does not have** needs a discussion first: open an issue. It also needs an ADR
  (see [below](#architecture-decision-records)).

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Bun | 1.3, pinned by the `packageManager` field (currently 1.3.14) | installing, and running every script; [bun.com/docs/installation](https://bun.com/docs/installation) |
| Node.js | 22 or newer (`.nvmrc` says 22) | the test suites, and the release; it must be on your `PATH` (see [Bun and Node](#bun-and-node)) |
| Go | 1.24 or newer | `bun run fixtures` and `bun run interop` only |
| Docker | any recent version | `bun run test:services` only |
| git | any recent version | `bun run upstream`, `bun run fixtures` |
| Chromium | any recent version | `bun run test:browser` only |

For Chromium, run `bunx playwright install chromium` once (add `--with-deps` on a fresh Linux
machine), or point `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at a Chromium you already have.

## Setup

```sh
git clone https://github.com/diagnos-tech/webtessera.git
cd webtessera
bun install            # also links the library into the workspace and enables the pre-commit hook
bun run upstream       # optional until you need the Go source
```

`bun run upstream` clones Tessera into `.upstream/tessera` (gitignored) at the commit this port is
pinned to (`scripts/upstream.json`). That checkout is the specification, and the fixture generator
runs against it: **read the Go file and its test before you port anything**.

## Bun and Node

Bun installs the dependencies and runs every script (`bun run <script>`); it does not run the code
under test.
[ADR-0240](docs/decisions/0240-bun-as-package-manager-and-script-runner.md) has the reasoning and the
evidence.

- **Vitest runs on Node.** `bun run test:unit` starts Vitest on the Node on your `PATH`, as CI does
  (Node 22 and 24). Never run it on Bun's runtime (`bunx --bun vitest`): `node:sqlite` does not exist
  there, which fails seven suites, and the workerd pool never finishes. Check that `node --version`
  works: when Bun finds no Node, it makes `node` mean Bun.
- **Write `bun run test`, never `bun test`.** `bun test` is Bun's own test runner, which knows nothing
  about Vitest or the `*_test.ts` convention. Likewise `bun run build`, never `bun build`.
- **npm publishes.** A release is packed with Bun and uploaded with `npm publish --provenance`,
  because `bun publish` supports neither npm provenance nor trusted publishing
  ([`docs/RELEASING.md`](docs/RELEASING.md)). You never need npm to develop.
- **`bun install` also runs `prepare`** ([`scripts/prepare.mjs`](scripts/prepare.mjs)). It links the
  repository root into `node_modules/webtessera`, because the examples and the site import the library
  by name and Bun cannot link a workspace root into its own members, and, in a git checkout, it
  enables the pre-commit hook. After `bun install --ignore-scripts`, run `node scripts/prepare.mjs`
  yourself. Registry installs of the package never run `prepare`.

## Scripts

Run every script from the repository root.

| Script | What it does | When to run it |
| --- | --- | --- |
| `bun run lint` | Biome: lint, format check, import order, for TypeScript, JavaScript, JSON and CSS | Before every commit; the pre-commit hook and CI both run it |
| `bun run lint:fix` | The same, applying every safe fix | When `lint` complains about formatting |
| `bun run format` | Biome formatter only | Rarely; `lint:fix` covers it |
| `bun run typecheck` | `tsc` for the Node/browser sources, then for the workerd sources | Before every commit |
| `bun run test:unit` | Vitest on Node: nearly all tests | Constantly; this is the inner loop |
| `bun run test:watch` | The same, in watch mode | While developing |
| `bun run test:browser` | Vitest in real headless Chromium (`*_browser_test.ts`) | When you touch the IndexedDB driver or anything runtime-sensitive |
| `bun run test:workers` | Vitest inside workerd (`*_workers_test.ts`: the SQLite driver on D1 and Durable Objects) | When you touch the SQLite driver or anything runtime-sensitive |
| `bun run test:services` | Vitest against live rqlite and S3-compatible servers (`*_services_test.ts`) | When you touch the rqlite adapter or the S3 sink; see [Continuous integration](#continuous-integration) |
| `bun run test` | unit, then workers, then browser | Before you open a pull request |
| `bun run build` | `tsc` emits ESM and declarations to `dist/` | Before touching `package.json` exports; examples need it |
| `bun run check` | `lint`, `typecheck`, `test`, `build` in sequence | The full pre-PR gate |
| `bun run upstream` | Checks out Tessera at the pinned commit into `.upstream/tessera` | Once, and after the pin moves; idempotent |
| `bun run fixtures` | Runs `bun run upstream`, then regenerates `fixtures/data/` with the Go generator | When you add or change a generator case |
| `bun run interop` | Builds the package, then has Tessera's Go code verify and extend logs written by webtessera, and the other way round, on every Node backend | When you touch the storage engine, a backend or a wire format |
| `bun run smoke` | Builds the package and runs an end-to-end smoke test of `dist/`, the SQLite driver included | Before touching `package.json` exports |
| `bun run clean` | Removes `dist/` | Rarely; `prepack` does it |

To run one test file: `bunx vitest run --config vitest.config.ts src/api/layout/paths_test.ts`. Add
`-t "name"` to run one test.

### Formatting and the pre-commit hook

Biome formats and lints TypeScript, JavaScript, JSON and CSS ([`biome.jsonc`](biome.jsonc) says what
it covers and why); `gofmt` formats the Go in `fixtures/gen` and `interop`. Nothing formats Markdown
and YAML: [`.editorconfig`](.editorconfig) carries their conventions. The settings in
[`.vscode/`](.vscode) apply the same formatting on save, with the Biome extension.

[`.githooks/pre-commit`](.githooks/pre-commit) runs `biome check --staged` and `gofmt -l` on what you
are about to commit, and refuses a commit that CI would reject. It only checks; `bun run lint:fix`
and `gofmt -w <file>` repair what it reports. `git commit --no-verify` skips it for one commit, but
CI still checks. `bun install` leaves an existing `core.hooksPath` alone, and sets none in CI; to
enable the hook by hand, run `git config core.hooksPath .githooks`.

## Tests

Tests sit next to the code they cover, and mirror upstream:

- **`*_test.ts`**, never `*.test.ts`. `paths_test.go` becomes `paths_test.ts`, with the same test
  names, table-driven cases and values, so that the two suites can be diffed and grepped side by side
  (PORTING.md §3.1).
- **`*_fixtures_test.ts`** assert golden fixtures, separately, so that the Go-mirrored file keeps
  diffing line for line against its original.
- **`*_browser_test.ts`** run in real Chromium (`bun run test:browser`), **`*_workers_test.ts`** in
  workerd (`bun run test:workers`), and **`*_services_test.ts`** against live servers
  (`bun run test:services`). Everything else runs on Node.
- **`testing/` directories** hold shared helpers, such as the `ObjectStore` conformance suite and the
  workerd test Worker. They are excluded from the published package.
- A test **skipped, weakened or deleted** to get a build green is a blocking review finding. If you
  cannot make a test pass, say so in the pull request.

## The fidelity rules, in brief

[PORTING.md](PORTING.md) §3 has the full text and the reasoning.

1. **File and directory names are identical to Go**, snake_case included. Declarations keep Go's
   order.
2. **Identifiers map mechanically**: exported functions become camelCase, types and constants keep
   their Go spelling. Never rename beyond that.
3. **`uint64` is `bigint`**, always. Narrower integers are `number`. `[]byte` is `Uint8Array`, never
   `string` or `Buffer`.
4. **Errors are thrown with Go's exact message text**, and sentinels are matched with the helpers in
   `src/internal/gostd/errors.ts`. Merkle hashing and proofs stay synchronous.
5. **Upstream comments are specification.** Port them verbatim. Where the port diverges, add a
   `// Port note:` linking the ADR.
6. **Go stdlib stand-ins live in `src/internal/gostd/`.** Use them; do not write a private copy.
7. **Dependencies are `@noble/hashes` and `@noble/curves`, and nothing else.** No Node built-ins,
   no `Buffer`, no `process` in library code.
8. **No `any`, no `@ts-expect-error`, no `.skip`, no commented-out code, no `console.log`.**

## The workflow: TDD and golden fixtures

For every file you port (PORTING.md §4):

1. Read the Go source and its test file end to end, in `.upstream/tessera`.
2. **Port the test first**, run it, and watch it fail. A test that passes before the implementation
   exists is broken.
3. Port the implementation until it is green.
4. Anything that produces bytes (tiles, bundles, checkpoints, proofs, paths, notes) also gets a
   **golden fixture**: add a case to the Go generator in `fixtures/gen/`, run `bun run fixtures`, and
   assert the resulting JSON from a `*_fixtures_test.ts`. The generator calls real Tessera and
   records what it returns; it never computes anything itself.
5. Update `docs/PORTING-MAP.md`: status, test counts, notes.
6. Write an ADR for every divergence and every upstream file you chose not to port.

Two fixture rules are not negotiable:

- **Never edit `fixtures/data/` by hand**, and never change a fixture to make a TypeScript test pass.
  The fixture is right and the port is wrong. If you believe a fixture is wrong, say so in the pull
  request and fix the generator.
- **Regeneration must be reproducible.** After `bun run fixtures`, `git status --porcelain fixtures/data`
  must show only the changes you intended. CI regenerates the fixtures and fails on any difference.

[`fixtures/README.md`](fixtures/README.md) explains the corpus and how to audit it.

## Architecture decision records

Any divergence from Go, however small, any upstream file you do not port, any API Tessera does not
have, and any new dependency needs an ADR in [`docs/decisions/`](docs/decisions/):

1. Copy [`0000-template.md`](docs/decisions/0000-template.md) to `NNNN-kebab-title.md`, using the next
   unused number.
2. Fill in the context (quote the upstream code), the decision, the consequences and at least one
   alternative you rejected, with the reason.
3. Open it with the code it describes, or ahead of it if you want agreement first.
4. **A reviewer other than you signs the `## Review` section** before the ADR is in force. If you
   and the reviewer disagree, both positions go into the ADR and the maintainers decide.

[`docs/README.md`](docs/README.md) explains how to read the existing ADRs, and
[`docs/REVIEW-PROTOCOL.md`](docs/REVIEW-PROTOCOL.md) lists what reviewers check, in order.

## Commits and pull requests

- **[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).** `type(scope): summary`
  in the imperative, with a lowercase type from `feat`, `fix`, `docs`, `test`, `refactor`, `perf`,
  `build`, `ci`, `chore` or `style`. Use the area as the scope: `feat(storage): …`, `fix(note): …`,
  `test(merkle): …`. Mark a breaking change with `!` or a `BREAKING CHANGE:` footer.
- **Keep pull requests focused**: one upstream file or one coherent change at a time.
- **Fill in the pull request template.** Its checklist is the definition of done from PORTING.md §10,
  including the real `bun run test:unit` summary line. State plainly what is incomplete.
- **CI must be green.** The required check is `CI passed`. `bun run check`, plus `bun run fixtures`
  if you touched the generator, reproduces most of it; [Continuous integration](#continuous-integration)
  covers the rest.

## Running the examples

The examples are Bun workspace packages under `examples/`. They import the library by its package
name, which resolves to its built `dist/`, so build the library with `bun run build` first, and again
after you change it. Each example's README says how to run it on each runtime.

```sh
bun run build
bun run --cwd examples/client-only dev        # a browser's own log, in IndexedDB (Vite)
bun run --cwd examples/log-server start:node  # or start:bun, start:deno: the same server on each runtime
bun run --cwd examples/session-receipts ci    # any example's tests, as CI runs them
```

CI runs every example's `ci` script (`bun run --filter './examples/*' ci`), so a new example needs a
`ci` script and no change to the workflows. `bun run --filter` starts the scripts together, so a `ci`
script must not rebuild the library (that would race on `dist/`): run `bun run build` first. Keep the
examples working when you change the public API.

## Continuous integration

[`ci.yml`](.github/workflows/ci.yml) runs for every pull request, in the merge queue and on every push
to `main`. It wires together the reusable workflows (`.github/workflows/_*.yml`) and ends with one
job, **`CI passed`**, which fails if any other job failed or was cancelled. Branch protection requires
only that check, so adding or renaming a job never needs a settings change.

| Workflow | What it checks | Reproduce locally |
| --- | --- | --- |
| `_quality.yml` | Biome, types, Go formatting and `go vet`, and the workflow files themselves (actionlint) | `bun run lint`, `bun run typecheck`, `gofmt -l fixtures/gen interop` (must print nothing), `go vet ./...` in each Go module |
| `_test.yml` | Unit tests on Node 22 and 24; the browser, workerd and services suites | `bun run test:unit`, `bun run test:browser`, `bun run test:workers`, `bun run test:services` |
| `_compat.yml` | Fixtures regenerate unchanged from the pinned Go source; Go and TypeScript read each other's logs | `bun run fixtures`, `bun run interop` |
| `_package.yml` | One job packs the tarball (and its GitHub Packages variant) from the lockfile; another tests it: smoke test, publint, Are the Types Wrong? | `bun pm pack`, then `node scripts/smoke-pack.mjs <tarball>` |
| `_runtimes.yml` | The built package on Node, Bun and Deno | `bun run build`, then `node scripts/smoke-runtimes.mjs` (or `bun`, or `deno run --allow-read`) |
| `_examples.yml` | Every example's `ci` script | `bun run build`, then `bun run --filter './examples/*' ci` |
| `_site.yml` | The landing page builds and passes its browser smoke test | `bun run --filter webtessera-site ci` |

`bun run test:services` needs an rqlite node and an S3-compatible server. To start the containers CI
uses (Docker with Compose is the only requirement):

```sh
docker compose --file .github/actions/services/compose.yaml \
  --env-file .github/actions/services/services.env up --detach
set -a; . .github/actions/services/services.env; set +a
node .github/actions/services/create-bucket.mjs
bun run test:services
```

When you change a workflow:

- Every job sets `timeout-minutes` and checks out with `persist-credentials: false`. Workflows default
  to `permissions: contents: read`; a job that needs more asks for exactly that.
- Pin third-party actions to a commit SHA, with the release in a trailing comment. Dependabot updates
  both; do not replace a SHA with a moving tag.
- Put a step that several jobs share in a composite action under `.github/actions/`; do not copy it.
- Jobs install with `bun install --frozen-lockfile` (the `setup` action does), which fails when
  `bun.lock` disagrees with a `package.json`: commit the two together. The Bun version is the
  `packageManager` field; change it there and nowhere else. Tests run on Node, and publishing uses
  npm (see [Bun and Node](#bun-and-node)).
- Run [actionlint](https://github.com/rhysd/actionlint) before you push (`actionlint` if installed, or
  `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12`). CI runs it too, but otherwise a
  workflow mistake shows only when that workflow runs.

## Changelog and releases

[`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add
a line under `## [Unreleased]` for any change a user of the package would notice: new or changed
exports, behavior changes, fixes. Internal refactors, test-only and documentation changes need none.

Maintainers cut releases. A pull request renames `Unreleased` to the new version and date and bumps
`version` in `package.json`. Publishing a GitHub Release for the tag `vX.Y.Z` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which re-runs the whole CI and,
once a reviewer approves the `release` environment, publishes the tested tarball to npm
(`webtessera`) and to GitHub Packages (`@diagnos-tech/webtessera`), with provenance.
[`docs/RELEASING.md`](docs/RELEASING.md) has the step-by-step process, the one-time setup and how to
verify a release.

## Licensing of contributions

webtessera is licensed under [Apache-2.0](LICENSE). There is no CLA: by submitting a contribution you
agree that it is licensed under Apache-2.0 (section 5 of the License). New files carry the header in
PORTING.md §9. If you bring in code from anywhere else, say where it came from in the pull request:
its license text goes in [`LICENSES/`](LICENSES/) and an entry in [`NOTICE`](NOTICE), and code
derived from Go sources stays BSD-3-Clause rather than being relabeled.
