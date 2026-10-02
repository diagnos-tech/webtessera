# webtessera-site

The landing page of webtessera, published to GitHub Pages at
<https://diagnos-tech.github.io/webtessera/>. It is one static page whose content is generated from
this repository while it builds, so it cannot drift from the code: the entry points, their exports
and doc comments, the tested code samples, the porting status, the decision records, the golden
fixtures, the examples, the CI matrix and the licence notices are all read from source. JavaScript
only adds the copy buttons and the live demo; the page reads completely without it.

## Commands

From the repository root:

```sh
pnpm install
pnpm --filter webtessera-site dev        # dev server; edits to the repository reload the page
pnpm --filter webtessera-site build      # builds the library, then the page into site/dist
pnpm --filter webtessera-site preview    # serves site/dist at http://localhost:4173/webtessera/
pnpm --filter webtessera-site typecheck  # type-checks the generator, the demo and the scripts
pnpm --filter webtessera-site smoke      # smoke-tests site/dist in Chromium (build first)
pnpm --filter webtessera-site ci         # build + typecheck + smoke, as CI runs it
pnpm --filter webtessera-site og         # regenerates public/og.png and the PNG icons
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
(`SITE_URL=https://example.org/ pnpm --filter webtessera-site build`): the base path, canonical URL,
Open Graph tags, JSON-LD, sitemap and `robots.txt` follow it.

## What is generated, and from where

| On the page | Read from |
| --- | --- |
| Version, description, keywords, licence, Node requirement, dependency count | `package.json` |
| Install command and its alternatives | `README.md`, "Install" |
| Code samples (quick start, storage) | the `// #region` blocks README.md embeds, read from their tested source files with the same extraction as `src/README_sync_test.ts`; a region whose README copy differs is reported as a build warning, and the page shows the tested source |
| Entry points, their exports, kinds and one-line docs | the `exports` map and the TypeScript compiler (barrels resolved, doc comments read); entry points declared but not yet written are left out |
| Entry point descriptions and Go counterparts | `README.md`'s package table, the barrels' package comments, and the files' `Ported from` headers |
| Storage cards, SQLite adapters, tested engines | the storage entry points, `webtessera/storage/sqlite`'s exports and its test files |
| The `ObjectStore` method list | `src/storage/objectstore/objectstore.ts` |
| Roles (log, server, witness, mirror, monitor) | shown only when the entry points they need exist |
| Examples | `examples/*/package.json`, each README's title and first paragraph, and the imports in its code |
| Porting mosaic and counts, pinned commit | `docs/PORTING-MAP.md`, `scripts/upstream.json` |
| Decision record count and statuses | `docs/decisions/` |
| Golden fixtures, recorded log sizes | `fixtures/data/*.json` headers |
| Tested runtimes, interop and fixture checks | `.github/workflows/*.yml`, the vitest configurations, `*_golden*_test.ts` files |
| Footer licence and attributions | `LICENSE`, `NOTICE` |
| The hero checkpoint, tile, Merkle tree and the demo's static view | a real webtessera log created while the page builds, from the built package |

Curated, because no file states it: the headline and section copy, the explanation of transparency
logs, the role descriptions, the SQLite engine list (names, where each runs, and which adapter
function wraps it; whether it is tested is generated), the runtime cards' requirements, and the
footer's link list.

## How it is built

- `index.html` has two placeholders that `src/plugin.ts` (a Vite plugin) fills with the rendered
  head and body, then emits `sitemap.xml` and `robots.txt` and inlines the stylesheet.
- `src/data/` has one extractor per source, `src/sections/` one renderer per section,
  `src/components/` the shared pieces (Shiki code blocks, icons, the Merkle tree SVG).
- `src/shared/` is isomorphic: the signed note, tile mosaic and audit-path renderers, and the code
  that reads a log as a client does. The build uses it on the log it creates; the demo uses it on
  the log running in the visitor's tab, so the static page and the live demo render identically.
- `src/enhance.ts` is the only script every visitor loads (about 1.5 KiB gzipped). It loads
  `src/demo/` when the demo section approaches the viewport.
- `src/styles/` are plain CSS files with light and dark tokens; system fonts only, no third-party
  requests.
- `public/og.png`, `public/favicon.png` and `public/apple-touch-icon.png` are rendered by
  `scripts/og.ts` and committed. Rerun `pnpm --filter webtessera-site og` after changing the design.
- `types/node.d.ts` declares the handful of Node APIs the build-time code uses, since the site has
  no `@types/node` of its own.
