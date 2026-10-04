# webtessera-site

The landing page of webtessera, published to GitHub Pages at
<https://diagnos-tech.github.io/webtessera/>. It is one static page whose content is generated from
this repository while it builds, so it cannot drift from the code: the entry points, their exports
and doc comments, the tested code samples, the safe API's guards, the compatibility evidence, the
porting status, the decision records, the examples, the CI jobs and the licence notices are all read
from source, and the receipt in the hero is one the library produced while the page was built.
JavaScript only adds the copy buttons, keeps the package-manager tabs in step and runs the live demo;
the page reads completely without it.

## Commands

From the repository root:

```sh
bun install
bun run --cwd site dev        # dev server; edits to the repository reload the page
bun run --cwd site build      # builds the library, then the page into site/dist
bun run --cwd site preview    # serves site/dist at http://localhost:4173/webtessera/
bun run --cwd site typecheck  # type-checks the generator, the demo and the scripts
bun run --cwd site smoke      # smoke-tests site/dist in Chromium (build first)
bun run --cwd site ci         # build + typecheck + smoke, as CI runs it (it uses --filter webtessera-site)
bun run --cwd site og         # regenerates public/og.png and the PNG icons
```

The smoke test and `og` drive Chromium through Playwright, a development dependency of the workspace
root. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a Chromium installed elsewhere.

## Publishing

`.github/workflows/pages.yml` builds the page on every push to `main` (and on demand from the Actions
tab), runs the same `ci` script, and deploys `site/dist` with GitHub's Pages actions. Pull requests
run the `ci` script through `ci.yml`, so a change that breaks the page fails its pull request.

**One-time setup**, by a repository admin: open **Settings → Pages**, and under **Build and
deployment** set **Source** to **GitHub Actions**. Nothing else is needed: the workflow creates the
`github-pages` environment on its first run. After the first deployment, it is worth submitting
`https://diagnos-tech.github.io/webtessera/sitemap.xml` in Google Search Console, since a project
site's `robots.txt` is not at the root of its host, where crawlers look for it.

The public URL defaults to the repository's Pages URL, derived from `repository` in the root
`package.json`. In CI it comes from `actions/configure-pages`, so a custom domain configured in the
Pages settings is picked up automatically. To build for another address, set `SITE_URL`
(`SITE_URL=https://example.org/ bun run --cwd site build`): the base path, canonical URL,
Open Graph tags, JSON-LD, sitemap and `robots.txt` follow it.

## What is generated, and from where

| On the page | Read from |
| --- | --- |
| Version, description, keywords, licence, Node requirement, dependency count | `package.json` |
| Install commands, one tab per package manager | `README.md`, "Install" |
| The hero's receipt and tile | a log opened with `webtessera/server` while the page builds: the receipt `append()` returned, checked again with `verifyReceipt`, and the key custody (`backend`, `extractable`) of the key that signed it |
| Safe API cards: where each entry point runs, what it holds, what it refuses, its guard | `README.md`'s safe API table, the "What it will not let you do" list in `src/server/index.ts` and `src/browser/index.ts`, and the export conditions of `./server` in `package.json` |
| Receipt failure reasons | `ReceiptError`'s `reason` type in `src/safe/receipt.ts` |
| Code samples (quick start, storage, full API) | the `// #region` blocks README.md embeds, read from their tested source files with the same extraction as `src/README_sync_test.ts`, shown with the import declarations of the same test file that the region uses; a region whose README copy differs is reported as a build warning, and the page shows the tested source |
| Entry points, their exports, kinds and one-line docs | the `exports` map and the TypeScript compiler (barrels resolved, doc comments read); entry points declared but not yet written are left out |
| Entry point descriptions and Go counterparts | `README.md`'s package table, the barrels' package comments, and the files' `Ported from` headers |
| Storage cards | the storage entry points and `README.md`'s driver table |
| SQLite engines: adapters, default locking, tested | `webtessera/storage/sqlite`'s exports, `README.md`'s engine table, and the driver's test files |
| The `ObjectStore` method list | `src/storage/objectstore/objectstore.ts` |
| Serve, witness, mirror and monitor cards | shown only when their entry points exist; the functions named on them are checked against the exports |
| Examples: title, pitch, runtimes, imports, guide, order | `examples/*/package.json` (description; runtimes from the `start:node`/`start:bun`/`start:deno` scripts, Vite and wrangler), each README's title, the imports in its code, `docs/guides/README.md`, and `README.md`'s examples table for the order |
| Golden fixtures, recorded log sizes | `fixtures/data/*.json` headers (the differential corpora left out) |
| Differential cases, corpora, replay runtimes | the record tables of `fixtures/data/differential_*.json`, and the `*differential*_test.ts` files |
| The golden-suite matrix (backend × runtime) | the test files that call `describeGoldenCompatibility` or `describeWebCryptoGolden`, classified by suffix and by the adapter they use |
| Interop backends | `scripts/interop/backends.mjs` |
| Test-parity allow-list size | `scripts/test-parity-allowlist.json` |
| Porting mosaic and counts, pinned commit | `docs/PORTING-MAP.md`, `scripts/upstream.json` |
| Decision record count and statuses | `docs/decisions/` |
| Security reviews and hardening list | ADRs that mention a security review (and their author lines), and the items of `CHANGELOG.md`'s "Security" list with the ADRs they cite |
| Tested runtimes, interop, parity and fixture checks, the CI board | `.github/workflows/*.yml` (job names expanded by their matrices) and the vitest configurations |
| Contributor commands and package manager | `CONTRIBUTING.md`'s command table, `package.json`'s `packageManager` |
| Footer licence and attributions | `LICENSE`, `NOTICE` (test-only material left out) |
| The concepts figure, the hero tile and the demo's static view | real webtessera logs created while the page builds, from the built package |

Curated, because no file states it: the headline and section copy, the explanation of transparency
logs, the step texts beside each tested snippet, the role descriptions, the locking explanation, the
security posture cards, the SQLite engine list (names, where each runs, and which adapter function
wraps it; whether it is tested and its default locking are generated), the runtime cards'
requirements, the subset of contributor commands shown, and the footer's link list. The test-parity
totals (Go tests ported and allow-listed) need Go and the upstream checkout, which the site's CI job
does not have, so the page states the rule and the allow-list size rather than a count.

## How it is built

- `index.html` has two placeholders that `src/plugin.ts` (a Vite plugin) fills with the rendered
  head and body, then emits `sitemap.xml` and `robots.txt` and inlines the stylesheet.
- `src/data/` has one extractor per source, `src/sections/` one renderer per section,
  `src/components/` the shared pieces (Shiki code blocks, icons, the Merkle tree SVG, the receipt
  card, the package-manager tabs).
- `src/shared/` is isomorphic: the signed note, tile mosaic and audit-path renderers, and the code
  that reads a log as a client does. The build uses it on the log it creates; the demo uses it on
  the log running in the visitor's tab, so the static page and the live demo render identically.
- `src/enhance.ts` is the only script every visitor loads (about 1.5 KiB gzipped). It loads
  `src/demo/` when the demo section approaches the viewport.
- `src/styles/` are plain CSS files with light and dark tokens; system fonts only, no third-party
  requests.
- `public/og.png`, `public/favicon.png` and `public/apple-touch-icon.png` are rendered by
  `scripts/og.ts` and committed. Rerun `bun run --cwd site og` after changing the design or the
  headline.
- `types/node.d.ts` declares the handful of Node APIs the build-time code uses, since the site has
  no `@types/node` of its own.
