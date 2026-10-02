# Contributing to webtessera

Thank you for helping. `webtessera` is a **faithful port** of
[Tessera](https://github.com/transparency-dev/tessera), a tile-based transparency log, to
TypeScript for browsers and Cloudflare Durable Objects. That shapes almost everything about how
contributions work here: the value of this repository is that a reviewer can put a TypeScript file
next to its Go original and see that they do the same thing. A change that is clever, idiomatic and
unfaithful is a bad change.

Please read [AGENTS.md](AGENTS.md) before writing code. It holds the rules; this file explains the
workflow around them. (`AGENTS.md` doubles as the instruction file for AI coding agents, and the
same rules apply to code they write.)

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through
[SECURITY.md](SECURITY.md), not the issue tracker.

## What to work on

- **Port work.** [`docs/PORTING-MAP.md`](docs/PORTING-MAP.md) lists every upstream Go file with its
  status. `not started` rows are open; comment on an issue (or open one) before starting so two
  people do not port the same file.
- **Storage drivers and examples.** The web drivers (AGENTS.md §8) are where this repository is new
  rather than translated. Bug reports with a failing test are especially welcome.
- **Bugs.** A discrepancy with Go's behaviour is a bug, and the best report includes the Go output.
- **Anything that adds API Tessera does not have** needs a discussion first. Open an issue; it will
  need an ADR (see [below](#architecture-decision-records)).

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | 20 or newer (`.nvmrc` says 22) | everything |
| pnpm | 10, pinned by the `packageManager` field | everything; `corepack enable` installs it |
| Go | 1.24 or newer | `pnpm fixtures` only |
| git | any recent version | `pnpm upstream`, `pnpm fixtures` |
| Chromium | any recent version | `pnpm test:browser` only |

For Chromium, run `pnpm exec playwright install chromium` once (add `--with-deps` on a fresh Linux
machine). If you already have a Chromium, point `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at it instead.

## Setup

```sh
git clone https://github.com/diagnos-tech/webtessera.git
cd webtessera
corepack enable        # once, so that the pinned pnpm is used
pnpm install
pnpm upstream          # optional until you need the Go source: see below
```

`pnpm upstream` clones Tessera into `.upstream/tessera` (gitignored) at the exact commit this port is
pinned to (`scripts/upstream.json`). That checkout is the specification: **read the Go file and its
test before you port anything**. It is also what the fixture generator runs against.

## Scripts

Run everything from the repository root.

| Script | What it does | When to run it |
| --- | --- | --- |
| `pnpm lint` | Biome: lint, format check, import order | Before every commit; CI fails on it |
| `pnpm lint:fix` | The same, applying every safe fix | When `lint` complains about formatting |
| `pnpm format` | Biome formatter only | Rarely; `lint:fix` covers it |
| `pnpm typecheck` | `tsc` for the Node/browser sources, then for the workerd sources | Before every commit |
| `pnpm test:unit` | Vitest on Node: nearly all tests | Constantly; this is the inner loop |
| `pnpm test:watch` | The same, in watch mode | While developing |
| `pnpm test:browser` | Vitest in real headless Chromium (`*_browser_test.ts`) | When you touch the IndexedDB driver or anything runtime-sensitive |
| `pnpm test:workers` | Vitest inside workerd (the Durable Object suite) | When you touch the Durable Object driver |
| `pnpm test` | unit, then workers, then browser | Before you open a pull request |
| `pnpm build` | `tsc` emits ESM and declarations to `dist/` | Before touching `package.json` exports; examples need it |
| `pnpm check` | `lint`, `typecheck`, `test`, `build` in sequence | The full pre-PR gate |
| `pnpm upstream` | Checks out Tessera at the pinned commit into `.upstream/tessera` | Once, and after the pin moves; idempotent |
| `pnpm fixtures` | Runs `pnpm upstream`, then regenerates `fixtures/data/` with the Go generator | When you add or change a generator case; see below |
| `pnpm clean` | Removes `dist/` | Rarely; `prepack` does it |

Run a single test file with `pnpm exec vitest run --config vitest.config.ts src/api/layout/paths_test.ts`,
or a single test with `-t "name"`.

## Tests

Tests sit next to the code they cover, and mirror upstream:

- **`*_test.ts`**, never `*.test.ts`. `paths_test.go` becomes `paths_test.ts`, with the same test
  names, the same table-driven cases and the same values, so the two suites can be diffed and
  grepped side by side. The convention is deliberate (AGENTS.md §3.1).
- **`*_fixtures_test.ts`** assert golden fixtures. They are separate from the Go-mirrored file so
  that file keeps diffing line-for-line against its Go original.
- **`*_browser_test.ts`** run in real Chromium under `pnpm test:browser`. Everything under
  `src/storage/durableobject/` runs in workerd under `pnpm test:workers`. Everything else runs on
  Node.
- **`testing/` directories** hold shared helpers (the `ObjectStore` conformance suite, the workerd
  test Worker). They are excluded from the published package.
- A test that was **skipped, weakened or deleted** to get a build green is a blocking review finding.
  If you cannot make a test pass, say so in the pull request.

## The fidelity rules, in brief

The full text, with the reasoning, is [AGENTS.md](AGENTS.md) §3; the summary:

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

For every file you port (AGENTS.md §4):

1. Read the Go source and its test file end to end (`pnpm upstream` puts them in
   `.upstream/tessera`).
2. **Port the test first**, run it, and watch it fail. A test that passes before the implementation
   exists is broken.
3. Port the implementation until it is green.
4. Anything that produces bytes (tiles, bundles, checkpoints, proofs, paths, notes) also gets a
   **golden fixture**: add a case to the Go generator in `fixtures/gen/`, run `pnpm fixtures`, and
   assert the resulting JSON from a `*_fixtures_test.ts`. The generator calls real Tessera and
   records what it returns; it never computes anything itself.
5. Update `docs/PORTING-MAP.md`: status, test counts, notes.
6. Write an ADR for every divergence and every upstream file you chose not to port.

Two rules about fixtures that are not negotiable:

- **Never edit `fixtures/data/` by hand**, and never change a fixture to make a TypeScript test pass.
  The fixture is right and the port is wrong. If you believe a fixture is wrong, say so in the pull
  request and fix the generator.
- **Regeneration must be reproducible.** After `pnpm fixtures`, `git status --porcelain fixtures/data`
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
   and the reviewer disagree, both positions are written into the ADR and the maintainers decide.

[`docs/README.md`](docs/README.md) explains how to read the existing ones, and
[`docs/REVIEW-PROTOCOL.md`](docs/REVIEW-PROTOCOL.md) is what reviewers check, in order.

## Commits and pull requests

- **[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).** `type(scope): summary`
  in the imperative, with a lowercase type from `feat`, `fix`, `docs`, `test`, `refactor`, `perf`,
  `build`, `ci`, `chore` or `style`. A useful scope is the area: `feat(storage): …`,
  `fix(note): …`, `test(merkle): …`. Mark a breaking change with `!` or a `BREAKING CHANGE:` footer.
- **Keep pull requests focused.** One upstream file or one coherent change at a time reads far better
  against its Go original than a sweep.
- **Fill in the pull request template.** Its checklist is the definition of done from
  AGENTS.md §10, including pasting the real `pnpm test:unit` summary line. State plainly what is
  incomplete; a precise partial report beats an overconfident one.
- **CI must be green.** The required check is `CI passed`. [Continuous integration](#continuous-integration)
  below lists what it covers and how to reproduce each part locally; `pnpm check` plus `pnpm fixtures`
  (if you touched the generator) reproduces most of it.

## Running the examples

The examples are pnpm workspace packages under `examples/` that depend on the library through
`workspace:*`. Their `dev`/`build`/`test` scripts build the library first.

```sh
# A transparency log in a browser tab, persisted in IndexedDB (Vite)
pnpm --filter webtessera-example-browser dev

# A log in a Cloudflare Durable Object
pnpm --filter webtessera-example-cloudflare-durable-object dev        # wrangler dev
pnpm --filter webtessera-example-cloudflare-durable-object typecheck
pnpm --filter webtessera-example-cloudflare-durable-object test       # in workerd
```

CI runs every example's `ci` script (`pnpm --filter "./examples/**" --if-present run ci`), so a new
example needs a `ci` script and no change to the workflows. Keep the examples working when you change
the public API.

## Continuous integration

[`ci.yml`](.github/workflows/ci.yml) runs for every pull request, in the merge queue and on every push
to `main`. It only wires together reusable workflows (the `.github/workflows/_*.yml` files) and ends
with one job, **`CI passed`**, which fails if any other job failed or was cancelled. Branch protection
requires that single check, so adding or renaming a job never needs a settings change.

| Workflow | What it checks | Reproduce locally |
| --- | --- | --- |
| `_quality.yml` | Biome, types, and the workflow files themselves (actionlint) | `pnpm lint`, `pnpm typecheck` |
| `_test.yml` | Unit tests on Node 22 and 24; the browser, workerd and services suites | `pnpm test:unit`, `pnpm test:browser`, `pnpm test:workers`, `pnpm test:services` |
| `_compat.yml` | Fixtures regenerate unchanged from the pinned Go source; Go and TypeScript read each other's logs | `pnpm fixtures`, `pnpm interop` |
| `_package.yml` | One job packs the tarball (and its GitHub Packages variant) from the lockfile; another tests it: smoke test, publint, Are the Types Wrong? | `pnpm pack`, then `node scripts/smoke-pack.mjs <tarball>` |
| `_runtimes.yml` | The built package on Node, Bun and Deno | `pnpm build`, then `node scripts/smoke-runtimes.mjs` (or `bun`, or `deno run --allow-read`) |
| `_examples.yml` | Every example's `ci` script | `pnpm --filter "./examples/**" --if-present run ci` |
| `_site.yml` | The landing page builds and passes its browser smoke test | `pnpm --filter webtessera-site run ci` |

`pnpm test:services` talks to an rqlite node and an S3-compatible server. CI starts them with Docker
Compose, and you can start the very same containers (Docker with Compose is the only requirement):

```sh
docker compose --file .github/actions/services/compose.yaml \
  --env-file .github/actions/services/services.env up --detach
set -a; . .github/actions/services/services.env; set +a
node .github/actions/services/create-bucket.mjs
pnpm test:services
```

When you change a workflow:

- Every job sets `timeout-minutes` and checks out with `persist-credentials: false`. Workflows default
  to `permissions: contents: read`; a job that needs more asks for exactly that.
- Third-party actions are pinned to a commit SHA, with the release in a trailing comment. Dependabot
  updates both; do not replace a SHA with a moving tag.
- A step that several jobs share belongs in a composite action under `.github/actions/`, not copied.
- Run [actionlint](https://github.com/rhysd/actionlint) before pushing (`actionlint` if installed, or
  `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12`). CI runs it too, but a workflow
  mistake otherwise only shows when that workflow runs.

## Changelog and releases

[`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add
a line under `## [Unreleased]` for any change a user of the package would notice (new or changed
exports, behaviour changes, fixes); internal refactors, test-only and documentation changes do not
need one.

Maintainers cut releases: a pull request renames `Unreleased` to the new version and date and bumps
`version` in `package.json`, and publishing a GitHub Release for the tag `vX.Y.Z` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml). It re-runs the whole CI, then, once a
reviewer approves the `release` environment, publishes the tested tarball to npm (`webtessera`) and to
GitHub Packages (`@diagnos-tech/webtessera`), with provenance. The step-by-step process, the one-time
setup and how to verify a release are in [`docs/RELEASING.md`](docs/RELEASING.md).

## Licensing of contributions

webtessera is licensed under [Apache-2.0](LICENSE). There is no CLA: by submitting a contribution you
agree that it is licensed under Apache-2.0 (section 5 of the License). New files carry the header in
AGENTS.md §9. If you bring in code from anywhere else, say where it came from in the pull request:
its licence text must go in [`LICENSES/`](LICENSES/) and an entry in [`NOTICE`](NOTICE), and code
derived from Go sources stays BSD-3-Clause rather than being relabelled.
